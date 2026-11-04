"""The Repositories page's groups and pins (github_searcher/repo_groups.py).

PUT /api/repo_groups   {"groups": [{"name", "repos": ["owner/name", ...]}, ...], "pinned": ["owner/name", ...]}: all of
                       them at once, as the page has them now. 400 on a group name that is empty, too long or used
                       twice, or a repo that isn't "owner/name".

They reach the browser through /api/live (topic "repo_groups").
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import repo_groups

router = APIRouter(prefix="/api")


class Group(BaseModel):
    name: str
    repos: list[str]


class RepoGroupsRequest(BaseModel):
    groups: list[Group]
    pinned: list[str]


@router.put("/repo_groups")
def put_repo_groups(body: RepoGroupsRequest) -> dict:
    try:
        return repo_groups.set([group.model_dump() for group in body.groups], body.pinned)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
