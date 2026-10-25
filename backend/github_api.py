"""The GitHub page: your PRs on GitHub and how each one stands (github_searcher/pr_tracking.py). Its Account tab
connects your GitHub account (backend/github_account_api.py).

keep_prs(), which the app runs in the background, reads the PRs again every PRS_REFRESH_SECONDS, and at once
when Approve just sent a PR that isn't followed yet. Check now (POST /api/github/refresh) reads them at once.
The PRs reach the browser through /api/live (topic "prs").
"""

import asyncio
import time

from fastapi import APIRouter

from backend.shared import inbox, pr_tracking

router = APIRouter(prefix="/api")

PRS_CHECK_SECONDS = 15
PRS_REFRESH_SECONDS = 5 * 60


@router.post("/github/refresh")
async def refresh_prs() -> dict:
    """Read every PR again now. Takes a few seconds per PR."""
    await asyncio.to_thread(pr_tracking.refresh)
    return {"ok": True}


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
