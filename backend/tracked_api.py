"""The Tracked page: repos the user (or an agent) wants to keep an eye on, and their new issues.

The user adds a repo by name or GitHub link, removes it, and steps through the undo history; agents
change the list with their own tools (github_searcher/agent/work_tools.py). The list and each repo's
latest check reach the browser through /api/live.

A repo's check is its open issues on GitHub (github_searcher/tracked_issues.py). keep_tracked(), which
the app runs in the background, checks a newly added repo within TRACKED_CHECK_SECONDS and every repo
again every TRACKED_REFRESH_SECONDS; Check now does one at once.

An issue the user likes goes into the Issues list from here (add_issue), and its repo into Repos if
missing, both from what the last check found, so it takes no GitHub call.
"""

import asyncio
import re
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import issues, repos, tracked, tracked_issues
from github_searcher.search import get_repository

router = APIRouter(prefix="/api")

TRACKED_CHECK_SECONDS = 10
TRACKED_REFRESH_SECONDS = 10 * 60


class AddRequest(BaseModel):
    name: str  # "owner/name" or a GitHub link to the repo


class NameRequest(BaseModel):
    name: str | None = None  # None: every tracked repo


class AddIssueRequest(BaseModel):
    repo: str
    number: int


@router.post("/tracked")
def add_tracked(body: AddRequest) -> dict:
    """Track a repo. Takes a second: the repo is looked up on GitHub, for its own spelling, stars and description."""
    name = body.name.strip().removeprefix("https://").removeprefix("http://").removeprefix("www.").removeprefix("github.com/")
    name = name.removesuffix("/").removesuffix(".git")
    # A link to a page inside the repo (issues, a file) still names the repo first.
    name = "/".join(name.split("/")[:2])
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise HTTPException(status_code=400, detail="Type the repo as owner/name, or paste its GitHub link.")
    try:
        info = get_repository(name.split("/")[0], name.split("/")[1])
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            raise HTTPException(status_code=404, detail=f"GitHub has no repo {name}.")
        raise

    item = {
        "full_name": info["full_name"],
        "description": info["description"] or "",
        "stars": info["stargazers_count"],
        "default_branch": info["default_branch"],
        "html_url": info["html_url"],
        "note": "",
        "added_by": "user",
        "added_at": datetime.now(UTC).isoformat(),
    }
    added = tracked.add([item])
    if not added:
        raise HTTPException(status_code=409, detail=f"{info['full_name']} is already tracked.")
    return {"added": added}


class NamesRequest(BaseModel):
    names: list[str]


@router.post("/tracked/remove")
def remove_tracked(body: NamesRequest) -> dict:
    """Stop tracking one or many repos (the page's multi-select) as one undo step."""
    removed = tracked.remove(body.names)
    if not removed:
        raise HTTPException(status_code=404, detail="None of them is tracked.")
    return {"removed": removed}


@router.post("/tracked/undo")
def undo_tracked() -> dict:
    return {"changed": tracked.undo()}


@router.post("/tracked/redo")
def redo_tracked() -> dict:
    return {"changed": tracked.redo()}


@router.post("/tracked/check")
async def check_now(body: NameRequest) -> dict:
    """Check one repo's issues on GitHub now (a few seconds). The result arrives through /api/live."""
    names = [item["full_name"] for item in tracked.items()]
    if body.name not in names:
        raise HTTPException(status_code=404, detail=f"{body.name} is not tracked.")
    try:
        await asyncio.to_thread(tracked_issues.check, body.name)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"GitHub: {error}")
    return {}


@router.post("/tracked/add_issue")
def add_issue(body: AddIssueRequest) -> dict:
    """Put one issue of a tracked repo into the Issues list, and its repo into Repos if it isn't there."""
    item = None
    for candidate in tracked.items():
        if candidate["full_name"] == body.repo:
            item = candidate
    if item is None:
        raise HTTPException(status_code=404, detail=f"{body.repo} is not tracked.")
    check = tracked_issues.all().get(body.repo)
    found = []
    if check is not None:
        found = [issue for issue in check["issues"] if issue["number"] == body.number]
    if not found:
        raise HTTPException(status_code=404, detail=f"{body.repo}#{body.number} is not among its open issues anymore.")

    issue = found[0]
    issue_id = f"{body.repo}#{body.number}"
    added = issues.add(
        [
            {
                "id": issue_id,
                "repo": body.repo,
                "number": body.number,
                "title": issue["title"],
                "labels": issue["labels"],
                "state": "OPEN",
                "comments": issue["comments"],
                "html_url": issue["url"],
                "note": "",
                "added_by": "user",
                "added_at": datetime.now(UTC).isoformat(),
            }
        ]
    )
    if not added:
        raise HTTPException(status_code=409, detail=f"{issue_id} is already in Issues.")

    # Its repo goes into Repos too, like when an agent adds an issue, so its code can be browsed there.
    repo_item = dict(item)
    repo_item["note"] = ""
    repo_item["added_by"] = "user"
    repo_item["added_at"] = datetime.now(UTC).isoformat()
    if check["stars"] is not None:
        repo_item["stars"] = check["stars"]
    repos.add([repo_item])
    return {"added": issue_id}


async def keep_tracked() -> None:
    """Runs as long as the backend: checks repos that were never checked, and all of them now and then.

    A repo that fails (GitHub down, the repo deleted or renamed) shows its error and waits for the next full round.
    """
    last_full = None
    failed = []
    while True:
        names = [item["full_name"] for item in tracked.items()]
        checked = tracked_issues.all()
        todo = []
        if last_full is None or time.monotonic() - last_full > TRACKED_REFRESH_SECONDS:
            last_full = time.monotonic()
            failed = []
            todo = names
        else:
            todo = [name for name in names if name not in checked and name not in failed]
        for name in todo:
            try:
                await asyncio.to_thread(tracked_issues.check, name)
            except Exception:
                failed.append(name)
        await asyncio.sleep(TRACKED_CHECK_SECONDS)
