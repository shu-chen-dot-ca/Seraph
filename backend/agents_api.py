"""The Agents and Jobs pages: create, rename, archive, unarchive and delete agents, chat with one, point it at a VM, give
it priority, and create and cancel jobs, or skip a job's checks (its PR drafted now, without passing tests or a reviewer). An agent that made PRs can't be deleted (409), only archived. A cancel goes on the job's
timeline as "Stopped by you" (github_searcher/jobs.py). The Workspace tab's Papers page adds a paper here too
(/jobs/paper): a reproduce_paper job.

Every endpoint is `async def`: Agents lives on the backend's event loop (each
agent is a Claude conversation driven by an asyncio task). The list of agents
reaches the browser through /api/live; an agent's summary there has its
history_length, and the browser fetches the new entries with /history?since=.
"""

import asyncio
import base64

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, jobs
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")
# The most a paper's PDF may be.
PAPER_LIMIT = 50_000_000


class CreateRequest(BaseModel):
    name: str = ""  # Empty: "agent-N".


class MessageRequest(BaseModel):
    text: str


class QueuedRequest(BaseModel):
    index: int  # where it waits among the user's queued messages, oldest first
    text: str  # its text, to make sure it is that one


class TargetRequest(BaseModel):
    vm: str | None = None


@router.post("/agents")
async def create_agent(body: CreateRequest | None = None) -> dict:
    name = ""
    if body is not None:
        name = body.name.strip()
    try:
        return agents.create(name)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


class RenameRequest(BaseModel):
    name: str


@router.post("/agents/{agent_id}/rename")
async def rename_agent(agent_id: str, body: RenameRequest) -> dict:
    try:
        agents.rename(agent_id, body.name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


class PriorityRequest(BaseModel):
    on: bool


@router.post("/agents/{agent_id}/priority")
async def set_priority(agent_id: str, body: PriorityRequest) -> dict:
    """Gives the agent priority until its tasks are over, or takes it back. 409 for an agent with no tasks going."""
    try:
        agents.set_priority(agent_id, body.on)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str) -> dict:
    """Stops the agent, takes it out of every VM queue and cancels its open jobs."""
    try:
        await agents.delete(agent_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/agents/{agent_id}/archive")
async def archive_agent(agent_id: str) -> dict:
    """Stops the agent, takes it out of every VM queue and cancels its open jobs; its conversation stays."""
    try:
        await agents.archive(agent_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    return {}


@router.post("/agents/{agent_id}/unarchive")
async def unarchive_agent(agent_id: str) -> dict:
    try:
        agents.unarchive(agent_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    return {}


@router.get("/agents/{agent_id}/history")
async def agent_history(agent_id: str, since: int = 0) -> dict:
    """The history entries from index `since` on (a negative `since` counts from the end), and how many there are."""
    try:
        entries = agents.history(agent_id, 0)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    return {"entries": entries[since:], "total": len(entries)}


@router.post("/agents/{agent_id}/message")
async def send_message(agent_id: str, body: MessageRequest) -> dict:
    """A chat message from the user. While the agent works, it waits as a pending message (10 at most)."""
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="The message is empty.")
    try:
        agents.send(agent_id, body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.post("/agents/{agent_id}/queue/cancel")
async def cancel_queued_message(agent_id: str, body: QueuedRequest) -> dict:
    """Takes one of the user's queued messages out before it goes in."""
    try:
        agents.cancel_queued(agent_id, body.index, body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/agents/{agent_id}/interrupt")
async def interrupt_agent(agent_id: str) -> dict:
    try:
        await agents.interrupt(agent_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    return {}


@router.put("/agents/{agent_id}/target_vm")
async def set_target_vm(agent_id: str, body: TargetRequest) -> dict:
    """The VM the agent works on next. It can't change while the agent waits for or holds a VM."""
    try:
        agents.set_target_vm(agent_id, body.vm)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


class JobRequest(BaseModel):
    title: str
    instructions: str = ""
    agent: str | None = None  # None: a new agent is made for it.
    agent_name: str = ""  # The new agent's name. Empty: "agent-N".
    vm: str | None = None  # None: the agent keeps its target VM.


@router.post("/jobs")
async def create_job(body: JobRequest) -> dict:
    """The user makes a job (kind "task") for an agent; returns the job."""
    try:
        return agents.create_job(body.title, body.instructions.strip(), body.agent, body.vm, body.agent_name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        # No title, an unknown VM, a new agent's name already taken, or a different VM for an agent that is already queued for or holding its target VM.
        raise HTTPException(status_code=409, detail=str(error))


class PaperRequest(BaseModel):
    title: str = ""  # Empty: the file's name.
    pdf: str = ""  # The PDF itself, in base64. Empty: it comes from link.
    file_name: str = ""
    link: str = ""  # Where to download the PDF, when there is no file.
    instructions: str = ""
    agent: str | None = None  # None: a new agent is made for it.
    agent_name: str = ""  # The new agent's name. Empty: "agent-N".
    vm: str | None = None  # None: the agent keeps its target VM.


@router.post("/jobs/paper")
async def reproduce_paper(body: PaperRequest) -> dict:
    """The user adds a paper on the Papers page: a reproduce_paper job for an agent; returns the job. The PDF comes with
    the request, or from a link, downloaded here (an arXiv page, arxiv.org/abs/..., gives its PDF)."""
    file_name = body.file_name
    if body.pdf != "":
        try:
            data = base64.b64decode(body.pdf, validate=True)
        except ValueError:
            raise HTTPException(status_code=400, detail="The PDF didn't come through; add it again.")
    elif body.link.strip() != "":
        link = body.link.strip()
        if link.startswith("https://arxiv.org/abs/"):
            link = link.replace("/abs/", "/pdf/", 1)
        try:
            response = await asyncio.to_thread(httpx.get, link, follow_redirects=True, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
        except httpx.HTTPError as error:
            raise HTTPException(status_code=400, detail=f"Could not download it: {error}")
        data = response.content
        if response.status_code != 200 or not data.startswith(b"%PDF"):
            detail = "That link doesn't give a PDF (some sites, like medRxiv, turn apps away). Download it in your browser and add the file instead."
            raise HTTPException(status_code=400, detail=detail)
        file_name = link.split("?")[0].rstrip("/").split("/")[-1]
    else:
        raise HTTPException(status_code=400, detail="Add the paper's PDF, or a link to it.")
    if len(data) > PAPER_LIMIT:
        raise HTTPException(status_code=400, detail=f"The PDF is over {PAPER_LIMIT // 1_000_000} MB.")
    try:
        return agents.reproduce_paper(body.title, file_name, data, body.agent, body.vm, body.instructions.strip(), body.agent_name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        # Not a PDF, an unknown VM, a new agent's name already taken, or a different VM for an agent that is already queued for or holding its target VM.
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/jobs/{job_id}/skip_checks")
async def skip_checks(job_id: str) -> dict:
    """The user lets the job's PR be drafted now: without its tests passing and without a reviewer (work_tools.py
    draft_pr). The draft still waits for their Approve in the Inbox. Its agent is told, so it drafts at once."""
    try:
        job = jobs.get(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No job {job_id}")
    if job["status"] in ("done", "cancelled"):
        raise HTTPException(status_code=409, detail=f"{job_id} is already {job['status']}.")
    jobs.add_timeline(job_id, "status", "Checks skipped by you")
    job = jobs.update(job_id, skip_checks=True)
    agents.notify(
        job["agent"],
        f"The user skipped the checks for {job_id} ({job['title']}): draft its PR now with draft_pr, without waiting for "
        "the tests (stop a test run of it you no longer need with run_stop). It goes straight to the user's Inbox, without a "
        "reviewer, and still waits for their Approve.",
    )
    return job


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict:
    """The user drops a job. Its agent is told, so it stops working on it and moves on."""
    try:
        job = jobs.get(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No job {job_id}")
    if job["status"] in ("done", "cancelled"):
        raise HTTPException(status_code=409, detail=f"{job_id} is already {job['status']}.")
    jobs.add_timeline(job_id, "status", "Stopped by you")
    job = jobs.update(job_id, status="cancelled")
    agents.notify(job["agent"], f"The user cancelled {job_id} ({job['title']}). Stop working on it and go on with your other jobs.")
    return job
