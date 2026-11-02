"""The Inbox (on the header's GitHub tab): the user decides on the agents' drafts (PRs, comments, questions), and on
the app's own question when an issue an agent works on gets taken (approve: keep working,
reject: stop the agent).

Approving tells the agent. Only with send (the Inbox asks "are you sure?" first, and only when your
GitHub account is connected: the GitHub tab, Account) does Approve on a PR or comment send it to GitHub as you,
before the agent is told; if GitHub refuses, nothing is decided. POST /send does the same for one
approved before (while no account was connected). Sending runs in a thread (github_account.py). A PR draft that is
a new version of your open PR (update_of) is pushed onto that PR's branch, and its text posted there as your comment
(a rebase is force-pushed). An edit draft changes the title and description of your own PR or issue.

POST /inbox/{id}/edit changes a pending PR, comment or edit draft's title and text before you decide (the Inbox and the
GitHub tab's thread pop-up); its agent is told with your decision that you edited it, and the final text.

Every decision goes through Agents.decide, which also puts the draft's job back in the queue and
wakes the agent, so those endpoints run on the event loop (`async def`). The
drafts themselves reach the browser through /api/live.

POST /inbox/delete deletes decided drafts for good (pending ones stay: their agents wait for an answer). Their
agents aren't told, and what was sent to GitHub stays there.

A draft's evidence (screenshots, images, command output) is files in EVIDENCE_DIR,
served by name. Names are only ever ones the agent tools made (ev_<hex>.<ext>), so
a request can't reach any other file.
"""

import asyncio
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from backend.shared import agents, github_account, inbox
from github_searcher.github_account import SendError
from github_searcher.jobs import EVIDENCE_DIR

router = APIRouter(prefix="/api")

EVIDENCE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "txt": "text/plain; charset=utf-8"}


class ReplyRequest(BaseModel):
    text: str = ""
    # Approve only: send the PR or comment to GitHub as you first.
    send: bool = False


class DeleteRequest(BaseModel):
    ids: list[str]


class EditRequest(BaseModel):
    title: str
    body: str


@router.post("/inbox/delete")
def delete(body: DeleteRequest) -> dict:
    """Deletes the decided ones among these; returns the ids deleted."""
    return {"deleted": inbox.delete(body.ids)}


@router.post("/inbox/{draft_id}/approve")
async def approve(draft_id: str, body: ReplyRequest | None = None) -> dict:
    """A note can come along (the reply box's text); without one the body can be left out."""
    reply = ""
    send = False
    if body is not None:
        reply = body.text
        send = body.send
    try:
        if send:
            draft = inbox.get(draft_id)
            if draft["status"] != "pending":
                raise ValueError(f"{draft_id} was already {draft['status']}")
            await asyncio.to_thread(github_account.send, draft_id)
        return agents.decide(draft_id, "approved", reply)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    except SendError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/inbox/{draft_id}/reject")
async def reject(draft_id: str, body: ReplyRequest | None = None) -> dict:
    """Like approve: the reply box's text can come along as the reason."""
    reply = ""
    if body is not None:
        reply = body.text
    try:
        return agents.decide(draft_id, "rejected", reply)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/inbox/{draft_id}/reply")
async def reply(draft_id: str, body: ReplyRequest) -> dict:
    """The user answers without deciding; the agent reads the reply and keeps working."""
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="The reply is empty.")
    try:
        return agents.decide(draft_id, "replied", body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/inbox/{draft_id}/edit")
def edit(draft_id: str, body: EditRequest) -> dict:
    """The user changes a pending PR or comment draft's title and text; returns the draft."""
    if not body.title.strip() or not body.body.strip():
        raise HTTPException(status_code=400, detail="The title and the text can't be empty.")
    try:
        return inbox.edit(draft_id, body.title, body.body)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/inbox/{draft_id}/send")
async def send(draft_id: str) -> dict:
    """An approved PR or comment that isn't on GitHub yet, sent as you now; its agent is told."""
    try:
        draft = inbox.get(draft_id)
        if draft["status"] != "approved":
            raise ValueError("Only an approved draft is sent from here; a pending one is sent by Approve.")
        draft = await asyncio.to_thread(github_account.send, draft_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    except SendError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    what = "comment"
    if draft["kind"] == "pr":
        what = "PR"
    if draft["kind"] == "edit":
        what = "title and description"
    text = f"The user sent your approved {what} draft {draft_id} ({draft['title']}) to GitHub: {draft['sent']['url']}"
    if draft["sent"].get("update"):
        text = f"The user pushed your approved draft {draft_id} ({draft['title']}) onto their PR: {draft['sent']['url']}"
    agents.notify(draft["agent"], text)
    return draft


@router.get("/inbox/{draft_id}/patch")
def download_patch(draft_id: str) -> Response:
    """A PR draft's diff as a .patch file, ready for `git apply`."""
    try:
        draft = inbox.get(draft_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    diff = draft["diff"]
    if not diff:
        raise HTTPException(status_code=400, detail="This draft has no changes.")
    # git apply wants the last line to end with a newline.
    if not diff.endswith("\n"):
        diff = diff + "\n"
    return Response(diff, media_type="text/plain", headers={"Content-Disposition": f'attachment; filename="{draft_id}.patch"'})


@router.get("/evidence/{name}")
def evidence_file(name: str) -> FileResponse:
    """One evidence file. They never change once written, so the browser may keep them."""
    match = re.fullmatch(r"ev_[0-9a-f]{6}\.(jpg|png|gif|webp|txt)", name)
    if match is None:
        raise HTTPException(status_code=404, detail="No such evidence.")
    path = EVIDENCE_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No such evidence.")
    # nosniff: the browser takes the type as given, so a text file is never run as a page.
    headers = {"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
    return FileResponse(path, media_type=EVIDENCE_TYPES[match.group(1)], headers=headers)
