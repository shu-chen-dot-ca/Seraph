"""The Workspace tab's Pull requests (github_searcher/pull_requests.py).

GET /api/pull_requests?view=created|assigned|mentioned|review-requested reads that view's PRs, open and closed, from
GitHub now, with your sign-in. It only reads.
"""

import httpx
from fastapi import APIRouter, HTTPException

from backend.shared import your_repositories
from github_searcher import pull_requests

router = APIRouter(prefix="/api")


@router.get("/pull_requests")
def list_pull_requests(view: str = "created") -> dict:
    try:
        return pull_requests.read(your_repositories, view)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
