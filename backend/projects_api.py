"""Projects (github_searcher/projects.py): the Workspace tab repo page's Development and Releases, and the loop that runs
every project. Everything on GitHub here is done as you (your sign-in).

POST /api/projects/{owner}/{name}               Start: the project, its VM and its agents (Agents.start_project)
PUT  /api/projects/{owner}/{name}               its settings: {"on", "mode", "agents", "goals"}, any of them
POST /api/projects/{owner}/{name}/retry/{n}     Try again on an issue whose job was stopped: a worker takes it again
POST /api/projects/{owner}/{name}/reopen/{n}    Reopen an issue a worker denied: a worker takes it again
GET  /api/projects/{owner}/{name}/release       Releases: the releases, what was merged since the latest, the next
                                                version and its notes, and the issues planned for it
POST /api/projects/{owner}/{name}/plan          {"number", "add"}: an issue into or out of the next release
POST /api/projects/{owner}/{name}/release       Release: the next version, as a GitHub release; for the app's own repo
                                                the live copy gets it ready and offers it as Update (updates.py)
POST /api/projects/merge/{draft_id}             Merge: squash-merges the PR an approved draft opened
POST /api/errors                                an error on a page ({"message", "stack", "page"}, frontend/src/main.tsx)

The projects and the app's errors reach the browser through /api/live (topics "projects" and "crashes").

keep_projects(), which the app runs in the background, goes over every project that is on, every TICK_SECONDS and at
once after a Merge:
1. its agents: as many workers as it asks for, and its reviewer (Agents.project_agents);
2. its PRs, the ones Approve opened from its drafts: their checks, and merged or closed. One that is behind main gets
   main merged in (GitHub's Update branch), so its checks run on the newest code; one that conflicts with main goes back
   to its agent to be made again on the new main (Agents.redo_pr), and once the new one is opened the old one is
   closed with a link to it. A merged one makes its issue and job done;
3. its issues: one whose job was cancelled is stopped; one closed on GitHub while a worker had it is closed (an open job
   on it is cancelled, its agent told). Each worker with no queued or working job gets the next open issue nobody has
   (Agents.give_issue): the ones in the next release first, then the oldest. One a worker denied, or that was closed
   while a worker had it, and is open again on GitHub (reopened after that) is taken again;
4. for the app's own repo (projects.SELF_REPO): the new errors go to the chat agent (Agents.give_crashes), when none
   given before is still waiting on it, or SEND_SECONDS after the last ones.
A round that fails (GitHub doesn't answer, you aren't signed in) keeps why in the project's "error" and is tried again
next time.
"""

import asyncio
import re
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, crashes, images, inbox, jobs, projects, updates, vms, your_repositories
from github_searcher.projects import MODES, NEXT_MILESTONE, SELF_REPO
from sandbox.images import ImagesError
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")

NAME = r"[A-Za-z0-9_.-]+"
TICK_SECONDS = 60
SEND_SECONDS = 30 * 60
# The project's VM: big enough for its workers, its reviewer and the app they build, each on a desktop of its own.
PROJECT_CPUS = 8
PROJECT_DISK_GB = 96
# Set to run a round now (after a Merge).
wanted = asyncio.Event()


class SettingsRequest(BaseModel):
    on: bool | None = None
    mode: str | None = None
    agents: int | None = None
    goals: str | None = None


class PlanRequest(BaseModel):
    number: int
    add: bool


class ErrorReport(BaseModel):
    message: str
    stack: str = ""
    page: str = ""


@router.post("/projects/merge/{draft_id}")
async def merge(draft_id: str) -> dict:
    """Squash-merges the PR an approved project draft opened, as you."""
    try:
        draft = inbox.get(draft_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No draft {draft_id}")
    sent = draft["sent"]
    if draft["kind"] != "pr" or sent is None or sent.get("update"):
        raise HTTPException(status_code=400, detail="Only a PR that Approve opened is merged from here.")
    if projects.get(draft["repo"]) is None:
        raise HTTPException(status_code=400, detail=f"{draft['repo']} isn't a project: merge it on GitHub.")
    try:
        await asyncio.to_thread(projects.merge, sent["repo"], sent["number"], draft["title"])
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    wanted.set()
    return {"ok": True}


@router.post("/errors")
def report_error(body: ErrorReport) -> dict:
    crashes.add("browser", body.message, f"{body.page}\n{body.stack}")
    return {"ok": True}


@router.post("/projects/{owner}/{name}")
async def start(owner: str, name: str) -> dict:
    """Start: a VM for the project (named after the repo, from the default image, PROJECT_CPUS, the most memory and
    desktops allowed), the project, then its agents."""
    if re.fullmatch(NAME, owner) is None or re.fullmatch(NAME, name) is None:
        raise HTTPException(status_code=400, detail="That isn't a GitHub repo.")
    repo = f"{owner}/{name}"
    if not your_repositories.is_yours(repo):
        raise HTTPException(status_code=404, detail=f"{repo} isn't one of your repositories.")
    if projects.get(repo) is not None:
        raise HTTPException(status_code=409, detail=f"{repo} is a project already.")

    # Named after the repo: lower case, only a-z, 0-9 and -, starting with a letter, with -dev, and -2, -3, ... when taken.
    base = re.sub(r"[^a-z0-9-]+", "-", name.lower())
    base = re.sub(r"^[^a-z]+", "", base)[:23].strip("-")
    if base == "":
        base = "project"
    base += "-dev"
    names = [each.name for each in vms.list()]
    vm_name = base
    number = 2
    while vm_name in names:
        vm_name = f"{base}-{number}"
        number += 1
    options = vms.options()
    cpus = options["cpus_default"]
    if PROJECT_CPUS in options["cpus"]:
        cpus = PROJECT_CPUS
    disk = min(max(options["disk_gb_default"], PROJECT_DISK_GB), options["disk_gb_max"])
    try:
        image = images.find(images.get_default())["name"]
        await asyncio.to_thread(vms.create, vm_name, image, cpus, max(options["memory_gb"]), disk, max(options["desktops"]))
    except (ImagesError, VMsError) as error:
        raise HTTPException(status_code=400, detail=str(error))

    projects.create(repo, vm_name)
    try:
        agents.start_project(repo, vm_name)
    except (ValueError, VMsError) as error:
        raise HTTPException(status_code=409, detail=str(error))
    wanted.set()
    return projects.get(repo)


@router.put("/projects/{owner}/{name}")
async def settings(owner: str, name: str, body: SettingsRequest) -> dict:
    repo = f"{owner}/{name}"
    project = projects.get(repo)
    if project is None:
        raise HTTPException(status_code=404, detail=f"{repo} isn't a project.")
    fields = {}
    if body.on is not None:
        fields["on"] = body.on
    if body.mode is not None:
        if body.mode not in MODES:
            raise HTTPException(status_code=400, detail=f"mode must be one of: {', '.join(MODES)}")
        fields["mode"] = body.mode
    if body.agents is not None:
        fields["agents"] = body.agents
    if body.goals is not None:
        fields["goals"] = body.goals.strip()
    try:
        updated = projects.update(repo, **fields)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))

    # The chat agent hears what changed for it.
    if updated["mode"] != project["mode"] and updated["mode"] == "auto":
        agents.project_changed(repo, (
            f"The user put {repo} in Auto mode: when they talk about what they want, create the issues yourself (draft_issue "
            "opens them on GitHub at once), only ones that fit their goals (see Developing a project)."
        ))
    if updated["mode"] != project["mode"] and updated["mode"] == "drafts":
        agents.project_changed(repo, f"The user put {repo} in Drafts mode: draft_issue only drafts again, for them to create.")
    if updated["goals"] != project["goals"]:
        agents.project_changed(repo, f"The user's goals for {repo} are now:\n{updated['goals'] or '(none written)'}")
    if updated["on"] != project["on"] and not updated["on"]:
        agents.project_changed(repo, f"The user turned {repo}'s development off: workers take no new issues until it is on again.")
    if updated["agents"] != project["agents"] or updated["on"]:
        agents.project_agents(repo)
        wanted.set()
    return projects.get(repo)


@router.post("/projects/{owner}/{name}/retry/{number}")
async def retry(owner: str, name: str, number: int) -> dict:
    repo = f"{owner}/{name}"
    if projects.get(repo) is None:
        raise HTTPException(status_code=404, detail=f"{repo} isn't a project.")
    projects.drop_issue(repo, number)
    wanted.set()
    return {"ok": True}


@router.post("/projects/{owner}/{name}/reopen/{number}")
async def reopen(owner: str, name: str, number: int) -> dict:
    repo = f"{owner}/{name}"
    if projects.get(repo) is None:
        raise HTTPException(status_code=404, detail=f"{repo} isn't a project.")
    try:
        await asyncio.to_thread(your_repositories.act, repo, "reopen", number, "issue", {})
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    wanted.set()
    return {"ok": True}


@router.get("/projects/{owner}/{name}/release")
async def release_info(owner: str, name: str) -> dict:
    repo = f"{owner}/{name}"
    try:
        return await asyncio.to_thread(projects.release_info, repo)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.post("/projects/{owner}/{name}/plan")
async def plan(owner: str, name: str, body: PlanRequest) -> dict:
    repo = f"{owner}/{name}"
    try:
        await asyncio.to_thread(projects.plan, repo, body.number, body.add)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {"ok": True}


@router.post("/projects/{owner}/{name}/release")
async def release(owner: str, name: str) -> dict:
    repo = f"{owner}/{name}"
    try:
        result = await asyncio.to_thread(projects.release, repo)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    # The app's own repo: the live copy gets it ready now and checks it; Update installs it (updates.py).
    if repo.lower() == SELF_REPO.lower():
        updates.asked = True
    return result


async def keep_projects() -> None:
    """Runs as long as the backend: a round for every project that is on (module docstring)."""
    while True:
        try:
            await asyncio.wait_for(wanted.wait(), timeout=TICK_SECONDS)
        except TimeoutError:
            pass
        wanted.clear()
        for project in projects.list():
            if not project["on"]:
                continue
            try:
                await run_project(project["repo"])
                projects.update(project["repo"], error="")
            except Exception as error:
                projects.update(project["repo"], error=str(error))


async def run_project(repo: str) -> None:
    """One round of one project."""
    agents.project_agents(repo)

    # 2. Its PRs: the new ones Approve opened, then how each open one stands.
    project = projects.get(repo)
    for draft in inbox.list():
        sent = draft["sent"]
        if draft["kind"] != "pr" or draft["repo"] is None or draft["repo"].lower() != repo.lower() or sent is None or sent.get("update"):
            continue
        if str(sent["number"]) in project["prs"]:
            continue
        issue = None
        if draft["job"] is not None:
            try:
                job = jobs.get(draft["job"])
                if job["issue"] is not None:
                    issue = int(job["issue"].split("#")[1])
            except KeyError:
                pass
        fields = {"title": draft["title"], "url": sent["url"], "draft": draft["id"], "job": draft["job"], "agent": draft["agent"], "issue": issue, "replaces": draft["replaces"]}
        projects.set_pr(repo, sent["number"], fields)

    project = projects.get(repo)
    for pr in project["prs"].values():
        if pr["state"] != "open":
            continue
        status = await asyncio.to_thread(projects.pull, repo, pr["number"])
        projects.set_pr(repo, pr["number"], {"state": status["state"], "checks": status["checks"], "mergeable": status["mergeable"]})
        if status["state"] == "merged":
            if pr["issue"] is not None and str(pr["issue"]) in project["issues"]:
                projects.set_issue(repo, pr["issue"], {"state": "done"})
            if pr["job"] is not None:
                try:
                    if jobs.get(pr["job"])["status"] not in ["done", "cancelled"]:
                        jobs.update(pr["job"], status="done")
                except KeyError:
                    pass
            continue
        if status["state"] != "open":
            continue
        # The PR it was made again from is closed once this one is open.
        if pr["replaces"] is not None:
            old = int(pr["replaces"].split("#")[1])
            old_status = await asyncio.to_thread(projects.pull, repo, old)
            if old_status["state"] == "open":
                await asyncio.to_thread(projects.close_pr, repo, old, f"Replaced by #{pr['number']}, the same change made again on the newest main.")
            projects.set_pr(repo, old, {"state": "closed"})
            projects.set_pr(repo, pr["number"], {"replaces": None})
        if status["mergeable"] is False and not pr["redo"]:
            agents.redo_pr(repo, pr)
            projects.set_pr(repo, pr["number"], {"redo": True})
        elif status["behind"] and status["mergeable"] is not False:
            try:
                await asyncio.to_thread(projects.update_branch, repo, pr["number"])
            except ValueError:
                # GitHub couldn't merge main in by itself: it says so as a conflict next time.
                pass

    # 3. Its issues.
    open_issues = await asyncio.to_thread(projects.open_issues, repo)
    open_numbers = [issue["number"] for issue in open_issues]
    project = projects.get(repo)
    for issue in project["issues"].values():
        if issue["state"] != "working":
            continue
        try:
            job = jobs.get(issue["job"])
        except KeyError:
            projects.set_issue(repo, issue["number"], {"state": "stopped"})
            continue
        if job["status"] == "cancelled":
            projects.set_issue(repo, issue["number"], {"state": "stopped"})
        elif job["status"] == "done":
            projects.set_issue(repo, issue["number"], {"state": "done"})
        elif issue["number"] not in open_numbers:
            projects.set_issue(repo, issue["number"], {"state": "closed"})
            jobs.update(job["id"], status="cancelled")
            agents.notify(job["agent"], f"#{issue['number']} was closed on GitHub, so {job['id']} is cancelled. Stop working on it and go on with your other jobs.")

    project = projects.get(repo)
    candidates = []
    for issue in open_issues:
        known = project["issues"].get(str(issue["number"]))
        if known is None:
            candidates.append((issue, False))
        elif known["state"] in ["denied", "closed"] and issue["updated_at"] > known["at"]:
            candidates.append((issue, True))
    # The next release's first, then the oldest (open_issues is oldest first, and sorting keeps that order).
    candidates.sort(key=lambda candidate: candidate[0]["milestone"] != NEXT_MILESTONE)
    for agent_id in project["workers"]:
        if not candidates:
            break
        if agent_id not in agents.agents:
            continue
        busy = [job for job in jobs.for_agent(agent_id) if job["status"] in ["queued", "working"]]
        if busy:
            continue
        issue, again = candidates.pop(0)
        job = agents.give_issue(repo, issue, agent_id, again)
        fields = {"title": issue["title"], "state": "working", "job": job["id"], "agent": agent_id, "kind": None, "why": ""}
        projects.set_issue(repo, issue["number"], fields)

    # 4. The app's own errors.
    if repo.lower() != SELF_REPO.lower() or project["chat"] not in agents.agents:
        return
    items = crashes.list()
    new = [item for item in items if item["state"] == "new"]
    waiting = [item for item in items if item["state"] == "sent"]
    due = True
    if project["crashes_sent_at"] is not None and waiting:
        due = (datetime.now(UTC) - datetime.fromisoformat(project["crashes_sent_at"])).total_seconds() > SEND_SECONDS
    if not new or not due:
        return
    agents.give_crashes(repo, new)
    crashes.mark([item["id"] for item in new], "sent")
    projects.update(repo, crashes_sent_at=datetime.now(UTC).isoformat())
