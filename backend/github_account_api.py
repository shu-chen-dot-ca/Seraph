"""The GitHub page's Account tab: connect your own account with a token, see who it is connected as, disconnect.

The token goes one way. The browser sends it once (PUT), and nothing ever sends it back: GET only says
who it is and what the token may do (github_searcher/github_account.py). Approve in the Inbox then
sends PRs and comments as that account (backend/inbox_api.py), and the GitHub page's buttons change
them as that account (backend/github_api.py).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import github_account

router = APIRouter(prefix="/api")


class TokenRequest(BaseModel):
    token: str


@router.get("/github_account")
def account_status() -> dict:
    return github_account.status()


@router.put("/github_account")
def connect(body: TokenRequest) -> dict:
    """Checked with GitHub first: a token that can't open PRs is turned down, with why."""
    try:
        return github_account.connect(body.token)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.delete("/github_account")
def disconnect() -> dict:
    github_account.disconnect()
    return github_account.status()
