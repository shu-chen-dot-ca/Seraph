"""The Dashboard's Problems page (frontend/src/Problems.tsx): what went wrong in how the app made agents work, as the
agents reported it (github_searcher/problems.py, work_tools.py report_problem), so the user fixes them all at one time.

They reach the page through /api/live (topic "problems"); GET /api/problems gives them all too, newest first. POST
/api/problems/close closes the open ones picked (Close all on the page, once they are fixed); they stay on its Closed
tab.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from backend.shared import problems

router = APIRouter(prefix="/api")


class CloseRequest(BaseModel):
    ids: list[str]


@router.get("/problems")
def list_problems() -> list[dict]:
    return problems.list()


@router.post("/problems/close")
def close_problems(body: CloseRequest) -> dict:
    return {"closed": problems.close(body.ids)}
