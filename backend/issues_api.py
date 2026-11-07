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
github_searcher/issue_tags.py) are made by keep_tags(), also in the background,
for the Issues list and the tracked repos' issues alike: new issues get theirs
within TAGS_CHECK_SECONDS, an issue that changed on GitHub gets them again, and
a free one every TAGS_FREE_SECONDS anyway (someone may have taken it), and a free one an agent is on (a job on it
queued, working or waiting on the user) every ACTIVE_TAGS_SECONDS (5 minutes), so a claim on it shows soon. The Tag
again buttons and the pages' Refresh (Issues: every open issue in the list, after
its facts; Tracked: every free issue, after the checks) do it at once
(refresh_tags), and say which ones that were free aren't anymore.

When an issue goes from free to assigned either way, Agents.issue_taken tells the agent with a job on it who has it
(the assignees from its facts, or the tags' reason), and the agent decides itself whether to keep working or stop.
"""

import asyncio
import re
import time
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, issue_facts, issue_tags, issues, jobs, tracked, tracked_issues
from github_searcher.issue_tags import CHECKS, NAME_VERSION, RULES_VERSION
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


class AssignRequest(BaseModel):
    issue: str
    agent: str | None = None  # None: a new agent is made for it.
    vm: str | None = None  # None: the agent keeps its target VM.
    instructions: str = ""


class IdsRequest(BaseModel):
    ids: list[str]


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
            if tags is None:
                todo.append(issue_id)
            elif updated_at is not None and tags["updated_at"] != updated_at:
                todo.append(issue_id)
            elif tags["status"] == "free" and datetime.fromisoformat(tags["judged_at"]) < free_before:
                todo.append(issue_id)
            elif tags["status"] == "free" and issue_id in active and datetime.fromisoformat(tags["judged_at"]) < active_before:
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
        await asyncio.sleep(TAGS_CHECK_SECONDS)
