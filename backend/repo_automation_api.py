"""A repo's automation (the robot on its card on the Dashboard's Repository page, and a click on an issue card's logo on
the Issues board: frontend/src/AutomationDialog.tsx): what agents do there without asking you, as you.

The settings, by repo, in SETTINGS_FILE (a repo not in it has DEFAULTS):

    {"owner/name": {"add_issues", "queue_issues", "take_issues", "questions", "comments", "pull_requests",
                    "open_issues": bool, "max_prs_first", "max_prs": int, "levels_first", "levels": ["easy", ...],
                    "instructions": str}, ...}

The Issue levels and Open PRs at once each come in two: until one of your PRs on the repo is merged (levels_first: Easy
at first; max_prs_first: 1), and after, once you are a contributor there (levels: Easy, Medium and Hard; max_prs: 5).
Your merged PRs are the ones pr_tracking.py follows. Settings from before levels_first have Easy for it.

and an issue's own level (the robot on its card on the Issues board: frontend/src/IssueAutomationDialog.tsx), which goes
over its repo's for the drafts of the jobs on that issue, in ISSUE_SETTINGS_FILE:

    {"owner/name#n": {"questions", "comments", "pull_requests": bool}, ...}

GET /api/repos/automation gives them all with the defaults (the live "automation" topic too: backend/automation_api.py,
the Dashboard's Automation → Settings, which opens the same dialogs); PUT /api/repos/automation gives the picked repos the same
ones (the dialog's Save, for one repo or many); PUT /api/issues/automation sets one issue's own, or drops it (level
null: its repo's counts again). How many agents work at once is the Issues board's (max_agents in
backend/issues_api.py), not a repo's.

What each does:
- Add issues: keep_adding() below puts the repo's open issues whose level is among its Issue levels in the Issues list.
- Queue issues: keep_catalog() below puts the repo's issues that fit in the Issues board's Catalog. Settings from
  before it have none: their Take issues says, as Take issues did that then.
- Take issues: agents take the repo's issues from Catalog, from the top, while fewer than the board's max_agents work
  (keep_catalog_agents in backend/issues_api.py).
- Questions, Comments and Pull requests: keep_drafts() below, every DRAFTS_CHECK_SECONDS, looks at the pending drafts in
  the Inbox. A question with a recommended answer that needn't wait for you (inbox.py must_wait) is answered with it at
  once (answered_by "automation"), as the timer would later. A comment is posted on GitHub as you, and a PR (once its
  reviewer passed it) or an edit (a new title and description of your PR or issue) is sent as you, as Approve with
  Send does (github_account.py), then approved, so its agent hears it the same way. One GitHub refuses (or that has to
  wait, like a PR whose claim isn't decided yet, or whose claimed issue isn't assigned to you yet: github_account.py)
  stays in the Inbox for you, and is tried again after SEND_RETRY_SECONDS.
  Pull requests also lets agents update the branch of your open PRs there (update_branch, work_tools.py).
- Open PRs at once: how many of your PRs may be open on the repo at the same time, max_prs_first until one of yours
  there is merged (1 at first), max_prs after (5). Two places hold to it. Catalog to In progress: agents take no more
  of the repo's Catalog cards while its open PRs and its issues with an open job (from queued to waiting on you) add up
  to it (keep_catalog_agents in backend/issues_api.py). Review to Open PR: keep_drafts sends no new PR there while its
  open PRs are at it; the ones over it wait in the Inbox (the board's Review) until one is merged or closed. New
  versions of open PRs, and a PR made again in place of an old one, always go. No new PR goes to an archived repo
  (the Dashboard's Automation archives the ones that don't merge ours: backend/automation_api.py), but one for an issue
  our agents opened: we never give one of those up. You can still send
  one by hand: Approve in the Inbox, or Publish on the Pull requests page.
- Open issues: agents may open new issues on the repo as you, claimed for you (assigned, else your comment saying you
  are on it), where the project's rules allow it (open_issue, work_tools.py); each goes to the top of the Issues
  board's Catalog, before every other card, where another agent takes it first, whatever the repo's Take issues and
  Open PRs at once say (keep_catalog_agents in backend/issues_api.py). Never one out of scope: open_issue refuses it.

keep_adding() runs in the background, every ADD_CHECK_SECONDS. For each repo in Repos (not archived, not one that
doesn't take AI-made contributions: AI policy no_ai, repo_signals.py, not one closed to outside contributors: its
newcomer verdict, whose issues are all No outside PRs, and not one at its Open PRs at once: HELD in
backend/issues_api.py, whose issues can't be taken now, to save GitHub's quota) with Add issues on,
it reads all its open issues from GitHub, every ADD_REFRESH_SECONDS (at once after Add issues is turned on, or the
backend starts). Each issue only once: one it added, or that was in the Issues list when it looked, is kept in
ADDED_FILE and never added again, so one you take off stays off (Add in the repo's pop-up on the Repository page still
puts it in Catalog: backend/issues_api.py add_to_catalog); one taken off with the x is skipped too. The rest are tagged
first (issue_tags.py) when they have no tags yet or changed on GitHub since, and the ones whose complexity is among the
repo's Issue levels (one out of scope has none) go into the Issues list, on the board's Open column. Nothing else is
asked here: the Issues board reads each one again from fresh as it comes in, and its own rules (Remove automatically)
decide on it (keep_new_tags in backend/issues_api.py). One that didn't match is looked at again when it changes on
GitHub, or the levels change.

keep_catalog() runs in the background right after issues get tagged (TAGGED in backend/issues_api.py, which keep_new_tags
and keep_tags set), and every CATALOG_CHECK_SECONDS anyway, so Open is only where an issue waits for its tags. For each
repo with Queue issues on (not an archived one), its issues on the board with no job (or only cancelled ones), open,
not one our agents opened, once their tags are read: after the issue's last change on GitHub that the app knows of, by
the current rules and since it came in, however long ago (an agent reads them again before it takes one:
take_from_catalog in backend/issues_api.py).
- Claimed: someone else is on it, or it is already fixed (status assigned or fixed, issue_tags.py). It leaves the Issues
  list at once, from Open and Catalog alike.
- Filtered out: on Open, not tagged free with merge likely, or its complexity isn't among the repo's issue levels. It
  leaves the Issues list at once.
- The rest on Open: Claude reads them, up to PER_RUN of one repo in one run with no tools (claude_judge.py), with
  DEFAULT_RULES and the repo's instructions on top, and picks which to take. The picked ones go to the end of Catalog,
  the others leave the Issues list. Each issue is asked about once per basis (the instructions, the levels and its last
  change on GitHub), kept in PICKED_FILE: one you move back from Catalog to Open stays there until one of those changes.
What leaves goes as one undo step on the Issues page; Add issues never adds it again (Add in the repo's pop-up on the
Repository page still does). A failed run is tried again next round.
"""

import asyncio
import hashlib
import json
import time
import traceback
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.issues_api import AUTOMATION_VERSION, HELD, TAGGED
from backend.shared import agents, github_account, inbox, issue_facts, issue_tags, issues, jobs, pr_tracking, repo_signals, repos
from github_searcher.claude_judge import judge
from github_searcher.github_account import SendError
from github_searcher.inbox import AUTOMATION_FILE, ISSUE_AUTOMATION_FILE
from github_searcher.issue_tags import DATA_DIR, RULES_VERSION
from github_searcher.search import get_open_issues

router = APIRouter(prefix="/api")

SETTINGS_FILE = AUTOMATION_FILE
ISSUE_SETTINGS_FILE = ISSUE_AUTOMATION_FILE
PICKED_FILE = DATA_DIR / "catalog_picks.json"
ADDED_FILE = DATA_DIR / "added_issues.json"
DEFAULTS = {
    "add_issues": False,
    "queue_issues": False,
    "take_issues": False,
    "questions": False,
    "comments": False,
    "pull_requests": False,
    "open_issues": False,
    # How many of your PRs may be open on the repo at once: until one of yours there is merged, and after.
    "max_prs_first": 1,
    "max_prs": 5,
    # Which issues may be taken, by complexity: until one of yours there is merged, and after.
    "levels_first": ["easy"],
    "levels": ["easy", "medium", "hard"],
    "instructions": "",
}
LEVELS = ["easy", "medium", "hard"]
CATALOG_CHECK_SECONDS = 60
ADD_CHECK_SECONDS = 60
# How often Add issues reads a repo's open issues from GitHub again.
ADD_REFRESH_SECONDS = 10 * 60
DRAFTS_CHECK_SECONDS = 10
# A draft GitHub refused (or that has to wait) is tried again after this long; it waits in the Inbox meanwhile.
SEND_RETRY_SECONDS = 10 * 60
# Issues of one repo in one Claude run.
PER_RUN = 40
# Always, under any repo's instructions.
DEFAULT_RULES = (
    "Never take an issue that is political, politically sensitive or activist, that goes against another country's laws, "
    "such as China's, or that is unethical or NSFW."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"number": {"type": "integer"}, "take": {"type": "boolean"}},
                "required": ["number", "take"],
            },
        }
    },
    "required": ["issues"],
}


class AutomationRequest(BaseModel):
    repos: list[str]
    add_issues: bool = False
    queue_issues: bool = False
    take_issues: bool
    questions: bool
    comments: bool
    pull_requests: bool
    open_issues: bool = False
    max_prs_first: int = 1
    max_prs: int = 5
    levels_first: list[str] = ["easy"]
    levels: list[str]
    instructions: str


class IssueLevel(BaseModel):
    questions: bool
    comments: bool
    pull_requests: bool


class IssueAutomationRequest(BaseModel):
    id: str  # owner/name#n
    level: IssueLevel | None  # None: its repo's counts again


@router.get("/repos/automation")
def get_automation() -> dict:
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    own = {}
    if ISSUE_SETTINGS_FILE.is_file():
        own = json.loads(ISSUE_SETTINGS_FILE.read_text())
    return {"defaults": DEFAULTS, "repos": settings, "issues": own}


@router.put("/issues/automation")
def put_issue_automation(body: IssueAutomationRequest) -> dict:
    """Set one issue's own level, or drop it (level None); returns every issue's."""
    own = {}
    if ISSUE_SETTINGS_FILE.is_file():
        own = json.loads(ISSUE_SETTINGS_FILE.read_text())
    if body.level is None:
        own.pop(body.id, None)
    else:
        own[body.id] = body.level.model_dump()
    ISSUE_SETTINGS_FILE.write_text(json.dumps(own, indent=2))
    AUTOMATION_VERSION["version"] += 1
    return {"issues": own}


@router.put("/repos/automation")
def put_automation(body: AutomationRequest) -> dict:
    """Give these repos the same settings; returns them all."""
    if not body.repos:
        raise HTTPException(status_code=400, detail="No repository picked.")
    if any(level not in LEVELS for level in body.levels + body.levels_first):
        raise HTTPException(status_code=400, detail="The levels are easy, medium and hard.")
    if body.max_prs_first < 1 or body.max_prs_first > 50 or body.max_prs < 1 or body.max_prs > 50:
        raise HTTPException(status_code=400, detail="Open PRs at once is 1 to 50.")
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    for repo in body.repos:
        settings[repo] = body.model_dump(exclude={"repos"})
        settings[repo]["instructions"] = body.instructions.strip()
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    AUTOMATION_VERSION["version"] += 1
    return {"defaults": DEFAULTS, "repos": settings}


# When each draft's send last failed, by id (only in memory: a restart tries them all again).
failed_at = {}


async def keep_drafts() -> None:
    """Runs as long as the backend: answers and sends the pending drafts their repo or issue lets go without you (see the
    top of this file)."""
    while True:
        try:
            await act_on_drafts()
        except Exception:
            # A file failed: the next round tries again.
            traceback.print_exc()
        await asyncio.sleep(DRAFTS_CHECK_SECONDS)


async def act_on_drafts() -> None:
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    by_name = {repo.lower(): rules for repo, rules in settings.items()}
    own = {}
    if ISSUE_SETTINGS_FILE.is_file():
        own = json.loads(ISSUE_SETTINGS_FILE.read_text())
    issue_of_job = {job["id"]: job["issue"] for job in jobs.list()}
    archived = [name.lower() for name in repos.archived()]
    # The issues our agents opened as you (lower case): a PR for one still goes to an archived repo.
    opened = []
    for action in inbox.actions():
        if action["kind"] == "issue":
            opened.append(f"{action['sent']['repo']}#{action['sent']['number']}".lower())
    # Your PRs open on each repo, and how many of yours it merged (lower case): a new PR waits while the repo has its
    # Open PRs at once.
    open_prs = {}
    merged = {}
    for pr in pr_tracking.summary()["items"]:
        if pr["relation"] == "author" and pr["state"] == "open":
            open_prs[pr["repo"].lower()] = open_prs.get(pr["repo"].lower(), 0) + 1
        if pr["relation"] == "author" and pr["state"] == "merged":
            merged[pr["repo"].lower()] = merged.get(pr["repo"].lower(), 0) + 1

    for draft in inbox.list():
        if draft["status"] != "pending" or draft["repo"] is None:
            continue
        rules = by_name.get(draft["repo"].lower(), DEFAULTS)
        level = {"questions": rules["questions"], "comments": rules["comments"], "pull_requests": rules["pull_requests"]}
        # The issue's own level goes over its repo's.
        issue_id = issue_of_job.get(draft["job"])
        if issue_id in own:
            level = own[issue_id]

        if draft["kind"] == "question" and level["questions"] and draft.get("must_wait") is None and draft.get("recommended"):
            try:
                agents.decide(draft["id"], "replied", f"I pick: {draft['recommended']}", answered_by="automation")
            except (KeyError, ValueError):
                pass  # You decided it, or deleted it, in the meantime.
            continue

        send = False
        if draft["kind"] == "comment" and level["comments"]:
            send = True
        if draft["kind"] in ["pr", "edit"] and level["pull_requests"]:
            send = True
        # A PR goes once its reviewer passed it, as it only reaches the Inbox then.
        review = draft.get("review")
        if draft["kind"] == "pr" and review is not None and review["state"] != "passed":
            send = False
        # A new PR (not a new version of an open one, nor one made again in place of one) only while the repo has room:
        # the others wait in Review until one of yours there is merged or closed. Publish on the Pull requests page still
        # sends one by hand.
        name = draft["repo"].lower()
        new_pr = draft["kind"] == "pr" and draft["update_of"] is None and draft["replaces"] is None
        limit = rules.get("max_prs_first", 1)
        if merged.get(name, 0) > 0:
            limit = rules.get("max_prs", 5)
        if send and new_pr and open_prs.get(name, 0) >= limit:
            send = False
        # Never a new one to an archived repo, but for an issue we opened: we never give one up.
        if send and new_pr and name in archived and (issue_id or "").lower() not in opened:
            send = False
        if not send or time.time() - failed_at.get(draft["id"], 0) < SEND_RETRY_SECONDS:
            continue
        try:
            await asyncio.to_thread(github_account.send, draft["id"])
            agents.decide(draft["id"], "approved")
            if new_pr:
                open_prs[name] = open_prs.get(name, 0) + 1
        except (SendError, KeyError, ValueError):
            failed_at[draft["id"]] = time.time()


# When Add issues last read each repo's open issues, by name (only in memory: a restart reads them all again).
read_at = {}


async def keep_adding() -> None:
    """Runs as long as the backend: puts the repos' open issues that match their Issue levels in the Issues list, each
    once (see the top of this file)."""
    while True:
        try:
            await add_issues()
        except Exception:
            # Claude or a file failed: the next round tries again.
            traceback.print_exc()
        await asyncio.sleep(ADD_CHECK_SECONDS)


async def add_issues() -> None:
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    # By repo name in lower case: the settings may spell a name their own way.
    by_name = {repo.lower(): rules for repo, rules in settings.items()}
    added = []
    if ADDED_FILE.is_file():
        added = json.loads(ADDED_FILE.read_text())["added"]
    # Not an archived repo, nor one that doesn't take AI-made contributions (its AI policy, repo_signals.py), nor one that
    # isn't open to outside contributors (its newcomer verdict): none of their issues would be merge likely.
    skipped = [name.lower() for name in repos.archived()]
    skipped += [name.lower() for name, each in repo_signals.all().items() if (each.get("ai_policy") or {}).get("tag") == "no_ai"]
    skipped += [name.lower() for name, each in repo_signals.all().items() if (each.get("newcomer_verdict") or {}).get("verdict") == "closed"]
    # Nor one at its Open PRs at once: its issues can't be taken now.
    skipped += HELD["repos"]
    names = [item["full_name"] for item in repos.items() if item["full_name"].lower() not in skipped]
    # How many of your PRs each repo merged (lower case): until one is, its levels_first are the levels.
    merged = {}
    for pr in pr_tracking.summary()["items"]:
        if pr["relation"] == "author" and pr["state"] == "merged":
            merged[pr["repo"].lower()] = merged.get(pr["repo"].lower(), 0) + 1

    for name in names:
        rules = by_name.get(name.lower())
        if rules is None or not rules.get("add_issues") or time.time() - read_at.get(name, 0) < ADD_REFRESH_SECONDS:
            continue
        # Set first: a repo GitHub fails on is tried again after ADD_REFRESH_SECONDS, not every round.
        read_at[name] = time.time()
        try:
            nodes = await asyncio.to_thread(get_open_issues, name.split("/")[0], name.split("/")[1])
        except (httpx.HTTPError, ValueError):
            continue
        listed = [item["id"] for item in issues.items()]
        dismissed = issues.dismissed()
        tags = issue_tags.all()

        # Not added before, and tagged first when it has no tags yet or changed on GitHub since.
        waiting = []
        todo = []
        for node in nodes:
            issue_id = f"{name}#{node['number']}"
            if issue_id in listed and issue_id not in added:
                added.append(issue_id)
            if issue_id in added or issue_id in dismissed:
                continue
            waiting.append(node)
            tag = tags.get(issue_id)
            if tag is None or tag["updated_at"] != node["updatedAt"]:
                todo.append(issue_id)
        if todo:
            await issue_tags.tag(todo)
        tags = issue_tags.all()

        items = []
        for node in waiting:
            issue_id = f"{name}#{node['number']}"
            tag = tags.get(issue_id)
            levels = rules["levels"] if merged.get(name.lower(), 0) > 0 else rules.get("levels_first", ["easy"])
            if tag is None or tag.get("merge") == "out of scope" or tag.get("complexity") not in levels:
                continue
            items.append(
                {
                    "id": issue_id,
                    "repo": name,
                    "number": node["number"],
                    "title": node["title"],
                    "labels": [label["name"] for label in node["labels"]["nodes"]],
                    "state": "OPEN",
                    "comments": node["comments"]["totalCount"],
                    "html_url": node["url"],
                    "note": "",
                    "added_by": "user",
                    "added_at": datetime.now(UTC).isoformat(),
                }
            )
        added += issues.add(items)
        ADDED_FILE.write_text(json.dumps({"added": added}, indent=2))


async def keep_catalog() -> None:
    """Runs as long as the backend: puts the issues an agent picks into Catalog and takes the claimed and filtered ones
    off the board, right after issues get tagged (see the top of this file)."""
    while True:
        # Cleared first: issues tagged while this round runs bring the next one at once.
        TAGGED.clear()
        try:
            await pick_for_catalog()
        except Exception:
            pass  # Claude or a file failed: the next round tries again.
        try:
            await asyncio.wait_for(TAGGED.wait(), CATALOG_CHECK_SECONDS)
        except TimeoutError:
            pass


async def pick_for_catalog() -> None:
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    # By repo name in lower case: an issue's repo may be spelled its own way. An archived repo takes nothing.
    archived = [name.lower() for name in repos.archived()]
    by_name = {repo.lower(): rules for repo, rules in settings.items() if repo.lower() not in archived}
    picked = {}
    if PICKED_FILE.is_file():
        picked = json.loads(PICKED_FILE.read_text())
    tags = issue_tags.all()
    facts = issue_facts.all()
    catalog = issues.board()["catalog"]
    started = [job["issue"] for job in jobs.list() if job["issue"] is not None and job["status"] != "cancelled"]
    # The issues our agents opened as you (lower case): claimed for you, never taken off here.
    opened = []
    for action in inbox.actions():
        if action["kind"] == "issue":
            opened.append(f"{action['sent']['repo']}#{action['sent']['number']}".lower())
    # How many of your PRs each repo merged (lower case): until one is, its levels_first are the levels.
    merged = {}
    for pr in pr_tracking.summary()["items"]:
        if pr["relation"] == "author" and pr["state"] == "merged":
            merged[pr["repo"].lower()] = merged.get(pr["repo"].lower(), 0) + 1

    # What fits, by repo: (item, tag, basis); and what leaves the Issues list.
    candidates = {}
    drop = []
    for item in issues.items():
        rules = by_name.get(item["repo"].lower())
        tag = tags.get(item["id"])
        if rules is None or tag is None:
            continue
        # Settings from before Queue issues: their Take issues put issues in Catalog then.
        if not rules.get("queue_issues", rules["take_issues"]):
            continue
        if item["id"] in started or item["state"] == "CLOSED" or item["id"].lower() in opened:
            continue
        # Its tags read: after its last change on GitHub, by the current rules.
        fact = facts.get(item["id"])
        if fact and fact.get("updated_at") is not None and fact["updated_at"] > tag["updated_at"]:
            continue
        judged = tag.get("judged_at")
        if judged is None or tag.get("rules_version") != RULES_VERSION:
            continue
        # Not read again since it came in: keep_new_tags (backend/issues_api.py) does that first.
        if datetime.fromisoformat(judged) < datetime.fromisoformat(item["added_at"]):
            continue
        # Claimed (someone else is on it, or it is fixed): off the board, from Catalog too.
        if tag["status"] in ["assigned", "fixed"]:
            drop.append(item["id"])
            continue
        if item["id"] in catalog:
            continue
        # Filtered out: off the board.
        levels = rules["levels"] if merged.get(item["repo"].lower(), 0) > 0 else rules.get("levels_first", ["easy"])
        if tag["status"] != "free" or tag.get("merge") != "likely" or tag.get("complexity") not in levels:
            drop.append(item["id"])
            continue
        basis = hashlib.sha256(json.dumps([rules["instructions"], sorted(levels), tag["updated_at"]]).encode()).hexdigest()[:16]
        if picked.get(item["id"]) == basis:
            continue
        candidates.setdefault(item["repo"], []).append((item, tag, basis))
    if drop:
        issues.remove(drop)

    for repo, entries in candidates.items():
        rules = by_name[repo.lower()]
        for start in range(0, len(entries), PER_RUN):
            run = entries[start:start + PER_RUN]
            lines = []
            for item, tag, basis in run:
                lines.append(
                    f"#{item['number']}: {tag.get('name') or item['title']} (GitHub title: {item['title']}; {tag.get('kind')}, "
                    f"{tag.get('complexity')}, about {tag.get('lines')} lines). {tag['reason']}"
                )
            instructions = rules["instructions"] or "None."
            prompt = (
                f"Below are open issues of the GitHub project {repo}. We fix issues of outside projects with our own agents, "
                "and these already passed our checks: nobody else is on them, and a pull request from us would likely get "
                "merged. Pick which ones our agents should take on now.\n\n"
                f"Rules: {DEFAULT_RULES}\n"
                f"The user's instructions for this repo, on top of the rules: {instructions}\n\n"
                "Answer take true or false for every issue, by its number.\n\n" + "\n".join(lines)
            )
            answer = await judge(prompt, SCHEMA, "medium")
            take = [each["number"] for each in answer["issues"] if each["take"]]
            answered = [each["number"] for each in answer["issues"]]
            new = []
            declined = []
            for item, tag, basis in run:
                if item["number"] in answered:
                    picked[item["id"]] = basis
                if item["number"] in take:
                    new.append(item["id"])
                if item["number"] in answered and item["number"] not in take:
                    declined.append(item["id"])
            PICKED_FILE.write_text(json.dumps(picked, indent=2))
            # The board as it is now: the user may have moved cards while Claude read.
            board = issues.board()
            added = [issue_id for issue_id in new if issue_id not in board["catalog"]]
            if added:
                issues.set_board(board["catalog"] + added, board["order"], board["held"])
            # The ones it didn't pick leave the board, unless the user moved one to Catalog meanwhile.
            declined = [issue_id for issue_id in declined if issue_id not in board["catalog"]]
            if declined:
                issues.remove(declined)
