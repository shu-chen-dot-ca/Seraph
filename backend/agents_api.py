"""The Agents and Jobs pages: create and delete agents, chat with one, point it at a VM, and create and cancel jobs.

Every endpoint is `async def`: Agents lives on the backend's event loop (each
agent is a Claude conversation driven by an asyncio task). The list of agents
reaches the browser through /api/live; an agent's summary there has its
history_length, and the browser fetches the new entries with /history?since=.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, jobs
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")


class CreateRequest(BaseModel):
    name: str = ""  # Empty: "agent-N".


class MessageRequest(BaseModel):
    text: str


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


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str) -> dict:
    """Stops the agent, takes it out of every VM queue and cancels its open jobs."""
    try:
        await agents.delete(agent_id)
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
    """A chat message from the user. While the agent works, it waits as a pending message."""
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="The message is empty.")
    try:
        agents.send(agent_id, body.text)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")
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
    vm: str | None = None  # None: the agent keeps its target VM.


@router.post("/jobs")
async def create_job(body: JobRequest) -> dict:
    """The user makes a job (kind "task") for an agent; returns the job."""
    try:
        return agents.create_job(body.title, body.instructions.strip(), body.agent, body.vm)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        # No title, an unknown VM, or a different VM for an agent that is already queued for or holding its target VM.
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict:
    """The user drops a job. Its agent is told, so it stops working on it and moves on."""
    try:
        job = jobs.get(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No job {job_id}")
    if job["status"] in ("done", "cancelled"):
        raise HTTPException(status_code=409, detail=f"{job_id} is already {job['status']}.")
    job = jobs.update(job_id, status="cancelled")
    agents.notify(job["agent"], f"The user cancelled {job_id} ({job['title']}). Stop working on it and go on with your other jobs.")
    return job
