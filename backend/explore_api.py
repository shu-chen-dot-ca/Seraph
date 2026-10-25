"""The Explore page: start and stop a run, approve or reject what it found, edit the profile, and allow a rejected repo again.

The run itself, its live progress, the found list and the profile are in github_searcher/explore.py; they
reach the browser through /api/live (the explore topic, with the rejections). Explore lives on the event
loop, so its endpoints are `async def`. Approve and reject take many repos at once (the page's multi-select).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import explore, rejections

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


class NameRequest(BaseModel):
    name: str


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


@router.post("/explore/reject")
async def reject_found(body: NamesRequest) -> dict:
    """Take found repos off the list and keep them out for 14 days."""
    return {"rejected": await explore.reject(body.names)}


@router.put("/explore/profile")
async def set_explore_profile(body: ProfileRequest) -> dict:
    """Save the profile: about the user, and their types of repo. Claude plans each type's searches first, so this takes a little while."""
    try:
        await explore.set_profile(body.about, [{"label": each.label, "about": each.about} for each in body.types])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.post("/explore/allow")
def allow_repo(body: NameRequest) -> dict:
    """End a repo's rejection block early: Explore may find it again. Its rejection history stays."""
    try:
        rejections.allow(body.name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    return {}
