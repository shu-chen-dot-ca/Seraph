"""The Workflow tab's API (frontend/src/Workflow.tsx) and its rounds: your own repositories that agents develop one
confined issue at a time, each as a pull request the review agent checks (github_searcher/workflow.py).

POST   /api/workflow                                   Add a repository by its GitHub link: a VM for it, then its agents
PUT    /api/workflow/{owner}/{name}                    Its settings: on, prs_on, decides, agents
DELETE /api/workflow/{owner}/{name}                    Remove it: its agents are archived (their open jobs cancelled);
                                                       the VM stays, for the VMs page
POST   /api/workflow/{owner}/{name}/issues             A new issue, by you
POST   /api/workflow/{owner}/{name}/issues/{n}/close   Close an issue, by you: its job is cancelled
POST   /api/workflow/{owner}/{name}/issues/{n}/retry   Try again: a stopped issue is given out again
GET    /api/workflow/{owner}/{name}/pulls/{n}          A pull request with what it is made of (diff, text, overview,
                                                       evidence, test runs)
POST   /api/workflow/{owner}/{name}/pulls/{n}/merge    Merge it, by you (only once it is reviewed)
POST   /api/workflow/{owner}/{name}/pulls/{n}/reject   Reject it, by you, with why; close_issue closes its issue too

keep_workflow(), which the app runs in the background, makes a round for every repository every TICK_SECONDS, and at
once when there is work (Workflow.wake: a new issue or pull request, a review done):
1. its agents (workflow_agents): the chat agent, as many workers as it asks for and the review agent, made when missing
   (archived ones come back; extra workers are archived, their issues given out again);
2. GitHub: with issues there, open issues that aren't known yet come in (to be written down by their worker), and known
   open ones closed there are closed (an open job on one is cancelled). Either way pull requests opened there by hand
   come in for the review agent; one with new commits since its review is reviewed again; a known one merged or closed
   on GitHub is marked so; a waiting one's checks are read;
3. its issues' jobs: one cancelled, or done with no merge, stops its issue (Try again gives it out again). While it is
   on, each free worker gets the next open issue nobody has, the oldest first (give_issue);
4. each pull request waiting for review goes to the review agent, as a review job (give_review);
5. when the review agent decides (decides "agent"): its advice on each reviewed pull request is carried out. A merge
   waits while GitHub's checks run; failing checks reject a worker's pull request. After MAX_AGENT_REJECTS of its
   rejections for one issue, the issue stops, for you to look at.
A round that fails keeps why in the repository's "error" and is tried again next time.

Merging (merge_pr, by you or the review agent) puts the pull request on the default branch (Workflow.merge); its issue
is closed as done, its worker's job is done. A conflict there rejects it instead, and its worker makes it again on the
newest code. Rejecting (reject_pr) closes it (on GitHub too, with why when the repository's messages are there); its
worker hears why and makes it again, unless its issue was closed with it.
"""

import asyncio
import re
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, images, jobs, projects, vms, workflow, your_repositories
from github_searcher.projects import SELF_REPO
from github_searcher.workflow import DECIDES, PRS_ON, Conflict
from sandbox.images import ImagesError
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")

TICK_SECONDS = 60
# The repository's VM: big enough for its workers, its review agent and the app they run, each on a desktop of its own.
VM_CPUS = 8
VM_DISK_GB = 96
# An issue just opened on GitHub may not be in GitHub's list for a moment: only older ones count as closed there.
LIST_LAG = timedelta(minutes=3)
# When the review agent decides: after this many of its rejections for one issue, the issue stops, for you to look at.
MAX_AGENT_REJECTS = 3
# Set to run a round now.
wanted = asyncio.Event()


class AddRequest(BaseModel):
    url: str
    prs_on: str = "seraph"
    decides: str = "you"


class SettingsRequest(BaseModel):
    on: bool | None = None
    prs_on: str | None = None
    decides: str | None = None
    agents: int | None = None


class IssueRequest(BaseModel):
    title: str
    goal: str = ""
    requirements: list[str] = []
    validation: str = ""


class CloseRequest(BaseModel):
    why: str = ""


class RejectRequest(BaseModel):
    reason: str = ""
    close_issue: bool = False


@router.post("/workflow")
async def add(body: AddRequest) -> dict:
    """Add: the repository from its GitHub link (one you can push to), a VM for it (named after it, from the default
    image, VM_CPUS, the most memory and desktops allowed, the default memory when this computer hasn't that much free),
    then its agents."""
    text = body.url.strip()
    match = re.fullmatch(r"(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?(?:[?#].*)?", text)
    if match is None:
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?", text)
    if match is None:
        raise HTTPException(status_code=400, detail="That isn't a link to a repository on GitHub, like https://github.com/owner/name.")
    if body.prs_on not in PRS_ON or body.decides not in DECIDES:
        raise HTTPException(status_code=400, detail="Pull requests are in Seraph or on GitHub, and you or the review agent decides.")
    # A renamed or moved repository answers with where it is now: followed, so it is added by its name now.
    try:
        with your_repositories.client() as client:
            response = await asyncio.to_thread(client.get, f"/repos/{match.group(1)}/{match.group(2)}", follow_redirects=True)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="GitHub has no such repository, or your account can't see it.")
    if response.status_code != 200:
        raise HTTPException(status_code=400, detail=f"GitHub answered {response.status_code}: {response.text[:200]}")
    data = response.json()
    repo = data["full_name"]
    if not data.get("permissions", {}).get("push"):
        raise HTTPException(status_code=403, detail=f"You can't push to {repo}: only your own repositories go here.")
    if workflow.get(repo) is not None:
        raise HTTPException(status_code=409, detail=f"{repo} is on the Workflow tab already.")
    if body.prs_on == "github" and projects.get(repo) is not None:
        raise HTTPException(status_code=409, detail=f"{repo}'s Development works on its GitHub issues already: keep its pull requests in Seraph here.")

    # Named after the repo (the app's own: seraph): lower case, only a-z, 0-9 and -, starting with a letter, with
    # -workflow, and -2, -3, ... when taken.
    base = re.sub(r"[^a-z0-9-]+", "-", repo.split("/")[1].lower())
    if repo.lower() == SELF_REPO.lower():
        base = "seraph"
    base = re.sub(r"^[^a-z]+", "", base)[:20].strip("-") or "repo"
    base += "-workflow"
    names = [each.name for each in vms.list()]
    vm_name = base
    number = 2
    while vm_name in names:
        vm_name = f"{base}-{number}"
        number += 1
    options = vms.options()
    cpus = options["cpus_default"]
    if VM_CPUS in options["cpus"]:
        cpus = VM_CPUS
    disk = min(max(options["disk_gb_default"], VM_DISK_GB), options["disk_gb_max"])
    # The default image; when that one is gone, the one the other VMs are made from.
    image = None
    try:
        image = images.find(images.get_default())["name"]
    except ImagesError:
        for vm_record in vms.list():
            if image is None and vm_record.image in images.names():
                image = vm_record.image
    if image is None:
        raise HTTPException(status_code=400, detail=f"There is no image {images.get_default()}: pick a default image on the VMs page (Images).")
    try:
        await asyncio.to_thread(vms.create, vm_name, image, cpus, max(options["memory_gb"]), disk, max(options["desktops"]))
    except VMsError as error:
        if not str(error).startswith("Not enough free memory"):
            raise HTTPException(status_code=400, detail=str(error))
        try:
            await asyncio.to_thread(vms.create, vm_name, image, cpus, options["memory_gb_default"], disk, max(options["desktops"]))
        except VMsError as error:
            raise HTTPException(status_code=400, detail=str(error))

    try:
        workflow.create(repo, vm_name, body.prs_on, body.decides)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    workflow_agents(repo)
    wanted.set()
    return workflow.get(repo)


@router.put("/workflow/{owner}/{name}")
async def settings(owner: str, name: str, body: SettingsRequest) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None:
        raise HTTPException(status_code=404, detail=f"{repo} isn't on the Workflow tab.")
    fields = {}
    if body.on is not None:
        fields["on"] = body.on
    if body.prs_on is not None:
        if body.prs_on == "github" and projects.get(repo) is not None:
            raise HTTPException(status_code=409, detail=f"{repo}'s Development works on its GitHub issues already: keep its pull requests in Seraph here.")
        fields["prs_on"] = body.prs_on
    if body.decides is not None:
        fields["decides"] = body.decides
    if body.agents is not None:
        fields["agents"] = body.agents
    try:
        updated = workflow.update(repo, **fields)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    if updated["agents"] != record["agents"] or updated["on"] != record["on"] or updated["decides"] != record["decides"]:
        workflow_agents(repo)
        wanted.set()
    return workflow.get(repo)


@router.delete("/workflow/{owner}/{name}")
async def remove(owner: str, name: str) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None:
        raise HTTPException(status_code=404, detail=f"{repo} isn't on the Workflow tab.")
    for agent_id in [record["chat"], record["reviewer"]] + record["workers"]:
        if agent_id in agents.agents:
            await agents.archive(agent_id)
    workflow.remove(repo)
    return {"ok": True}


@router.post("/workflow/{owner}/{name}/issues")
async def new_issue(owner: str, name: str, body: IssueRequest) -> dict:
    """Your own issue. Without requirements its worker writes them down from it first (issue_scope)."""
    repo = f"{owner}/{name}"
    if workflow.get(repo) is None:
        raise HTTPException(status_code=404, detail=f"{repo} isn't on the Workflow tab.")
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Give the issue a title.")
    requirements = [item.strip() for item in body.requirements if item.strip()]
    fields = {"title": title, "goal": body.goal.strip(), "requirements": requirements, "validation": body.validation.strip(), "by": "you", "found_in": None}
    try:
        issue = await asyncio.to_thread(workflow.add_issue, repo, fields)
    except (ValueError, KeyError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    wanted.set()
    return issue


@router.post("/workflow/{owner}/{name}/issues/{number}/close")
async def close_issue(owner: str, name: str, number: int, body: CloseRequest) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None or str(number) not in record["issues"]:
        raise HTTPException(status_code=404, detail=f"No issue #{number} in {repo}.")
    issue = record["issues"][str(number)]
    if issue["state"] != "open":
        raise HTTPException(status_code=400, detail=f"#{number} is closed already.")
    waiting = [pr for pr in record["prs"].values() if pr["issue"] == number and pr["state"] in ["review", "waiting"]]
    if waiting:
        raise HTTPException(status_code=400, detail=f"Its pull request #{waiting[0]['number']} is open: reject it with Close the issue too.")
    try:
        await asyncio.to_thread(workflow.close_issue, repo, number, "by_you", body.why.strip())
    except (ValueError, KeyError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    stop_job(issue, f"The user closed #{number}" + (f": {body.why.strip()}" if body.why.strip() else "."))
    wanted.set()
    return {"ok": True}


@router.post("/workflow/{owner}/{name}/issues/{number}/retry")
async def retry(owner: str, name: str, number: int) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None or str(number) not in record["issues"]:
        raise HTTPException(status_code=404, detail=f"No issue #{number} in {repo}.")
    issue = record["issues"][str(number)]
    if issue["state"] != "open" or not issue["stopped"]:
        raise HTTPException(status_code=400, detail=f"#{number} isn't stopped.")
    workflow.set_issue(repo, number, {"stopped": False, "agent": None, "job": None})
    wanted.set()
    return {"ok": True}


@router.get("/workflow/{owner}/{name}/pulls/{number}")
async def pull(owner: str, name: str, number: int) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None or str(number) not in record["prs"]:
        raise HTTPException(status_code=404, detail=f"No pull request #{number} in {repo}.")
    pr = record["prs"][str(number)]
    parts = await asyncio.to_thread(workflow.parts, pr["id"])
    return {"pr": pr, "parts": parts}


@router.post("/workflow/{owner}/{name}/pulls/{number}/merge")
async def merge(owner: str, name: str, number: int) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None or str(number) not in record["prs"]:
        raise HTTPException(status_code=404, detail=f"No pull request #{number} in {repo}.")
    pr = record["prs"][str(number)]
    if pr["state"] == "review":
        raise HTTPException(status_code=400, detail="It is still in review: every pull request is reviewed before it is merged.")
    if pr["state"] != "waiting":
        raise HTTPException(status_code=400, detail=f"It is {pr['state']} already.")
    try:
        await merge_pr(repo, number, "you", "")
    except Conflict as error:
        raise HTTPException(status_code=409, detail=f"{error} Its worker makes it again on the newest code.")
    except (ValueError, KeyError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    wanted.set()
    return {"ok": True}


@router.post("/workflow/{owner}/{name}/pulls/{number}/reject")
async def reject(owner: str, name: str, number: int, body: RejectRequest) -> dict:
    repo = f"{owner}/{name}"
    record = workflow.get(repo)
    if record is None or str(number) not in record["prs"]:
        raise HTTPException(status_code=404, detail=f"No pull request #{number} in {repo}.")
    if record["prs"][str(number)]["state"] not in ["review", "waiting"]:
        raise HTTPException(status_code=400, detail=f"It is {record['prs'][str(number)]['state']} already.")
    try:
        await reject_pr(repo, number, "you", body.reason.strip(), body.close_issue)
    except (ValueError, KeyError, httpx.HTTPError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    wanted.set()
    return {"ok": True}


def stop_job(issue: dict, why: str) -> None:
    """The issue's open job ends (cancelled), and its worker hears why."""
    if issue["job"] is None:
        return
    try:
        job = jobs.get(issue["job"])
    except KeyError:
        return
    if job["status"] in ["done", "cancelled"]:
        return
    jobs.update(job["id"], status="cancelled", notes=why)
    agents.notify(job["agent"], f"{why} So {job['id']} is cancelled: stop working on it and go on with your other jobs.")


def tell(agent_id: str | None, text: str) -> None:
    """A message for an agent's next turn, without a turn of its own just for it."""
    if agent_id not in agents.agents:
        return
    agents.pending[agent_id].append({"from": "System", "text": text, "shown": False})
    agents.save(agents.agents[agent_id])
    agents.version += 1


async def merge_pr(repo: str, number: int, by: str, reason: str) -> None:
    """Merge a reviewed pull request (by "you" or "agent"), then close its issue as done and end its worker's job. A
    worker's one that conflicts is rejected instead, to be made again; the Conflict goes on to the caller."""
    record = workflow.get(repo)
    pr = record["prs"][str(number)]
    try:
        await asyncio.to_thread(workflow.merge, repo, number)
    except Conflict as error:
        if pr["by"] == "you":
            workflow.set_pr(repo, number, {"error": str(error)})
            raise
        await reject_pr(repo, number, by, "It no longer goes onto the newest code (other changes were merged first): make it again on the newest code.", False)
        raise
    except (ValueError, httpx.HTTPError) as error:
        workflow.set_pr(repo, number, {"error": str(error)})
        raise
    now = datetime.now(UTC).isoformat()
    workflow.set_pr(repo, number, {"state": "merged", "decision": {"by": by, "action": "merge", "reason": reason, "at": now}, "error": ""})
    issue = record["issues"].get(str(pr["issue"])) if pr["issue"] is not None else None
    if issue is not None and issue["state"] == "open":
        try:
            # No comment: on GitHub the pull request's "Fixes #n" says it already.
            await asyncio.to_thread(workflow.close_issue, repo, issue["number"], "merged", "")
        except (ValueError, KeyError, httpx.HTTPError):
            # GitHub closes it from that "Fixes #n" anyway; here it is done either way.
            workflow.set_issue(repo, issue["number"], {"state": "closed", "reason": "merged", "closed_at": now})
        workflow.set_issue(repo, issue["number"], {"why": f"Done in #{number}."})
    if pr["job"] is not None:
        try:
            if jobs.get(pr["job"])["status"] not in ["done", "cancelled"]:
                jobs.update(pr["job"], status="done", notes=f"Merged as #{number}.")
        except KeyError:
            pass
    who = "the user" if by == "you" else "the review agent"
    tell(pr["agent"], f"Your pull request #{number} ({pr['title']}) in {repo} was merged by {who}. {pr['job']} is done.")


async def reject_pr(repo: str, number: int, by: str, reason: str, close_issue: bool) -> None:
    """Reject a pull request (by "you" or "agent"), with reason. Closed on GitHub when it is there. Its worker makes it
    again with the reason, or, with close_issue, its issue is closed and the worker stops."""
    record = workflow.get(repo)
    pr = record["prs"][str(number)]
    if pr["github"] is not None:
        comment = ""
        if record["prs_on"] == "github" and reason:
            comment = f"Rejected{' by the review agent' if by == 'agent' else ''}: {reason}"
        status = await asyncio.to_thread(workflow.github_pull, repo, pr["github"])
        if status["state"] == "open":
            await asyncio.to_thread(workflow.close_pr, repo, pr["github"], comment)
    now = datetime.now(UTC).isoformat()
    workflow.set_pr(repo, number, {"state": "rejected", "decision": {"by": by, "action": "reject", "reason": reason, "at": now}})
    # A review still going on is over.
    if pr["review"] is not None and pr["review"]["job"] is not None:
        try:
            if jobs.get(pr["review"]["job"])["status"] not in ["done", "cancelled"]:
                jobs.update(pr["review"]["job"], status="cancelled", notes="The pull request was rejected before the review ended.")
                agents.notify(pr["review"]["agent"], f"#{number} in {repo} was rejected before your review ended, so {pr['review']['job']} is cancelled. Leave it.")
        except KeyError:
            pass
    issue = record["issues"].get(str(pr["issue"])) if pr["issue"] is not None else None
    if issue is None or issue["state"] != "open":
        return
    who = "The user" if by == "you" else "The review agent"
    if close_issue:
        await asyncio.to_thread(workflow.close_issue, repo, issue["number"], "by_you", reason)
        stop_job(issue, f"{who} rejected your pull request #{number} and closed #{issue['number']}" + (f": {reason}" if reason else "."))
        return
    job = None
    if pr["job"] is not None:
        try:
            job = jobs.get(pr["job"])
        except KeyError:
            job = None
    if job is None or job["status"] == "cancelled" or job["agent"] not in agents.agents:
        workflow.set_issue(repo, issue["number"], {"stopped": True})
        return
    jobs.update(job["id"], status="queued")
    text = (
        f"{who} rejected your pull request #{number} ({pr['title']}) in {repo}:\n{reason or '(no reason given)'}\n"
        f"Make it again for #{issue['number']}, as a new pull request ({job['id']} is open again): change what the reason says, "
        "and only that, run the tests again (when: after), new before and after pictures if what they show changed, then "
        "draft_pr. queue_for_vm when you need the VM."
    )
    agents.notify(job["agent"], text)


def workflow_agents(repo: str) -> None:
    """The repository's chat agent, as many workers as it asks for and its review agent, aimed at its VM (the chat agent
    needs none): missing ones are made, archived ones come back, extra workers are archived (their issues go back, for
    the others to take). When it is added and every round."""
    record = workflow.get(repo)
    if record is None:
        return
    base = repo.split("/")[1].lower()
    if repo.lower() == SELF_REPO.lower():
        base = "seraph"
    names = [agent.name for agent in agents.agents.values()]
    vm_names = [vm_record.name for vm_record in vms.list()]

    chat = record["chat"]
    if chat in agents.agents:
        agents.unarchive(chat)
    else:
        agent_name = f"{base}-chat"
        number = 2
        while agent_name in names:
            agent_name = f"{base}-chat-{number}"
            number += 1
        created = agents.create(agent_name)
        names.append(agent_name)
        agent = agents.agents[created["id"]]
        agent.record["workflow"] = record["repo"]
        agent.record["workflow_role"] = "chat"
        agents.save(agent)
        chat = agent.id
        tell(chat, (
            f"You are the chat agent of {record['repo']} on the Workflow tab (see The Workflow tab): the user tells you what "
            "they want, and you write it as issues (issue_create), each one clearly confined goal a worker can do as one "
            "pull request. workflow_status shows where the repository stands."
        ))

    workers = [agent_id for agent_id in record["workers"] if agent_id in agents.agents]
    for agent_id in workers:
        agents.unarchive(agent_id)
    while len(workers) < record["agents"]:
        number = 1
        while f"{base}-worker-{number}" in names:
            number += 1
        created = agents.create(f"{base}-worker-{number}")
        names.append(f"{base}-worker-{number}")
        agent = agents.agents[created["id"]]
        agent.record["workflow"] = record["repo"]
        agent.record["workflow_role"] = "worker"
        if record["vm"] in vm_names:
            agents.set_target_vm(agent.id, record["vm"], by_agent=True)
        agents.save(agent)
        workers.append(agent.id)
    while len(workers) > record["agents"]:
        agent_id = workers.pop()
        for issue in record["issues"].values():
            if issue["agent"] == agent_id and issue["state"] == "open":
                workflow.set_issue(repo, issue["number"], {"agent": None, "job": None})
        agents.loop.create_task(agents.archive(agent_id))

    reviewer = record["reviewer"]
    if reviewer in agents.agents:
        agents.unarchive(reviewer)
    else:
        agent_name = f"{base}-reviewer"
        number = 2
        while agent_name in names:
            agent_name = f"{base}-reviewer-{number}"
            number += 1
        created = agents.create(agent_name)
        agent = agents.agents[created["id"]]
        agent.record["workflow"] = record["repo"]
        agent.record["workflow_role"] = "reviewer"
        if record["vm"] in vm_names:
            agents.set_target_vm(agent.id, record["vm"], by_agent=True)
        agents.save(agent)
        reviewer = agent.id
    workflow.update(repo, chat=chat, workers=workers, reviewer=reviewer)


def give_issue(repo: str, issue: dict, worker: str) -> None:
    """An open issue for a free worker: a fix_issue job with the issue written in it."""
    agents.unarchive(worker)
    agent = agents.agents[worker]
    title = f"Issue #{issue['number']}: {issue['title']}"
    lines = []
    if issue["requirements"]:
        lines = [f"Goal: {issue['goal']}", "Requirements:"] + [f"- {item}" for item in issue["requirements"]] + [f"How to check: {issue['validation']}"]
    vm_name = agent.record["target_vm"]
    job = jobs.create("fix_issue", title, worker, "user", repo=repo, vm=vm_name, instructions="\n".join(lines), agent_name=agent.name)
    text = f"New job {job['id']}: {title}\n{repo} is on the Workflow tab, and this is its next open issue: work on it as in The Workflow tab.\n"
    if issue["requirements"]:
        text += "\n".join(lines) + "\nDo exactly this and nothing more: anything else you find becomes a new issue (issue_create, found_in " + str(issue["number"]) + ")."
    elif issue["url"] is not None:
        text += f"It was opened on GitHub by hand ({issue['url']}): read it (repo_thread {issue['number']}), then write it down with issue_scope before any work."
    else:
        text += f"The user wrote it without requirements: {issue['goal'] or '(only its title)'}\nWrite it down with issue_scope before any work, from what it says and nothing more."
    if issue["found_in"] is not None:
        text += f"\nIt was found while working on #{issue['found_in']}."
    if vm_name is None:
        text += "\nYou have no target VM: pick the VM that suits the job with vms_list and choose_vm, then queue_for_vm when ready."
    else:
        text += f"\nIt is for {vm_name}. Use queue_for_vm when you are ready to reproduce it."
    agents.notify(worker, text)
    workflow.set_issue(repo, issue["number"], {"agent": worker, "job": job["id"], "stopped": False})


def give_review(repo: str, pr: dict, reviewer: str, decides: str) -> None:
    """A pull request for the review agent: a review job."""
    agents.unarchive(reviewer)
    vm_name = agents.agents[reviewer].record["target_vm"]
    title = f"Review #{pr['number']}: {pr['title']}"
    job = jobs.create("review", title, reviewer, "user", repo=repo, vm=vm_name, agent_name=agents.agents[reviewer].name)
    review = {"agent": reviewer, "job": job["id"], "advice": None, "summary": "", "important": [], "checked": "", "evidence": [], "at": datetime.now(UTC).isoformat()}
    workflow.set_pr(repo, pr["number"], {"review": review})
    author = "The user (by hand, on GitHub)"
    if pr["by"] in agents.agents:
        author = agents.agents[pr["by"]].name
    what = f"for #{pr['issue']}" if pr["issue"] is not None else "with no issue"
    text = (
        f"New job {job['id']}: {title}\n{author} made pull request #{pr['number']} {what} in {repo}. Review it as in The "
        f"Workflow tab: pr_read {pr['number']}, then run it in the VM and see its effect yourself, and end with pr_review."
    )
    if decides == "agent":
        text += " The review agent decides on this repository: your advice is carried out as it is."
    else:
        text += " The user decides, with your advice in front of them."
    if vm_name is not None:
        text += f"\nIt is for {vm_name}: queue_for_vm once you have read it."
    agents.notify(reviewer, text)


async def keep_workflow() -> None:
    """Runs as long as the backend: a round for every repository (module docstring)."""
    workflow.wake = wanted.set
    while True:
        try:
            await asyncio.wait_for(wanted.wait(), timeout=TICK_SECONDS)
        except TimeoutError:
            pass
        wanted.clear()
        for record in workflow.list():
            try:
                await run_repo(record["repo"])
                workflow.update(record["repo"], error="")
            except KeyError:
                # Removed in the meantime.
                pass
            except Exception as error:
                try:
                    workflow.update(record["repo"], error=str(error))
                except KeyError:
                    pass


async def run_repo(repo: str) -> None:
    """One round of one repository."""
    workflow_agents(repo)
    record = workflow.get(repo)
    if record is None:
        return

    # 2. GitHub: its issues there, and the pull requests on it.
    if record["prs_on"] == "github":
        open_issues = await asyncio.to_thread(workflow.github_issues, repo)
        numbers = [each["number"] for each in open_issues]
        for each in open_issues:
            if str(each["number"]) not in record["issues"] and str(each["number"]) not in record["prs"]:
                workflow.add_github_issue(repo, each)
        settled = (datetime.now(UTC) - LIST_LAG).isoformat()
        for issue in record["issues"].values():
            if issue["state"] == "open" and issue["url"] is not None and issue["number"] not in numbers and issue["created_at"] < settled:
                await asyncio.to_thread(workflow.close_issue, repo, issue["number"], "on_github", "")
                stop_job(issue, f"#{issue['number']} was closed on GitHub.")
    pulls = await asyncio.to_thread(workflow.github_pulls, repo)
    # A worker's pull request being opened on GitHub right now isn't kept yet: none is taken for one opened by hand then.
    opening = workflow.opening > 0
    record = workflow.get(repo)
    known = {}
    for pr in record["prs"].values():
        if pr["github"] is not None:
            known[pr["github"]] = pr
    open_numbers = [each["number"] for each in pulls]
    for each in pulls:
        if each["draft"]:
            continue
        pr = known.get(each["number"])
        if pr is None and not opening:
            await asyncio.to_thread(workflow.add_github_pr, repo, each)
        elif pr is None:
            continue
        elif pr["by"] == "you" and pr["state"] in ["review", "waiting"] and pr["head"] != each["head"]:
            # New commits since it was read: it is reviewed again.
            if pr["review"] is not None and pr["review"]["job"] is not None:
                try:
                    if jobs.get(pr["review"]["job"])["status"] not in ["done", "cancelled"]:
                        jobs.update(pr["review"]["job"], status="cancelled", notes="New commits came in: it is reviewed again.")
                except KeyError:
                    pass
            await asyncio.to_thread(workflow.add_github_pr, repo, each, pr["number"])
    for pr in known.values():
        if pr["state"] not in ["review", "waiting"]:
            continue
        if pr["github"] in open_numbers:
            if pr["state"] == "waiting":
                status = await asyncio.to_thread(workflow.github_pull, repo, pr["github"])
                workflow.set_pr(repo, pr["number"], {"checks": status["checks"], "mergeable": status["mergeable"]})
            continue
        # Merged or closed on GitHub by hand.
        status = await asyncio.to_thread(workflow.github_pull, repo, pr["github"])
        now = datetime.now(UTC).isoformat()
        if status["state"] == "merged":
            workflow.set_pr(repo, pr["number"], {"state": "merged", "decision": {"by": "you", "action": "merge", "reason": "Merged on GitHub.", "at": now}})
            issue = record["issues"].get(str(pr["issue"])) if pr["issue"] is not None else None
            if issue is not None and issue["state"] == "open":
                workflow.set_issue(repo, issue["number"], {"state": "closed", "reason": "merged", "why": f"Done in #{pr['number']}.", "closed_at": now})
            if pr["job"] is not None:
                try:
                    if jobs.get(pr["job"])["status"] not in ["done", "cancelled"]:
                        jobs.update(pr["job"], status="done", notes=f"Merged as #{pr['number']}, on GitHub.")
                except KeyError:
                    pass
        elif status["state"] == "closed":
            workflow.set_pr(repo, pr["number"], {"state": "closed"})
            issue = record["issues"].get(str(pr["issue"])) if pr["issue"] is not None else None
            if issue is not None and issue["state"] == "open":
                workflow.set_issue(repo, issue["number"], {"stopped": True})
                stop_job(issue, f"Your pull request #{pr['number']} was closed on GitHub.")

    # 3. Its issues' jobs, then the free workers.
    record = workflow.get(repo)
    for issue in record["issues"].values():
        if issue["state"] != "open" or issue["job"] is None or issue["stopped"]:
            continue
        try:
            job = jobs.get(issue["job"])
        except KeyError:
            workflow.set_issue(repo, issue["number"], {"stopped": True})
            continue
        waiting = [pr for pr in record["prs"].values() if pr["issue"] == issue["number"] and pr["state"] in ["review", "waiting"]]
        if job["status"] == "cancelled" or (job["status"] == "done" and not waiting):
            workflow.set_issue(repo, issue["number"], {"stopped": True})
    record = workflow.get(repo)
    if record["on"]:
        free = []
        for issue in sorted(record["issues"].values(), key=lambda each: each["number"]):
            if issue["state"] == "open" and issue["job"] is None and not issue["stopped"]:
                free.append(issue)
        for agent_id in record["workers"]:
            if not free:
                break
            if agent_id not in agents.agents:
                continue
            busy = [job for job in jobs.for_agent(agent_id) if job["status"] in ["queued", "working"]]
            if busy:
                continue
            give_issue(repo, free.pop(0), agent_id)

    # 4. Reviews.
    record = workflow.get(repo)
    if record["reviewer"] in agents.agents:
        for pr in sorted(record["prs"].values(), key=lambda each: each["number"]):
            if pr["state"] != "review":
                continue
            given = pr["review"] is not None and pr["review"]["job"] is not None
            if given:
                try:
                    given = jobs.get(pr["review"]["job"])["status"] not in ["done", "cancelled"]
                except KeyError:
                    given = False
            if not given:
                give_review(repo, pr, record["reviewer"], record["decides"])

    # 5. The review agent's decisions, when it decides.
    record = workflow.get(repo)
    if record["decides"] != "agent":
        return
    for pr in sorted(record["prs"].values(), key=lambda each: each["number"]):
        if pr["state"] != "waiting" or pr["review"] is None or pr["review"]["advice"] is None:
            continue
        if pr["review"]["advice"] == "dont_merge":
            await reject_pr(repo, pr["number"], "agent", "; ".join(pr["review"]["important"]), False)
            after = workflow.get(repo)
            issue = after["issues"].get(str(pr["issue"])) if pr["issue"] is not None else None
            rejected = [each for each in after["prs"].values() if each["issue"] == pr["issue"] and each["state"] == "rejected" and each["decision"] is not None and each["decision"]["by"] == "agent"]
            if issue is not None and issue["state"] == "open" and len(rejected) >= MAX_AGENT_REJECTS:
                workflow.set_issue(repo, issue["number"], {"stopped": True})
                stop_job(issue, f"The review agent rejected {len(rejected)} pull requests for #{issue['number']}, so it stops here for the user to look at.")
            continue
        if pr["github"] is not None:
            if pr["checks"] is None or pr["checks"] == "running" or pr["mergeable"] is None:
                continue
            if pr["checks"] == "failed":
                if pr["by"] != "you":
                    await reject_pr(repo, pr["number"], "agent", "Its checks failed on GitHub: find which and why, and fix it.", False)
                continue
        try:
            await merge_pr(repo, pr["number"], "agent", pr["review"]["summary"])
        except (ValueError, httpx.HTTPError):
            # Kept in the pull request's error; a conflict was rejected to be made again.
            pass
