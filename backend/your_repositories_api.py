"""The GitHub tab's Your repositories and Starred (github_searcher/your_repositories.py): one repo's page, read from
GitHub when it opens, and the changes you make there, as you (Star and Unstar, and a maintainer's in your own).

GET /api/your_repositories/{owner}/{name}/overview (the Code tab's description, README and latest commit), /tree (its
files), /file?path=... (one file), /issues?state=open|closed, /pulls?state=open|closed, /commits (the newest 50) and
/runs are its tabs (Code, Issues, Pull requests, Commits, Actions). All of them only read. POST /api/your_repositories/act is one change,
{"repo", "action", "number", "kind": "issue" | "pr", "fields"}, after an "are you sure?" in the browser; it answers
{"done": what happened, in words, "url"}. POST /api/your_repositories/refresh reads the list again now (Check now).

keep_your_repositories(), which the app runs in the background, reads the list every REFRESH_SECONDS, at once when
you sign in or out, and soon after a change made here. The list reaches the browser through /api/live (topic
"your_repos").
"""

import asyncio
import re
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import github_account, your_repositories
from github_searcher.your_repositories import LIST_SIZE

router = APIRouter(prefix="/api")

CHECK_SECONDS = 10
# Often enough that a repo you make, delete or star on github.com shows here within a minute. One cheap request.
REFRESH_SECONDS = 60
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
def repo_tab(owner: str, name: str, tab: str, state: str = "open", path: str = "") -> dict:
    """One tab of one of your repositories, as GitHub has it now."""
    if re.fullmatch(NAME, owner) is None or re.fullmatch(NAME, name) is None:
        raise HTTPException(status_code=400, detail="That isn't a GitHub repo.")
    repo = f"{owner}/{name}"
    # Right after a restart the lists aren't read yet: read them now rather than turn the page away.
    if not your_repositories.is_listed(repo) and your_repositories.data["checked_at"] is None:
        your_repositories.refresh()
    if not your_repositories.is_listed(repo):
        raise HTTPException(status_code=404, detail=f"{repo} isn't one of your repositories or stars.")
    try:
        if tab == "overview":
            return your_repositories.overview(repo)
        if tab == "commits":
            return your_repositories.overview(repo, LIST_SIZE)
        if tab == "tree":
            return your_repositories.tree(repo)
        if tab == "file":
            return your_repositories.file(repo, path)
        if tab == "issues":
            return your_repositories.issues(repo, state)
        if tab == "pulls":
            return your_repositories.pulls(repo, state)
        if tab == "runs":
            return your_repositories.runs(repo)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    raise HTTPException(status_code=404, detail=f"Unknown tab {tab}.")


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
        await asyncio.sleep(CHECK_SECONDS)
