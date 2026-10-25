"""The GitHub page: your PRs on GitHub and how each one stands (github_searcher/pr_tracking.py), and changes you
make to them, as you (github_searcher/github_account.py). Its Account tab connects the account itself
(backend/github_account_api.py).

keep_prs(), which the app runs in the background, reads the PRs again every PRS_REFRESH_SECONDS, and at once
when Approve just sent a PR that isn't followed yet. Check now (POST /api/github/refresh) reads them at once.
The buttons (each asks "are you sure?" in the browser first): close or reopen one of your PRs, delete a closed
or merged PR's branch from your fork. After a change, the PRs are read again. The PRs reach the browser through
/api/live (topic "prs").
"""

import asyncio
import time

from fastapi import APIRouter, HTTPException

from backend.shared import github_account, inbox, pr_tracking
from github_searcher.github_account import SendError

router = APIRouter(prefix="/api")

PRS_CHECK_SECONDS = 15
PRS_REFRESH_SECONDS = 5 * 60
PR_ACTIONS = ["close", "reopen", "delete_branch"]


@router.post("/github/refresh")
async def refresh_prs() -> dict:
    """Read every PR again now. Takes a few seconds per PR."""
    await asyncio.to_thread(pr_tracking.refresh)
    return {"ok": True}


@router.post("/github/prs/{owner}/{name}/{number}/{action}")
async def change_pr(owner: str, name: str, number: int, action: str) -> dict:
    """Close or reopen one of your PRs, or delete its branch from your fork. Returns what happened, in words."""
    if action not in PR_ACTIONS:
        raise HTTPException(status_code=404, detail=f"Unknown action {action}.")
    try:
        done = await asyncio.to_thread(github_account.manage, action, f"{owner}/{name}", number)
    except SendError as error:
        raise HTTPException(status_code=400, detail=str(error))
    await asyncio.to_thread(pr_tracking.refresh)
    return {"done": done}


async def keep_prs() -> None:
    """Runs as long as the backend. A PR that fails to read shows its error and is tried again next round."""
    last = None
    # The sent PRs a refresh has already tried to read.
    tried = set()
    while True:
        sent = []
        for draft in inbox.list():
            if draft["sent"] is not None and draft["sent"]["kind"] == "pr":
                sent.append(f"{draft['sent']['repo']}#{draft['sent']['number']}")
        new = [pr_id for pr_id in sent if pr_id not in tried]
        if new or last is None or time.monotonic() - last > PRS_REFRESH_SECONDS:
            last = time.monotonic()
            tried.update(sent)
            try:
                await asyncio.to_thread(pr_tracking.refresh)
            except Exception:
                pass
        await asyncio.sleep(PRS_CHECK_SECONDS)
