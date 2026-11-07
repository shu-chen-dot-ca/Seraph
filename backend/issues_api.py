"""The Issues page: remove rows, undo/redo, read one issue's thread, assign an issue to an agent, and refresh the facts.

Removing never takes out an issue an agent is working on (a job on it queued, working or waiting on the user), and
neither does an undo or redo (github_searcher/issue_list.py): its job has to be cancelled first.

Agents fill the list; the list reaches the browser through /api/live. The
thread is fetched from GitHub each time the user expands a row. Assigning goes
through Agents.assign, which makes a job for the issue and wakes the agent, so
that endpoint runs on the event loop (`async def`). An issue can be assigned only once it has a merge (see
issue_tags.py), and not when that is fixed (only needs closing), out of scope (not a pull request to that repo for its
own users, only seen on Windows, macOS or a phone, or it touches politics) or can't validate: a job we can't prove
ends with nothing to show.

The facts about each issue (age, last activity, assignees, linked PRs, ... see
github_searcher/issue_facts.py) are kept fresh by keep_facts(), which the app
runs in the background: new issues get theirs within FACTS_CHECK_SECONDS, and
all of them are fetched again every FACTS_REFRESH_SECONDS. Active issues (an agent
has a job on it: queued, working or waiting on the user) are fetched again every
ACTIVE_REFRESH_SECONDS, so a claim or a pull request by someone else shows within
a minute: a new comment changes the issue on GitHub, so keep_tags has Claude read it
again. Opening a row and the Refresh button fetch them at once.

Each issue's tags (free / assigned / waiting, its merge: likely or what stands in the way, its kind:
github_searcher/issue_tags.py) are made by keep_tags(), also in the background, except an issue in the Issues list
with none yet or none read since it was added: keep_new_tags() tags those on its own, from fresh (an issue tagged before
it came in, by Add issues or on the Tracked page, is read again, and the new tags show on every page), every
NEW_TAGS_SECONDS and again right after a failure, so a new one never waits behind keep_tags' long rounds or
TAGS_RETRY_SECONDS. Remove automatically decides on an issue only once it has those. keep_tags,
for the Issues list and the tracked repos' issues alike: new issues get theirs
within TAGS_CHECK_SECONDS, an issue that changed on GitHub gets them again, and
a free one every TAGS_FREE_SECONDS anyway (someone may have taken it), and a free one an agent is on (a job on it
queued, working or waiting on the user) every ACTIVE_TAGS_SECONDS (5 minutes), so a claim on it shows soon. The Tag
again buttons and the pages' Refresh (Issues: every open issue in the list, after
its facts; Tracked: every free issue, after the checks) do it at once
(refresh_tags), and say which ones that were free aren't anymore.

The robot button over the Dashboard's Issues board sets two things, kept in AUTO_REMOVE_FILE. How often the board's
issues are read again (keep_tags): refresh_open_minutes for ones no agent has started (30 at first), _catalog_ for ones
whose job waits in the queue (15), _ongoing_ for ones an agent works on or that wait on a review (5); finished ones
(job done) only when they change on GitHub. The tracked repos' issues keep TAGS_FREE_SECONDS. And Remove automatically,
which takes issues out of the Issues list by rules the user picks: claimed (someone is on it, or it is already fixed), out of scope,
complexity (easy, medium, hard), scope not clear, and opened more than older_than_days days ago (None: off). Only
issues no agent has started (no job on them, or only cancelled ones), so work in progress never goes. Saving applies
them at once; keep_tags applies them again after every round, so an issue that matches later goes then. Issues the
user moved to Catalog stay too. Each time
anything goes it is one undo step on the Issues page. One rule is always on, whatever the robot says: an issue of a repo
no longer in Repos, or archived there, goes from Open and Catalog alike (not one an agent has started). Deleting or
archiving a repo applies it at once (backend/repos_api.py).

Add in a repo's pop-up on the Dashboard's Repository page (add_to_catalog) puts any open issue of the repo at the end of
Catalog, whatever its tags say, even one taken off the board for good.

The same robot's max_agents is how many agents work on the board's issues at once: agents with a job queued or working
on an issue in the Issues list, or on a follow-up on a pull request. keep_catalog_agents() looks every
CATALOG_AGENTS_SECONDS, and while there is room it gives Catalog's cards to new agents from the top, first come first
served (the board's order; ones not placed yet after, in the order they were added), each to its own new agent with the
first free agent-N name and no target VM, so the agent picks the VM that suits the job itself (Agents.assign). Only
cards of repos whose Level of automation has Take issues on (backend/repo_automation_api.py; the others wait there for
you), and only cards that are Catalog's own: no job (or only cancelled ones), not paused, open on GitHub, and, like Assign, with its
Merge in and not fixed, out of scope or can't validate (the others wait there). A card taken leaves Catalog's list, so
its job keeps it on the board, and a job cancelled later sends it back to Open, not to the next agent.

The same robot's stale_pr_days (14 at first, None: off) closes PRs that stalled: an open PR of yours that an agent owns
(opened from its draft, never one you opened by hand) with no update on GitHub for that many days is made again by its
agent as a fresh PR, all its changes on the newest code with a clean history and every review point done
(Agents.remake_pr); once the new one is on GitHub the old one is closed (github_account.py). keep_stale_prs() looks
every STALE_CHECK_SECONDS. Once per PR: not while a job on it is open, and never again after its remake job.

When an issue goes from free to assigned either way, Agents.issue_taken tells the agent with a job on it who has it
(the assignees from its facts, or the tags' reason), and the agent decides itself whether to keep working or stop.
"""

import asyncio
import json
import re
import time
import traceback
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, issue_facts, issue_tags, issues, jobs, pr_tracking, repos, tracked, tracked_issues
from github_searcher.inbox import AUTOMATION_FILE
from github_searcher.issue_tags import CHECKS, DATA_DIR, NAME_VERSION, RULES_VERSION
from github_searcher.search import CACHE, get_thread
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")

FACTS_CHECK_SECONDS = 10
FACTS_REFRESH_SECONDS = 30 * 60
ACTIVE_REFRESH_SECONDS = 60
TAGS_CHECK_SECONDS = 10
TAGS_FREE_SECONDS = 60 * 60
# A free issue an agent is on: Claude reads it again this often, to see whether someone else took it.
ACTIVE_TAGS_SECONDS = 5 * 60
# An issue that could not be tagged (Claude or GitHub down, the issue gone) is tried again after this long.
TAGS_RETRY_SECONDS = 30 * 60
# An issue in the Issues list with no tags yet is tagged within this long (keep_new_tags), and tried again as soon.
NEW_TAGS_SECONDS = 5
# Remove automatically's rules; all off until saved once.
AUTO_REMOVE_FILE = DATA_DIR / "issue_auto_remove.json"
AUTO_REMOVE_OFF = {
    "claimed": False,
    "out_of_scope": False,
    "levels": [],
    "scope_not_clear": False,
    "older_than_days": None,
    "refresh_open_minutes": 30,
    "refresh_catalog_minutes": 15,
    "refresh_ongoing_minutes": 5,
    # Agents working on the board's issues at once, the next from the top of Catalog (keep_catalog_agents).
    "max_agents": 3,
    # An open PR an agent owns with no update on GitHub for this many days is made again fresh (keep_stale_prs); None: off.
    "stale_pr_days": 14,
}
# How often keep_catalog_agents looks for room for another agent on the board.
CATALOG_AGENTS_SECONDS = 30
# How often keep_stale_prs looks for PRs with no update for stale_pr_days.
STALE_CHECK_SECONDS = 10 * 60
LEVELS = ["easy", "medium", "hard"]


class AssignRequest(BaseModel):
    issue: str
    agent: str | None = None  # None: a new agent is made for it.
    vm: str | None = None  # None: the agent keeps its target VM.
    instructions: str = ""


class IdsRequest(BaseModel):
    ids: list[str]


class IssueIdRequest(BaseModel):
    id: str


class BoardRequest(BaseModel):
    catalog: list[str]
    order: list[str]
    held: list[str]


class CatalogRequest(BaseModel):
    repo: str
    number: int
    title: str
    labels: list[str]
    comments: int
    url: str


class AutoRemoveRequest(BaseModel):
    claimed: bool
    out_of_scope: bool
    levels: list[str]  # of LEVELS
    scope_not_clear: bool
    older_than_days: int | None  # None: off
    refresh_open_minutes: int
    refresh_catalog_minutes: int
    refresh_ongoing_minutes: int
    max_agents: int
    stale_pr_days: int | None = 14  # None: off


def auto_remove_issues() -> list[str]:
    """Take out of the Issues list what Remove automatically's rules pick, as one undo step; returns the ids taken out.
    Only issues no agent has started: no job on them, or only cancelled ones. Those of a repo no longer in Repos (or
    archived there) always go, Catalog's too, whatever the rules."""
    # Until saved once the rules are all off: only the repo rule takes anything.
    rules = dict(AUTO_REMOVE_OFF)
    if AUTO_REMOVE_FILE.is_file():
        rules.update(json.loads(AUTO_REMOVE_FILE.read_text()))
    tags = issue_tags.all()
    facts = issue_facts.all()
    started = [job["issue"] for job in jobs.list() if job["issue"] is not None and job["status"] != "cancelled"]
    catalog = issues.board()["catalog"]
    # By repo name in lower case: an issue's repo may be spelled its own way.
    archived = [name.lower() for name in repos.archived()]
    in_repos = [item["full_name"].lower() for item in repos.items() if item["full_name"].lower() not in archived]
    cutoff = None
    if rules["older_than_days"] is not None:
        cutoff = datetime.now(UTC) - timedelta(days=rules["older_than_days"])
    picked = []
    for item in issues.items():
        if item["id"] in started:
            continue
        if item["repo"].lower() not in in_repos:
            picked.append(item["id"])
            continue
        # The user's picks in Catalog stay.
        if item["id"] in catalog:
            continue
        # The rules decide on tags read since it was added; keep_new_tags reads it again first.
        tag = tags.get(item["id"])
        if tag is None or datetime.fromisoformat(tag["judged_at"]) < datetime.fromisoformat(item["added_at"]):
            continue
        opened = (facts.get(item["id"]) or {}).get("created_at")
        out_of_scope = tag.get("merge") == "out of scope"
        if rules["claimed"] and tag.get("status") in ("assigned", "fixed"):
            picked.append(item["id"])
        elif rules["out_of_scope"] and out_of_scope:
            picked.append(item["id"])
        elif not out_of_scope and tag.get("complexity") in rules["levels"]:
            picked.append(item["id"])
        elif rules["scope_not_clear"] and tag.get("scope_clear") is False:
            picked.append(item["id"])
        elif cutoff is not None and opened is not None and datetime.fromisoformat(opened) < cutoff:
            picked.append(item["id"])
    if not picked:
        return []
    return issues.remove(picked)["removed"]


@router.get("/issues/auto_remove")
def get_auto_remove() -> dict:
    rules = dict(AUTO_REMOVE_OFF)
    if AUTO_REMOVE_FILE.is_file():
        rules.update(json.loads(AUTO_REMOVE_FILE.read_text()))
    return rules


@router.put("/issues/auto_remove")
def put_auto_remove(body: AutoRemoveRequest) -> dict:
    """Keep the rules and apply them at once; returns them with the ids taken out now."""
    if any(level not in LEVELS for level in body.levels):
        raise HTTPException(status_code=400, detail="The levels are easy, medium and hard.")
    if body.older_than_days is not None and (body.older_than_days < 1 or body.older_than_days > 3650):
        raise HTTPException(status_code=400, detail="The days are 1 to 3650.")
    for minutes in [body.refresh_open_minutes, body.refresh_catalog_minutes, body.refresh_ongoing_minutes]:
        if minutes < 1 or minutes > 1440:
            raise HTTPException(status_code=400, detail="Refresh every 1 to 1440 minutes.")
    if body.max_agents < 1 or body.max_agents > 100:
        raise HTTPException(status_code=400, detail="Max agents is 1 to 100.")
    if body.stale_pr_days is not None and (body.stale_pr_days < 1 or body.stale_pr_days > 365):
        raise HTTPException(status_code=400, detail="Close inactive PRs after 1 to 365 days.")
    rules = body.model_dump()
    AUTO_REMOVE_FILE.write_text(json.dumps(rules, indent=2))
    return {**rules, "removed": auto_remove_issues()}


@router.post("/issues/remove")
def remove_issues(body: IdsRequest) -> dict:
    """Remove one or many issues (the page's multi-select) as one undo step. The ones an agent is working on stay:
    working lists them."""
    result = issues.remove(body.ids)
    if not result["removed"] and result["working"]:
        raise HTTPException(status_code=409, detail="An agent is working on them: cancel its job first.")
    if not result["removed"]:
        raise HTTPException(status_code=404, detail="None of them is in the list.")
    return result


@router.post("/issues/dismiss")
def dismiss_issues(body: IdsRequest) -> dict:
    """The × on a card of the Dashboard's Issues board: remove them, and no agent or bulk add brings them back
    (github_searcher/issue_list.py). One an agent is working on stays; working lists them."""
    return issues.dismiss(body.ids)


@router.post("/issues/delete")
def delete_issues(body: IdsRequest) -> dict:
    """Delete on a card's ⋯ on the Dashboard's Issues board, in any column: its open jobs are cancelled (their agents
    are told to stop, like Cancel on the Jobs page), then it is removed like the × (no agent or bulk add brings it back).
    Returns what dismiss returns."""
    for job in jobs.list():
        if job["issue"] in body.ids and job["status"] not in ("done", "cancelled"):
            jobs.add_timeline(job["id"], "status", "Stopped by you: its issue was deleted")
            jobs.update(job["id"], status="cancelled")
            agents.notify(job["agent"], f"The user deleted the issue {job['issue']}, so {job['id']} ({job['title']}) is cancelled. Stop working on it and go on with your other jobs.")
    return issues.dismiss(body.ids)


@router.post("/issues/board")
def set_board(body: BoardRequest) -> dict:
    """The Dashboard's Issues board after Add, Cancel, a drag, Pause or Resume: which issues are in Catalog, every card's
    order, and which are paused (held)."""
    issues.set_board(body.catalog, body.order, body.held)
    return {"ok": True}


@router.post("/issues/catalog")
def add_to_catalog(body: CatalogRequest) -> dict:
    """Add on an issue in a repo's pop-up on the Dashboard's Repository page: it goes to the end of Catalog, put in the
    Issues list first when it isn't there, whatever its tags say and even if it was taken off the board for good. Not one
    an agent has started (a job on it that isn't cancelled), nor one of a repo not in Repos or archived there."""
    archived = [name.lower() for name in repos.archived()]
    in_repos = [item["full_name"].lower() for item in repos.items() if item["full_name"].lower() not in archived]
    if body.repo.lower() not in in_repos:
        raise HTTPException(status_code=409, detail=f"{body.repo} isn't in Repos, or it is archived.")
    issue_id = f"{body.repo}#{body.number}"
    for job in jobs.list():
        if job["issue"] == issue_id and job["status"] != "cancelled":
            raise HTTPException(status_code=409, detail=f"An agent already started on {issue_id}.")

    item = {
        "id": issue_id,
        "repo": body.repo,
        "number": body.number,
        "title": body.title,
        "labels": body.labels,
        "state": "OPEN",
        "comments": body.comments,
        "html_url": body.url,
        "note": "",
        "added_by": "user",
        "added_at": datetime.now(UTC).isoformat(),
    }
    # One already in the list is skipped; it only moves.
    issues.add([item], allow_dismissed=True)
    board = issues.board()
    catalog = [each for each in board["catalog"] if each != issue_id] + [issue_id]
    order = [each for each in board["order"] if each != issue_id] + [issue_id]
    issues.set_board(catalog, order, board["held"])
    return {"added": issue_id}


@router.post("/issues/pause")
async def pause_issue(body: IssueIdRequest) -> dict:
    """Pause on the Dashboard's Issues board: the issue is held, and every open job for it is paused, its agent stopped
    when it is working on it (Agents.pause_job), until Resume."""
    board = issues.board()
    held = [issue_id for issue_id in board["held"] if issue_id != body.id] + [body.id]
    issues.set_board(board["catalog"], board["order"], held)
    for job in jobs.list():
        if job["issue"] == body.id and job["status"] in ("queued", "working", "waiting_on_user"):
            await agents.pause_job(job["id"])
    return {"ok": True}


@router.post("/issues/resume")
def resume_issue(body: IssueIdRequest) -> dict:
    """Resume on the board: the issue isn't held anymore, and its paused jobs go on (Agents.resume_job)."""
    board = issues.board()
    issues.set_board(board["catalog"], board["order"], [issue_id for issue_id in board["held"] if issue_id != body.id])
    for job in jobs.list():
        if job["issue"] == body.id and job["status"] == "paused":
            agents.resume_job(job["id"])
    return {"ok": True}


@router.post("/issues/restore")
def restore_issues(body: IdsRequest) -> dict:
    """Undo on the toast after a card's ×: put those issues back and take them off dismissed. Returns the ids put
    back (none for one removed before the backend last started)."""
    return {"restored": issues.restore(body.ids)}


@router.post("/issues/undo")
def undo_issues() -> dict:
    return {"changed": issues.undo()}


@router.post("/issues/redo")
def redo_issues() -> dict:
    return {"changed": issues.redo()}


@router.get("/issues/thread")
def issue_thread(id: str) -> dict:
    """The issue's text, labels and comments, in a simpler shape than GitHub's GraphQL answer."""
    match = re.fullmatch(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)", id)
    if match is None:
        raise HTTPException(status_code=400, detail="The issue must be owner/name#number.")
    owner, repo, number = match.group(1), match.group(2), int(match.group(3))
    # Fresh each time the user opens the issue, so new comments show up.
    CACHE.pop(("thread", owner, repo, number), None)
    try:
        thread = get_thread(owner, repo, number)
    except ValueError as error:
        # GraphQL errors, e.g. "Could not resolve to an issue or pull request with the number of 99999."
        raise HTTPException(status_code=404, detail=str(error))
    if thread is None:
        raise HTTPException(status_code=404, detail=f"{id} was not found.")
    # The user is looking at it: its facts (last activity, linked PRs, ...) get fresh too, when it is in the Issues
    # list (the Tracked page's pop-up shows issues that aren't).
    if f"{owner}/{repo}#{number}" in [item["id"] for item in issues.items()]:
        try:
            issue_facts.refresh(f"{owner}/{repo}#{number}")
        except Exception:
            pass  # Only the facts stay older; the thread itself came through.

    # Deleted GitHub accounts come back as author null; GitHub shows them as "ghost".
    author = "ghost"
    if thread["author"] is not None:
        author = thread["author"]["login"]
    comments = []
    for comment in thread["comments"]["nodes"]:
        comment_author = "ghost"
        if comment["author"] is not None:
            comment_author = comment["author"]["login"]
        comments.append({"author": comment_author, "at": comment["createdAt"], "body": comment["body"]})
    # Only issues ask for assignees (see THREAD_QUERY); a pull request has none here.
    assignees = []
    if "assignees" in thread:
        assignees = [user["login"] for user in thread["assignees"]["nodes"]]

    return {
        "title": thread["title"],
        "state": thread["state"],
        "author": author,
        "body": thread["body"],
        "labels": [label["name"] for label in thread["labels"]["nodes"]],
        "assignees": assignees,
        "comments": comments,
        # GitHub sends /issues/<n> on to /pull/<n> when it is a pull request.
        "html_url": f"https://github.com/{owner}/{repo}/issues/{number}",
    }


@router.post("/issues/assign")
async def assign_issue(body: AssignRequest) -> dict:
    """Makes a fix_issue job for the issue and gives it to an agent; returns the job."""
    if body.issue not in [item["id"] for item in issues.items()]:
        raise HTTPException(status_code=404, detail=f"{body.issue} is not in the Issues list.")
    tags = issue_tags.all().get(body.issue)
    if tags is None or tags.get("merge") is None:
        raise HTTPException(status_code=409, detail=f"{body.issue} is being tagged: it can be assigned once its Merge is in, in a minute.")
    if tags["merge"] in ("fixed", "out of scope", "can't validate"):
        raise HTTPException(status_code=409, detail=f"{body.issue}'s Merge is {tags['merge']}, so it can't be assigned.")
    try:
        return agents.assign(body.issue, body.agent, body.vm, body.instructions)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        # E.g. a different VM for an agent that is already queued for or holding its target VM.
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/tags/refresh")
async def refresh_tags(body: IdsRequest) -> dict:
    """Tag these issues again now (owner/name#n, any repos): the Tag again buttons and the pages' Refresh. Forced:
    Claude answers everything afresh, nothing kept from before. Many issues take a few minutes. taken: the ones that were
    free before and aren't now (claimed, a PR came, ...), for the page to say so.
    """
    before = issue_tags.all()
    tagged = await issue_tags.tag(body.ids, force=True)
    after = issue_tags.all()
    failed = [issue_id for issue_id in body.ids if issue_id not in tagged]
    taken = []
    for issue_id in tagged:
        if issue_id in before and before[issue_id]["status"] == "free" and after[issue_id]["status"] != "free":
            taken.append(issue_id)
        # Someone else is on it now: an agent working on it decides whether to go on.
        if issue_id in before and before[issue_id]["status"] == "free" and after[issue_id]["status"] == "assigned":
            facts = issue_facts.all().get(issue_id)
            assignees = facts["assignees"] if facts else []
            agents.issue_taken(issue_id, after[issue_id]["reason"], assignees)
    return {"tagged": len(tagged), "failed": failed, "taken": taken}


@router.post("/issues/refresh")
async def refresh_facts() -> dict:
    """Fetch the facts of every issue in the list from GitHub now. Takes a few seconds."""
    ids = [item["id"] for item in issues.items()]
    issue_facts.forget(ids)
    # The thread pool runs a handful at a time, so GitHub isn't flooded.
    results = await asyncio.gather(*[asyncio.to_thread(issue_facts.refresh, issue_id) for issue_id in ids], return_exceptions=True)
    failed = [issue_id for issue_id, result in zip(ids, results) if isinstance(result, Exception)]
    return {"refreshed": len(ids) - len(failed), "failed": failed}


async def keep_facts() -> None:
    """Runs as long as the backend: fetches facts for issues that have none, for active ones every minute, and for
    all of them now and then.

    An issue that fails (GitHub down, the issue deleted or moved) is left alone until the next full round, unless it
    is active.
    """
    last_full = None
    last_active = time.monotonic()
    failed = []
    while True:
        ids = [item["id"] for item in issues.items()]
        known = issue_facts.all()
        todo = []
        if last_full is None or time.monotonic() - last_full > FACTS_REFRESH_SECONDS:
            last_full = time.monotonic()
            failed = []
            issue_facts.forget(ids)
            todo = ids
        else:
            todo = [issue_id for issue_id in ids if issue_id not in known and issue_id not in failed]
            # The issues an agent is on now, every ACTIVE_REFRESH_SECONDS.
            if time.monotonic() - last_active > ACTIVE_REFRESH_SECONDS:
                last_active = time.monotonic()
                for job in jobs.list():
                    if job["status"] not in ("queued", "working", "waiting_on_user", "waiting_on_maintainers"):
                        continue
                    if job["issue"] in ids and job["issue"] not in todo:
                        todo.append(job["issue"])
        for issue_id in todo:
            try:
                await asyncio.to_thread(issue_facts.refresh, issue_id)
            except Exception:
                failed.append(issue_id)
        await asyncio.sleep(FACTS_CHECK_SECONDS)


async def keep_new_tags() -> None:
    """Runs as long as the backend: tags the Issues list's issues that have no tags yet or none read since they were
    added, at once and from fresh, apart from keep_tags: one tagged before it came in (by Add issues, on the Tracked page,
    ...) is read again, and its new tags are the ones every page shows. Then Remove automatically's rules decide on them.
    A failed one is tried again on the next round instead of waiting TAGS_RETRY_SECONDS."""
    while True:
        known = issue_tags.all()
        todo = []
        for item in issues.items():
            tag = known.get(item["id"])
            if tag is None or datetime.fromisoformat(tag["judged_at"]) < datetime.fromisoformat(item["added_at"]):
                todo.append(item["id"])
        if todo:
            # Forced: nothing from before is kept. A batch that fails leaves its issues as they were: the next round
            # tries them again.
            try:
                await issue_tags.tag(todo, force=True)
            except Exception:
                pass
            try:
                auto_remove_issues()
            except Exception:
                pass
        await asyncio.sleep(NEW_TAGS_SECONDS)


async def keep_tags() -> None:
    """Runs as long as the backend: tags every issue that has no tags yet, changed on GitHub since, was free an hour ago
    (5 minutes ago when an agent is on it), or is from before merge, one of its checks, complexity, the naming rules (issue_tags.NAME_VERSION) or the status
    rules (issue_tags.RULES_VERSION).

    Those are the Issues list's issues, then the tracked repos' open issues nobody is assigned to (the page
    shows an assigned one as assigned without asking), newest first. issue_tags.tag batches them.
    """
    failed = []
    failed_since = time.monotonic()
    while True:
        if time.monotonic() - failed_since > TAGS_RETRY_SECONDS:
            failed = []
            failed_since = time.monotonic()
        known = issue_tags.all()
        facts = issue_facts.all()
        checks = tracked_issues.all()
        # The board's refresh intervals (the robot button over it).
        rules = dict(AUTO_REMOVE_OFF)
        if AUTO_REMOVE_FILE.is_file():
            rules.update(json.loads(AUTO_REMOVE_FILE.read_text()))
        listed = [item["id"] for item in issues.items()]
        added_at = {item["id"]: item["added_at"] for item in issues.items()}
        catalog = issues.board()["catalog"]
        latest = {}
        for job in jobs.list():
            if job["issue"] is not None and (job["issue"] not in latest or job["created_at"] > latest[job["issue"]]["created_at"]):
                latest[job["issue"]] = job
        # Each issue and its last change on GitHub (None when not known yet).
        candidates = []
        for item in issues.items():
            updated_at = None
            if item["id"] in facts:
                updated_at = facts[item["id"]]["updated_at"]
            candidates.append((item["id"], updated_at))
        for item in tracked.items():
            check = checks.get(item["full_name"])
            if check is None:
                continue
            for issue in check["issues"]:
                if issue["assignees"] == 0:
                    candidates.append((f"{item['full_name']}#{issue['number']}", issue.get("updated_at")))

        # A free one is looked at again after TAGS_FREE_SECONDS: someone may have claimed it without GitHub showing a change.
        # One an agent is on (a job queued, working or waiting on the user) after ACTIVE_TAGS_SECONDS.
        free_before = datetime.now(UTC) - timedelta(seconds=TAGS_FREE_SECONDS)
        active_before = datetime.now(UTC) - timedelta(seconds=ACTIVE_TAGS_SECONDS)
        active = [job["issue"] for job in jobs.list() if job["status"] in ("queued", "working", "waiting_on_user", "waiting_on_maintainers")]
        todo = []
        for issue_id, updated_at in candidates:
            tags = known.get(issue_id)
            if issue_id in failed or issue_id in todo:
                continue
            # Where it is on the board: open (no job, or only cancelled), catalog (queued, or moved there), ongoing, or
            # finished (done).
            job = latest.get(issue_id)
            minutes = rules["refresh_open_minutes"]
            if issue_id in catalog or (job is not None and job["status"] == "queued"):
                minutes = rules["refresh_catalog_minutes"]
            if job is not None and job["status"] in ("working", "waiting_on_user", "waiting_on_maintainers"):
                minutes = rules["refresh_ongoing_minutes"]
            due = issue_id in listed and not (job is not None and job["status"] == "done")
            if tags is None and issue_id in listed:
                # keep_new_tags tags it, at once.
                continue
            if issue_id in listed and datetime.fromisoformat(tags["judged_at"]) < datetime.fromisoformat(added_at[issue_id]):
                # Not read since it was added: keep_new_tags reads it again, at once.
                continue
            if tags is None:
                todo.append(issue_id)
            elif updated_at is not None and tags["updated_at"] != updated_at:
                todo.append(issue_id)
            elif due and datetime.fromisoformat(tags["judged_at"]) < datetime.now(UTC) - timedelta(minutes=minutes):
                # In the Issues list: read again at the board's refresh interval for where it is.
                todo.append(issue_id)
            elif issue_id not in listed and tags["status"] == "free" and datetime.fromisoformat(tags["judged_at"]) < free_before:
                todo.append(issue_id)
            elif issue_id not in listed and tags["status"] == "free" and issue_id in active and datetime.fromisoformat(tags["judged_at"]) < active_before:
                todo.append(issue_id)
            elif "merge" not in tags:
                # From before merge (it had a level: easy, medium or hard): once more, by the merge rules.
                todo.append(issue_id)
            elif tags["checks"] is not None and any(key not in tags["checks"] for key, question in CHECKS):
                # From before one of the checks (issue_tags.CHECKS) was added: once more, for it.
                todo.append(issue_id)
            elif tags["checks"] is not None and ("complexity" not in tags or tags.get("name_version") != NAME_VERSION):
                # From before complexity and scope, or named by older naming rules: once more, for them.
                todo.append(issue_id)
            elif tags.get("rules_version") != RULES_VERSION:
                # Read by older status rules (the user's own claims counted): once more.
                todo.append(issue_id)

        if todo:
            tagged = await issue_tags.tag(todo)
            # Someone else is on it now: an agent working on it decides whether to go on.
            after = issue_tags.all()
            for issue_id in tagged:
                if issue_id in known and known[issue_id]["status"] == "free" and after[issue_id]["status"] == "assigned":
                    facts = issue_facts.all().get(issue_id)
                    assignees = facts["assignees"] if facts else []
                    agents.issue_taken(issue_id, after[issue_id]["reason"], assignees)
            # What didn't get tagged (GitHub or Claude failed, Claude left it out, it is gone) waits for TAGS_RETRY_SECONDS.
            for issue_id in todo:
                if issue_id not in tagged:
                    failed.append(issue_id)
        # New tags and facts may match Remove automatically's rules now. A failure there mustn't stop the tagging.
        try:
            auto_remove_issues()
        except Exception:
            pass
        await asyncio.sleep(TAGS_CHECK_SECONDS)


async def keep_catalog_agents() -> None:
    """Runs as long as the backend: gives Catalog's cards to new agents from the top while fewer than max_agents work on
    the board's issues (see the top of this file)."""
    while True:
        try:
            take_from_catalog()
        except Exception:
            # A file or an agent failed: the next round tries again.
            traceback.print_exc()
        await asyncio.sleep(CATALOG_AGENTS_SECONDS)


def take_from_catalog() -> None:
    rules = dict(AUTO_REMOVE_OFF)
    if AUTO_REMOVE_FILE.is_file():
        rules.update(json.loads(AUTO_REMOVE_FILE.read_text()))
    items = issues.items()
    ids = [item["id"] for item in items]
    all_jobs = jobs.list()

    # The agents working on the board's issues now.
    working = []
    for job in all_jobs:
        if job["status"] not in ("queued", "working"):
            continue
        if (job["issue"] in ids or job["thread"] is not None) and job["agent"] not in working:
            working.append(job["agent"])
    room = rules["max_agents"] - len(working)
    if room <= 0:
        return

    # Each issue's latest job: Catalog's own cards have none, or a cancelled one.
    latest = {}
    for job in all_jobs:
        if job["issue"] is not None and (job["issue"] not in latest or job["created_at"] > latest[job["issue"]]["created_at"]):
            latest[job["issue"]] = job
    board = issues.board()
    facts = issue_facts.all()
    tags = issue_tags.all()
    # The repos agents take issues of (their Level of automation: Take issues), in lower case.
    settings = {}
    if AUTOMATION_FILE.is_file():
        settings = json.loads(AUTOMATION_FILE.read_text())
    taking = [repo.lower() for repo, each in settings.items() if each.get("take_issues")]
    waiting = []
    for item in items:
        if item["id"] not in board["catalog"] or item["id"] in board["held"] or item["repo"].lower() not in taking:
            continue
        if item["id"] in latest and latest[item["id"]]["status"] != "cancelled":
            continue
        fact = facts.get(item["id"])
        state = fact["state"] if fact else item["state"]
        if state == "CLOSED":
            continue
        # Like Assign (assign_issue): once its Merge is in, and not when that says it can't be done.
        tag = tags.get(item["id"])
        if tag is None or tag.get("merge") in (None, "fixed", "out of scope", "can't validate"):
            continue
        waiting.append(item["id"])
    # From the top: the board's order, ones not placed yet after (sorted keeps them in the order they were added).
    waiting.sort(key=lambda issue_id: board["order"].index(issue_id) if issue_id in board["order"] else len(board["order"]))

    for issue_id in waiting[:room]:
        agents.assign(issue_id, None, None)
        board = issues.board()
        issues.set_board([each for each in board["catalog"] if each != issue_id], board["order"], board["held"])


async def keep_stale_prs() -> None:
    """Runs as long as the backend: has the PRs that stalled made again fresh (see the top of this file)."""
    while True:
        try:
            remake_stale_prs()
        except Exception:
            # A file or an agent failed: the next round tries again.
            traceback.print_exc()
        await asyncio.sleep(STALE_CHECK_SECONDS)


def remake_stale_prs() -> None:
    rules = dict(AUTO_REMOVE_OFF)
    if AUTO_REMOVE_FILE.is_file():
        rules.update(json.loads(AUTO_REMOVE_FILE.read_text()))
    if rules["stale_pr_days"] is None:
        return
    # GitHub's own format, so it compares as text with the PRs' updated_at.
    cutoff = (datetime.now(UTC) - timedelta(days=rules["stale_pr_days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    all_jobs = jobs.list()
    for pr in pr_tracking.summary()["items"]:
        # Only an open PR of yours an agent owns: never one you opened by hand.
        if pr["relation"] != "author" or pr["state"] != "open" or pr["agent"] is None or pr["draft_id"] is None:
            continue
        if pr["updated_at"] > cutoff:
            continue
        # Once: not while a job on it is open, and never again after its remake job.
        taken = False
        for job in all_jobs:
            if job["thread"] == pr["id"] and (job["kind"] == "fix_issue" or job["status"] in ["queued", "working", "waiting_on_user"]):
                taken = True
        if not taken:
            agents.remake_pr(pr, rules["stale_pr_days"])
