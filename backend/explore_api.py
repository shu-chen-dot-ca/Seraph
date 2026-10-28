"""The Explore page: start and stop a run, approve or remove what it found, and edit the profile.

The run itself, its live progress, the found list and the profile are in github_searcher/explore.py; they
reach the browser through /api/live (the explore topic). Explore lives on the event loop, so its endpoints are
`async def`. Approve and remove take many repos at once (the page's multi-select). Remove blocks nothing: a later
run may find the repo again.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import explore

router = APIRouter(prefix="/api")


class StartRequest(BaseModel):
    count: int | None = None  # stop after finding this many repos (None: no limit)
    minutes: int | None = None  # stop after this many minutes (None: no limit)
    workers: int = 6  # candidates checked at the same time
    filters: dict[str, str] = {}  # tag → "include" or "exclude" (explore.py FILTERS)


class RepoType(BaseModel):
    label: str  # its name, the tag repos get
    about: str  # a few words on what it is


class ProfileRequest(BaseModel):
    about: str  # who the user is and what they like
    types: list[RepoType]


class NamesRequest(BaseModel):
    names: list[str]


@router.post("/explore/start")
async def start_explore(body: StartRequest) -> dict:
    try:
        explore.start(body.count, body.minutes, body.workers, body.filters)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/explore/stop")
async def stop_explore() -> dict:
    explore.stop()
    return {}


@router.post("/explore/approve")
async def approve_found(body: NamesRequest) -> dict:
    """Move found repos into the Repos list (one undo step)."""
    return {"added": await explore.approve(body.names)}


@router.post("/explore/remove")
async def remove_found(body: NamesRequest) -> dict:
    """Take found repos off the list. A later run may find them again."""
    return {"removed": explore.remove(body.names)}


@router.put("/explore/profile")
async def set_explore_profile(body: ProfileRequest) -> dict:
    """Save the profile: about the user, and their types of repo. Claude plans each type's searches first, so this takes a little while."""
    try:
        await explore.set_profile(body.about, [{"label": each.label, "about": each.about} for each in body.types])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}
