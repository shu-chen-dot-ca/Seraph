"""The GitHub tab's Your repositories and Starred, and the Workspace tab's Home (github_searcher/your_repositories.py):
one repo's page, read from GitHub when it opens, and the changes you make there, as you (Star and Unstar, and a
maintainer's in your own).

GET /api/your_repositories/{owner}/{name}/overview (the Code tab's description, README and latest commit), /tree (its
files), /file?path=...&sha=... (one file), /issues?state=open|closed, /pulls?state=open|closed, /commits (the newest
50), /runs and /branches (the Workspace tab's branch picker) are its tabs (Code, Issues, Pull requests, Commits,
Actions). All of them only read, and answer from the copy kept on this computer (with cached_at, when it was read from
GitHub); fresh=1 reads GitHub now (Refresh). overview, tree, commits and file take branch=owner/name:branch too, a
branch of the repo itself or of your fork of it: read from GitHub every time (the browser keeps it).
keep_your_repositories() reads every kept page again every PAGES_SECONDS. POST /api/your_repositories/act is one change,
{"repo", "action", "number", "kind": "issue" | "pr", "fields"}, after an "are you sure?" in the browser; it answers
{"done": what happened, in words, "url"}. POST /api/your_repositories/refresh reads the list again now (Check now).

keep_your_repositories(), which the app runs in the background, reads the list every REFRESH_SECONDS, at once when
you sign in or out, and soon after a change made here. The list reaches the browser through /api/live (topic
"your_repos").
"""

import asyncio
import re
import time
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import github_account, your_repositories
from github_searcher.your_repositories import LIST_SIZE

router = APIRouter(prefix="/api")

CHECK_SECONDS = 10
# Often enough that a repo you make, delete or star on github.com shows here within a minute. One cheap request.
REFRESH_SECONDS = 60
# How often every repo page you opened is read from GitHub again, so its kept copy stays recent.
PAGES_SECONDS = 15 * 60
NAME = r"[A-Za-z0-9_.-]+"


class ActRequest(BaseModel):
    repo: str
    action: str
    number: int | None = None
    kind: str = "issue"
    fields: dict = {}


@router.post("/your_repositories/refresh")
def refresh() -> dict:
    your_repositories.refresh()
    return {"ok": True}


@router.get("/your_repositories/{owner}/{name}/{tab}")
def repo_tab(owner: str, name: str, tab: str, state: str = "open", path: str = "", sha: str = "", fresh: bool = False, branch: str = "") -> dict:
    """One tab of one of your repositories: as kept on this computer, or with fresh as GitHub has it now."""
    if re.fullmatch(NAME, owner) is None or re.fullmatch(NAME, name) is None:
        raise HTTPException(status_code=400, detail="That isn't a GitHub repo.")
    repo = f"{owner}/{name}"
    # Right after a restart the lists aren't read yet: read them now rather than turn the page away.
    if not your_repositories.is_listed(repo) and your_repositories.data["checked_at"] is None:
        your_repositories.refresh()
    if not your_repositories.is_listed(repo):
        raise HTTPException(status_code=404, detail=f"{repo} isn't one of your repositories or stars.")
    # Issues and Pull requests are kept per Open and Closed.
    kept_tab = tab
    if tab in ["issues", "pulls"]:
        kept_tab = f"{tab}:{'closed' if state == 'closed' else 'open'}"
    # Another branch: "owner/name:branch", of the repo itself or of your fork of it.
    source = ""
    ref = ""
    if branch != "":
        source, _, ref = branch.partition(":")
        forks = [each["name"].lower() for each in your_repositories.data["repos"] if each["parent"] is not None and each["parent"].lower() == repo.lower()]
        if ref == "" or (source.lower() != repo.lower() and source.lower() not in forks):
            raise HTTPException(status_code=400, detail="That isn't a branch of this repo or of your fork of it.")
    try:
        if tab == "file":
            return your_repositories.file(repo, path, sha, source, ref)
        if ref != "" and tab == "overview":
            return {**your_repositories.overview(repo, source=source, ref=ref), "cached_at": datetime.now(UTC).isoformat()}
        if ref != "" and tab == "commits":
            return {**your_repositories.overview(repo, LIST_SIZE, source, ref), "cached_at": datetime.now(UTC).isoformat()}
        if ref != "" and tab == "tree":
            return {**your_repositories.tree(repo, source, ref), "cached_at": datetime.now(UTC).isoformat()}
        return your_repositories.page(repo, kept_tab, fresh)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.post("/your_repositories/act")
def act(body: ActRequest) -> dict:
    if not your_repositories.is_listed(body.repo) and your_repositories.data["checked_at"] is None:
        your_repositories.refresh()
    try:
        return your_repositories.act(body.repo, body.action, body.number, body.kind, body.fields)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


async def keep_your_repositories() -> None:
    """Runs as long as the backend. A failed read shows its error on the page and is tried again next round."""
    last = None
    pages_last = None
    # The login the list was last read for: a sign in or out reads it again at once.
    read_for = "none yet"
    while True:
        login = github_account.status().get("login")
        if your_repositories.wanted or last is None or login != read_for or time.monotonic() - last > REFRESH_SECONDS:
            last = time.monotonic()
            read_for = login
            your_repositories.wanted = False
            try:
                await asyncio.to_thread(your_repositories.refresh)
            except Exception as error:
                print(f"[your repositories] could not read them: {error}")
        # After the list, so a repo that left it is forgotten. The first round reads them at start.
        if pages_last is None or time.monotonic() - pages_last > PAGES_SECONDS:
            pages_last = time.monotonic()
            try:
                await asyncio.to_thread(your_repositories.refresh_pages)
            except Exception as error:
                print(f"[your repositories] could not read their pages again: {error}")
        await asyncio.sleep(CHECK_SECONDS)
