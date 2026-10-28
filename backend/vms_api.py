"""The VMs pages: create, rename and delete VMs, power, settings, the desktop viewer, a small picture of each VM's
screen (the VMs overview's Desktop card), each VM's queue, the user's side of its notes (what is set up in it; the
Notes tab, see sandbox/vms.py), and copying files between this computer and a VM (the
Resources tab; only the user can, see sandbox/file_transfer.py).

Create, start, stop and restart run in background threads inside
sandbox/vms.py and answer at once; the browser follows the state through
/api/live. Settings and the viewer make Incus calls that block, so those
endpoints are plain `def` (FastAPI runs them in a thread pool). The queue
endpoints are `async def`: they are quick, and taking a VM from an agent
interrupts that agent, which lives on the event loop.
"""

import asyncio
import os
import subprocess
from pathlib import Path

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from backend.shared import agents, images, queue, vms
from sandbox import file_transfer
from sandbox.agent.computer_use import Computer, ComputerError
from sandbox.file_transfer import FileTransferError
from sandbox.images import ImagesError
from sandbox.vm import VMError
from sandbox.vms import VMRecord, VMsError

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

NOVNC_PORT = os.environ["SANDBOX_VM_NOVNC_PORT"]
TERMINAL_PORT = os.environ["SANDBOX_VM_TERMINAL_PORT"]

router = APIRouter(prefix="/api")


class CreateRequest(BaseModel):
    name: str
    image: str = ""  # Empty: the default image.
    cpus: int
    memory_gb: int
    disk_gb: int


class ToggleRequest(BaseModel):
    enabled: bool


class ResourcesRequest(BaseModel):
    cpus: int
    memory_gb: int


class EnvRequest(BaseModel):
    env: dict[str, str]


class AgentRequest(BaseModel):
    agent: str


class NoteRequest(BaseModel):
    text: str


@router.get("/vms/options")
def vm_options() -> dict:
    """CPU, memory and disk choices for the New VM dialog (from .env), and the first free name."""
    return vms.options()


@router.post("/vms")
def create_vm(body: CreateRequest) -> dict:
    """Starts making the VM and answers at once; its status goes from "creating" to "running"."""
    image = body.image.strip() or images.get_default()
    try:
        image = images.find(image)["name"]
        record = vms.create(body.name.strip(), image, body.cpus, body.memory_gb, body.disk_gb)
    except (ImagesError, VMsError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    return vms.summary(record)


class ForkRequest(BaseModel):
    name: str


@router.post("/vms/{name}/fork")
def fork_vm(name: str, body: ForkRequest) -> dict:
    """Copies the stopped VM into a new one and starts it; answers at once, like creating a VM."""
    try:
        record = vms.fork(name, body.name.strip())
    except VMsError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return vms.summary(record)


class RenameRequest(BaseModel):
    name: str


@router.post("/vms/{name}/rename")
async def rename_vm(name: str, body: RenameRequest) -> dict:
    """Gives the VM another name, running or not. Agents aimed at it and the jobs on it follow."""
    new_name = body.name.strip()
    try:
        record = await asyncio.to_thread(vms.rename, name, new_name)
    except VMsError as error:
        raise HTTPException(status_code=400, detail=str(error))
    agents.rename_vm(name, new_name)
    return vms.summary(record)


@router.delete("/vms/{name}")
async def delete_vm(name: str) -> dict:
    """Deletes the VM, then tells the agents that held it or waited for it. Takes a few seconds.

    The VM goes first: if it can't be deleted (busy starting or stopping, or Incus fails), nobody
    lost their place or their target VM. Its queue goes with its record, so after the delete the
    agents in it are in no queue anymore; they are only told (and interrupted) here.
    """
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        await asyncio.to_thread(vms.delete, name)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))

    # Read after the delete: an agent may have joined the queue while it ran.
    for agent_id in [record.holder] + list(record.queue):
        if agent_id is None or agent_id == "user":
            continue
        agents.on_kick(name, agent_id, f"The user deleted {name}; you are in no VM queue anymore.")
    # Agents aimed at this VM aim at nothing now, instead of at a VM that is gone.
    for summary in agents.summaries():
        if summary["target_vm"] != name:
            continue
        agents.set_target_vm(summary["id"], None)
    agents.changed()
    return {}


@router.post("/vms/{name}/start")
def start_vm(name: str) -> dict:
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        vms.start_in_background(name)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/vms/{name}/stop")
def stop_vm(name: str) -> dict:
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        vms.stop_in_background(name)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/vms/{name}/restart")
def restart_vm(name: str) -> dict:
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        vms.restart_in_background(name)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/vms/{name}/traffic/reset")
def reset_traffic(name: str) -> dict:
    """Count the VM's internet use from zero again."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    record.reset_traffic()
    return {}


@router.post("/vms/{name}/notes")
def add_note(name: str, body: NoteRequest) -> dict:
    """The user notes something about what is set up in the VM (the Notes tab). The live feed shows it."""
    try:
        record = vms.get(name)
        return record.add_note(body.text, "user")
    except VMsError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.delete("/vms/{name}/notes/{note_id}")
def remove_note(name: str, note_id: str) -> dict:
    """The user takes a note off, theirs or an agent's."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    record.remove_notes([note_id], "user")
    return {}


@router.get("/vms/{name}/viewer")
def vm_viewer(name: str) -> dict:
    """Where the browser finds the VM's desktop (noVNC), or its terminal (ttyd) when it has no desktop.

    The browser loads it straight from the VM's address on the Incus bridge,
    which only this machine can reach.
    """
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    if record.vm.status() != "Running":
        raise HTTPException(status_code=409, detail="The VM is off.")
    address = record.vm.address()
    if address is None:
        raise HTTPException(status_code=409, detail="The VM has no address yet.")
    # A terminal-only image: terminal 1, the same tmux session every time.
    if not record.vm.has_desktop():
        return {"desktop": None, "terminal": f"http://{address}:{TERMINAL_PORT}/?arg=1"}
    # bell=off: no ding in the browser each time the desktop beeps (e.g. while the agent types).
    desktop = f"http://{address}:{NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000&bell=off"
    return {"desktop": desktop, "terminal": None}


@router.get("/vms/{name}/screen")
def vm_screen(name: str) -> Response:
    """A small JPEG of the VM's screen right now, for the Desktop card on the VMs overview. Only looks: nothing
    reaches the desktop. 409 while the desktop isn't up (off, booting, or a terminal-only image)."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        jpeg = Computer(record.vm).preview()
    except (ComputerError, subprocess.TimeoutExpired) as error:
        raise HTTPException(status_code=409, detail=str(error))
    # Always a new picture: the card asks again every few seconds.
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/vms/{name}/settings")
def vm_settings(name: str) -> dict:
    """The Settings tab. Unlike the live feed, this has the env values (the user set them)."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    return {
        "cpus": record.cpus,
        "memory_gb": record.memory_gb,
        "disk_gb": record.disk_gb,
        "internet": record.internet,
        "autostart": record.autostart,
        "env": record.env,
    }


@router.put("/vms/{name}/internet")
def set_internet(name: str, body: ToggleRequest) -> dict:
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        record.set_internet(body.enabled)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return {}


@router.put("/vms/{name}/autostart")
def set_autostart(name: str, body: ToggleRequest) -> dict:
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        record.set_autostart(body.enabled)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return {}


@router.put("/vms/{name}/resources")
def set_resources(name: str, body: ResourcesRequest) -> dict:
    """CPU and memory; they only change while the VM is stopped."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        record.set_resources(body.cpus, body.memory_gb)
    except VMsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return {}


@router.put("/vms/{name}/env")
def set_env(name: str, body: EnvRequest) -> dict:
    """The VM's env vars (secrets). Agents only ever see the names."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        record.set_env(body.env)
    except VMsError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return {}


@router.get("/vms/global_env")
def get_global_env() -> dict:
    """The env vars for all VMs, with their values, for the Settings dialog (the user set them)."""
    return {"env": VMRecord.global_env}


@router.put("/vms/global_env")
def set_global_env(body: EnvRequest) -> dict:
    """The env vars for all VMs (secrets). Running VMs get them now; agents only ever see the names.

    "failed" lists the running VMs they could not be written to, each with why.
    """
    try:
        failed = vms.set_global_env(body.env)
    except VMsError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {"failed": failed}


@router.get("/computer/files")
def computer_files(path: str = "") -> dict:
    """A folder on this computer for the Resources tab. Empty: the home folder."""
    try:
        return file_transfer.list_computer(path)
    except FileTransferError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.get("/vms/{name}/files")
def vm_files(name: str, path: str = "") -> dict:
    """A folder in the VM for the Resources tab, as its desktop user sees it. Empty: their home."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    if record.vm.status() != "Running":
        raise HTTPException(status_code=409, detail="The VM is off.")
    try:
        return file_transfer.list_vm(record.vm, path)
    except FileTransferError as error:
        raise HTTPException(status_code=400, detail=str(error))


class CopyRequest(BaseModel):
    to: str  # "vm" or "computer"
    source: str  # The file or folder, on the other side.
    target_dir: str  # The folder it goes in.


@router.post("/vms/{name}/files/copy")
def copy_files(name: str, body: CopyRequest) -> dict:
    """Copies a file or folder between this computer and the VM. Answers once it is copied (a big folder takes minutes)."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    if record.vm.status() != "Running":
        raise HTTPException(status_code=409, detail="The VM is off.")
    try:
        if body.to == "vm":
            file_transfer.to_vm(record.vm, body.source, body.target_dir)
        elif body.to == "computer":
            file_transfer.to_computer(record.vm, body.source, body.target_dir)
        else:
            raise FileTransferError('to must be "vm" or "computer"')
    except FileTransferError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.put("/vms/{name}/lock")
def set_lock(name: str, body: ToggleRequest) -> dict:
    """The user locks or unlocks their mouse and keyboard. Unlocking also ends a lock the agent set."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    record.locked_by = "user" if body.enabled else None
    # locked_by is not saved on disk, so no save tells the live feed; this does.
    vms.changed()
    return {"locked_by": record.locked_by}


@router.post("/vms/{name}/take_over")
async def take_over(name: str) -> dict:
    """The user takes the VM. An agent holding it goes back to the front of the queue."""
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    queue.take_over(name)
    return {}


@router.post("/vms/{name}/release")
async def release(name: str) -> dict:
    """The user gives back the VM they took over; the next agent in the queue gets it."""
    try:
        record = vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    if record.holder != "user":
        raise HTTPException(status_code=409, detail="You don't hold this VM.")
    queue.release(name, "user")
    return {}


@router.post("/vms/{name}/give")
async def give(name: str, body: AgentRequest) -> dict:
    """The user hands the VM to a waiting agent now. An agent holding it goes back to the front of the queue."""
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        queue.give_to(name, body.agent)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/vms/{name}/front")
async def move_to_front(name: str, body: AgentRequest) -> dict:
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        queue.move_to_front(name, body.agent)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/vms/{name}/remove")
async def remove_from_queue(name: str, body: AgentRequest) -> dict:
    """Takes an agent out of the queue, or takes the VM from it if it holds it. Either way it is interrupted."""
    try:
        vms.get(name)
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    try:
        queue.remove(name, body.agent)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
