"""A repo's automation (the robot on its card on the Dashboard's Repository page, and a click on an issue card's logo on
the Issues board: frontend/src/AutomationDialog.tsx), and the part of it that acts so far: Take issues puts the repo's
issues in the Issues board's Catalog by themselves, as an agent picks them.

The settings, by repo, in SETTINGS_FILE (a repo not in it has DEFAULTS):

    {"owner/name": {"take_issues", "questions", "comments", "pull_requests": bool, "levels": ["easy", ...],
                    "instructions": str}, ...}

and an issue's own level (the robot on its card on the Issues board: frontend/src/IssueAutomationDialog.tsx), which goes
over its repo's for the drafts of the jobs on that issue, in ISSUE_SETTINGS_FILE:

    {"owner/name#n": {"questions", "comments", "pull_requests": bool}, ...}

GET /api/repos/automation gives them all with the defaults; PUT /api/repos/automation gives the picked repos the same
ones (the dialog's Save, for one repo or many); PUT /api/issues/automation sets one issue's own, or drops it (level
null: its repo's counts again). Questions, Comments and Pull requests are only kept so far. How many agents work at
once is the Issues board's (max_agents in backend/issues_api.py), not a repo's.

keep_catalog() runs in the background, every CATALOG_CHECK_SECONDS. For each repo with Take issues on, its issues on the
board's Open column (not of an archived repo) that the rules allow: no job (or only cancelled ones), not in Catalog, open, tagged free with merge
likely (issue_tags.py), and a complexity among the repo's issue levels. Claude reads them, up to PER_RUN of one repo in
one run with no tools (claude_judge.py), with DEFAULT_RULES and the repo's instructions on top, and picks which to take;
the picked ones go to the end of Catalog. Each issue is asked about once per basis (the instructions, the levels and its
last change on GitHub), kept in PICKED_FILE: one you take out of Catalog stays out until one of those changes. A failed
run is tried again next round.
"""

import asyncio
import hashlib
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import issue_tags, issues, jobs, repos
from github_searcher.claude_judge import judge
from github_searcher.inbox import AUTOMATION_FILE, ISSUE_AUTOMATION_FILE
from github_searcher.issue_tags import DATA_DIR

router = APIRouter(prefix="/api")

SETTINGS_FILE = AUTOMATION_FILE
ISSUE_SETTINGS_FILE = ISSUE_AUTOMATION_FILE
PICKED_FILE = DATA_DIR / "catalog_picks.json"
DEFAULTS = {
    "take_issues": False,
    "questions": False,
    "comments": False,
    "pull_requests": False,
    "levels": ["easy"],
    "instructions": "",
}
LEVELS = ["easy", "medium", "hard"]
CATALOG_CHECK_SECONDS = 60
# Issues of one repo in one Claude run.
PER_RUN = 40
# Always, under any repo's instructions.
DEFAULT_RULES = (
    "Never take an issue that is political, politically sensitive or activist, that goes against another country's laws, "
    "such as China's, or that is unethical or NSFW."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"number": {"type": "integer"}, "take": {"type": "boolean"}},
                "required": ["number", "take"],
            },
        }
    },
    "required": ["issues"],
}


class AutomationRequest(BaseModel):
    repos: list[str]
    take_issues: bool
    questions: bool
    comments: bool
    pull_requests: bool
    levels: list[str]
    instructions: str


class IssueLevel(BaseModel):
    questions: bool
    comments: bool
    pull_requests: bool


class IssueAutomationRequest(BaseModel):
    id: str  # owner/name#n
    level: IssueLevel | None  # None: its repo's counts again


@router.get("/repos/automation")
def get_automation() -> dict:
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    own = {}
    if ISSUE_SETTINGS_FILE.is_file():
        own = json.loads(ISSUE_SETTINGS_FILE.read_text())
    return {"defaults": DEFAULTS, "repos": settings, "issues": own}


@router.put("/issues/automation")
def put_issue_automation(body: IssueAutomationRequest) -> dict:
    """Set one issue's own level, or drop it (level None); returns every issue's."""
    own = {}
    if ISSUE_SETTINGS_FILE.is_file():
        own = json.loads(ISSUE_SETTINGS_FILE.read_text())
    if body.level is None:
        own.pop(body.id, None)
    else:
        own[body.id] = body.level.model_dump()
    ISSUE_SETTINGS_FILE.write_text(json.dumps(own, indent=2))
    return {"issues": own}


@router.put("/repos/automation")
def put_automation(body: AutomationRequest) -> dict:
    """Give these repos the same settings; returns them all."""
    if not body.repos:
        raise HTTPException(status_code=400, detail="No repository picked.")
    if any(level not in LEVELS for level in body.levels):
        raise HTTPException(status_code=400, detail="The levels are easy, medium and hard.")
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    for repo in body.repos:
        settings[repo] = body.model_dump(exclude={"repos"})
        settings[repo]["instructions"] = body.instructions.strip()
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    return {"defaults": DEFAULTS, "repos": settings}


async def keep_catalog() -> None:
    """Runs as long as the backend: puts the issues an agent picks into Catalog (see the top of this file)."""
    while True:
        try:
            await pick_for_catalog()
        except Exception:
            pass  # Claude or a file failed: the next round tries again.
        await asyncio.sleep(CATALOG_CHECK_SECONDS)


async def pick_for_catalog() -> None:
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    # By repo name in lower case: an issue's repo may be spelled its own way. An archived repo takes nothing.
    archived = [name.lower() for name in repos.archived()]
    by_name = {repo.lower(): rules for repo, rules in settings.items() if repo.lower() not in archived}
    picked = {}
    if PICKED_FILE.is_file():
        picked = json.loads(PICKED_FILE.read_text())
    tags = issue_tags.all()
    catalog = issues.board()["catalog"]
    started = [job["issue"] for job in jobs.list() if job["issue"] is not None and job["status"] != "cancelled"]

    # What the rules allow, by repo: (item, tag, basis).
    candidates = {}
    for item in issues.items():
        rules = by_name.get(item["repo"].lower())
        tag = tags.get(item["id"])
        if rules is None or not rules["take_issues"] or tag is None:
            continue
        if item["id"] in catalog or item["id"] in started or item["state"] == "CLOSED":
            continue
        if tag["status"] != "free" or tag.get("merge") != "likely" or tag.get("complexity") not in rules["levels"]:
            continue
        basis = hashlib.sha256(json.dumps([rules["instructions"], sorted(rules["levels"]), tag["updated_at"]]).encode()).hexdigest()[:16]
        if picked.get(item["id"]) == basis:
            continue
        candidates.setdefault(item["repo"], []).append((item, tag, basis))

    for repo, entries in candidates.items():
        rules = by_name[repo.lower()]
        for start in range(0, len(entries), PER_RUN):
            run = entries[start:start + PER_RUN]
            lines = []
            for item, tag, basis in run:
                lines.append(
                    f"#{item['number']}: {tag.get('name') or item['title']} (GitHub title: {item['title']}; {tag.get('kind')}, "
                    f"{tag.get('complexity')}, about {tag.get('lines')} lines). {tag['reason']}"
                )
            instructions = rules["instructions"] or "None."
            prompt = (
                f"Below are open issues of the GitHub project {repo}. We fix issues of outside projects with our own agents, "
                "and these already passed our checks: nobody else is on them, and a pull request from us would likely get "
                "merged. Pick which ones our agents should take on now.\n\n"
                f"Rules: {DEFAULT_RULES}\n"
                f"The user's instructions for this repo, on top of the rules: {instructions}\n\n"
                "Answer take true or false for every issue, by its number.\n\n" + "\n".join(lines)
            )
            answer = await judge(prompt, SCHEMA, "medium")
            take = [each["number"] for each in answer["issues"] if each["take"]]
            answered = [each["number"] for each in answer["issues"]]
            new = []
            for item, tag, basis in run:
                if item["number"] in answered:
                    picked[item["id"]] = basis
                if item["number"] in take:
                    new.append(item["id"])
            PICKED_FILE.write_text(json.dumps(picked, indent=2))
            # The board as it is now: the user may have moved cards while Claude read.
            board = issues.board()
            added = [issue_id for issue_id in new if issue_id not in board["catalog"]]
            if added:
                issues.set_board(board["catalog"] + added, board["order"], board["held"])
