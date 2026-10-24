"""The Issues page: remove rows, undo/redo, read one issue's thread, assign an issue to an agent, and refresh the facts.

Agents fill the list; the list reaches the browser through /api/live. The
thread is fetched from GitHub each time the user expands a row. Assigning goes
through Agents.assign, which makes a job for the issue and wakes the agent, so
that endpoint runs on the event loop (`async def`).

The facts about each issue (age, last activity, assignees, linked PRs, ... see
github_searcher/issue_facts.py) are kept fresh by keep_facts(), which the app
runs in the background: new issues get theirs within FACTS_CHECK_SECONDS, and
all of them are fetched again every FACTS_REFRESH_SECONDS. Opening a row and
the Refresh button fetch them at once.

Each issue's difficulty (easy / medium / hard, github_searcher/issue_difficulty.py)
is judged once by keep_difficulty(), also in the background: new issues get
theirs within DIFFICULTY_CHECK_SECONDS, DIFFICULTY_AT_ONCE at a time.
"""

import asyncio
import re
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, issue_difficulty, issue_facts, issues
from github_searcher.search import CACHE, get_thread
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")

FACTS_CHECK_SECONDS = 10
FACTS_REFRESH_SECONDS = 30 * 60
DIFFICULTY_CHECK_SECONDS = 10
DIFFICULTY_AT_ONCE = 3
# An issue that could not be judged (Claude or GitHub down) is tried again after this long.
DIFFICULTY_RETRY_SECONDS = 30 * 60


class AssignRequest(BaseModel):
    issue: str
    agent: str | None = None  # None: a new agent is made for it.
    vm: str | None = None  # None: the agent keeps its target VM.
    instructions: str = ""


class IdsRequest(BaseModel):
    ids: list[str]


@router.post("/issues/remove")
def remove_issues(body: IdsRequest) -> dict:
    """Remove one or many issues (the page's multi-select) as one undo step."""
    removed = issues.remove(body.ids)
    if not removed:
        raise HTTPException(status_code=404, detail="None of them is in the list.")
    return {"removed": removed}


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
    # The user is looking at it: its facts (last activity, linked PRs, ...) get fresh too.
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
    try:
        return agents.assign(body.issue, body.agent, body.vm, body.instructions)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        # E.g. a different VM for an agent that is already queued for or holding its target VM.
        raise HTTPException(status_code=409, detail=str(error))


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
    """Runs as long as the backend: fetches facts for issues that have none, and for all of them now and then.

    An issue that fails (GitHub down, the issue deleted or moved) is left alone until the next full round.
    """
    last_full = None
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
        for issue_id in todo:
            try:
                await asyncio.to_thread(issue_facts.refresh, issue_id)
            except Exception:
                failed.append(issue_id)
        await asyncio.sleep(FACTS_CHECK_SECONDS)


async def keep_difficulty() -> None:
    """Runs as long as the backend: judges the difficulty of every issue that has none yet."""
    failed = []
    failed_since = time.monotonic()
    while True:
        if time.monotonic() - failed_since > DIFFICULTY_RETRY_SECONDS:
            failed = []
            failed_since = time.monotonic()
        known = issue_difficulty.all()
        todo = [item["id"] for item in issues.items() if item["id"] not in known and item["id"] not in failed]
        for start in range(0, len(todo), DIFFICULTY_AT_ONCE):
            batch = todo[start:start + DIFFICULTY_AT_ONCE]
            results = await asyncio.gather(*[issue_difficulty.judge(issue_id) for issue_id in batch], return_exceptions=True)
            for issue_id, result in zip(batch, results):
                if isinstance(result, Exception):
                    failed.append(issue_id)
        await asyncio.sleep(DIFFICULTY_CHECK_SECONDS)
