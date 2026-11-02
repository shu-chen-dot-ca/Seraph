"""The GitHub tab's Account page: sign in with GitHub, see who you are signed in as, sign out.

Sign in (github_searcher/github_account.py has how it works):
- PUT /api/github_account/app keeps the OAuth App's client ID and secret, the one-time setup.
- POST /api/github_account/sign_in gives the page GitHub's address to go to. A POST, so only this app's own pages
  can start one (backend/app.py checks the Origin).
- GitHub sends the browser back to GET /api/github_account/callback, through the Vite dev server like every /api
  address. It signs you in and goes back to the Account page: #/github/account?signed_in=<login>, or ?error=<why>
  (also when you click Cancel on GitHub's page).
- PUT /api/github_account takes a classic token pasted by hand instead (Use a token instead).

The token goes one way: nothing ever sends it back. GET only says who it is, what the token may do and whether sign in
is set up. Approve in the Inbox then sends PRs and comments as that account (backend/inbox_api.py), and the GitHub
tab's buttons (Comment, close or reopen a PR, delete a branch or a comment) act as that account (backend/github_api.py).
DELETE is Sign out: the app forgets the token. GET /api/github_account/sending says what a send going on is doing (the
Inbox shows it while you wait).
"""

from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from backend.shared import github_account

router = APIRouter(prefix="/api")


class TokenRequest(BaseModel):
    token: str


class AppRequest(BaseModel):
    client_id: str
    client_secret: str


@router.get("/github_account")
def account_status() -> dict:
    return github_account.status()


@router.get("/github_account/sending")
def sending() -> dict:
    """What a send going on is doing, for the Inbox while you wait: {"draft": id | None, "step"}."""
    draft = github_account.sending_draft
    step = ""
    if draft is not None:
        step = github_account.step
    return {"draft": draft, "step": step}


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


@router.put("/github_account/app")
def save_app(body: AppRequest) -> dict:
    try:
        github_account.save_app(body.client_id, body.client_secret)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return github_account.status()


@router.post("/github_account/sign_in")
def sign_in() -> dict:
    try:
        return {"url": github_account.sign_in_url()}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.get("/github_account/callback")
def callback(code: str = "", state: str = "", error: str = "", error_description: str = "") -> RedirectResponse:
    """Where GitHub sends the browser back to, with a code to trade for your token, or why not."""
    if error == "access_denied":
        return RedirectResponse("/#/github/account?" + urlencode({"error": "Sign in cancelled."}))
    if error != "":
        return RedirectResponse("/#/github/account?" + urlencode({"error": error_description or error}))
    try:
        account = github_account.finish_sign_in(code, state)
    except ValueError as problem:
        return RedirectResponse("/#/github/account?" + urlencode({"error": str(problem)}))
    return RedirectResponse("/#/github/account?" + urlencode({"signed_in": account["login"]}))
