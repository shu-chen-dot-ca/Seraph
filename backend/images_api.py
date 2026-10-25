"""The Images tab on the VMs page: the default image, rename, delete, New image (the image's agent writes its
image.yaml and builds it), Rebuild (image.yaml is built again, no agent), save a VM as an image, what each image has
(its inventory: system, languages, tools, packages), its image.yaml and its agent, and the defaults that go under
every image's image.yaml (the Defaults tab).

The list itself reaches the browser through /api/live (topic "images"). Builds and saves run in the
background and answer at once; the task shows in the list until it is done. Most of this makes Incus
calls that block, so those endpoints are plain `def` (FastAPI runs them in a thread pool). The agent's
endpoints (chat, New image, stopping its build) are `async def`: its turns run on the event loop.
"""

import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.shared import image_agents, images
from sandbox.images import ImagesError, load_inventory

router = APIRouter(prefix="/api")


class RenameRequest(BaseModel):
    name: str


class NewImageRequest(BaseModel):
    name: str
    system: str
    desktop: str
    defaults: bool = True
    comments: str = ""


class DefinitionRequest(BaseModel):
    text: str


class SaveRequest(BaseModel):
    vm: str
    name: str


class MessageRequest(BaseModel):
    text: str


@router.post("/images/{name}/default")
def set_default_image(name: str) -> dict:
    """New VM picks this image first."""
    try:
        images.set_default(name)
    except ImagesError as error:
        raise HTTPException(status_code=404, detail=str(error))
    return {}


@router.put("/images/{name}")
def rename_image(name: str, body: RenameRequest) -> dict:
    """Give it another name. VMs made from it keep pointing at it. Its image.yaml, agent chat and builder VM move along."""
    if image_agents.busy(name):
        raise HTTPException(status_code=409, detail=f"{name}'s agent is working. Wait, or stop it.")
    try:
        if body.name.strip() != name:
            images.rename(name, body.name.strip())
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.delete("/images/{name}")
def delete_image(name: str) -> dict:
    """Only an image no VM was made from (stopped ones count too). Its image.yaml, agent chat and builder VM go too."""
    if image_agents.busy(name):
        raise HTTPException(status_code=409, detail=f"{name}'s agent is working. Wait, or stop it.")
    try:
        images.delete(name)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.get("/images/new/options")
def new_image_options() -> dict:
    """What New image offers: systems and desktops."""
    return images.new_options()


@router.get("/image-defaults")
def image_defaults() -> dict:
    """The defaults that go under every image's image.yaml (unless it says defaults: false), and the app's own first ones."""
    return images.read_defaults()


@router.put("/image-defaults")
def change_image_defaults(body: DefinitionRequest) -> dict:
    """Change the defaults (refused, with the reason, when they aren't right). Images get them at their next Rebuild."""
    try:
        images.write_defaults(body.text)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.post("/images/new")
async def new_image(body: NewImageRequest) -> dict:
    """Starts the new image's agent with what the user picked: it writes image.yaml and builds it. Answers at once."""
    name = body.name.strip()
    try:
        request = images.new_request(name, body.system, body.desktop, body.defaults, body.comments)
        image_agents.build(name, request)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/images/{name}/rebuild")
def rebuild_image(name: str) -> dict:
    """Builds the image from its image.yaml again (no agent), as a task; the new build replaces it. Answers at once."""
    if image_agents.busy(name):
        raise HTTPException(status_code=409, detail=f"{name}'s agent is working. Wait, or stop it.")
    try:
        return images.build(name)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/images/save")
def save_vm_as_image(body: SaveRequest) -> dict:
    """Makes an image from a stopped VM in the background (a few minutes)."""
    try:
        return images.save_vm(body.vm.strip(), body.name.strip())
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/images/{name}/inspect")
def inspect_image(name: str) -> dict:
    """Lists what the image has, in a throwaway VM in the background (about two minutes)."""
    try:
        return images.inspect(name)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.get("/images/inventory/{fingerprint}")
def image_inventory(fingerprint: str) -> dict:
    """Everything an image has, packages included (the live feed only carries a summary). Also for images that are gone."""
    inventory = load_inventory(fingerprint)
    if inventory is None:
        raise HTTPException(status_code=404, detail="That image wasn't inspected.")
    return inventory


@router.get("/images/{name}/definition")
def image_definition(name: str) -> dict:
    """The image's image.yaml now, and a diff from what it was built from. Also for an image still being made."""
    try:
        return images.definition(name)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.put("/images/{name}/definition")
def change_image_definition(name: str, body: DefinitionRequest) -> dict:
    """The user changes the image's image.yaml (refused, with the reason, when it isn't right). A Rebuild applies it."""
    if image_agents.busy(name):
        raise HTTPException(status_code=409, detail=f"{name}'s agent is working on its image.yaml. Wait, or stop it.")
    try:
        images.write_definition(images.find(name)["name"], body.text)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.post("/images/{name}/definition/discard")
def discard_definition_changes(name: str) -> dict:
    """Put image.yaml back to what the image was built from."""
    if image_agents.busy(name):
        raise HTTPException(status_code=409, detail=f"{name}'s agent is working. Wait, or stop it.")
    try:
        images.discard_changes(name)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.get("/images/{name}/agent")
async def image_agent_chat(name: str) -> dict:
    """The image agent's conversation, and whether it is working now."""
    try:
        return image_agents.chat(name)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.post("/images/{name}/agent")
async def message_image_agent(name: str, body: MessageRequest) -> dict:
    """Starts a turn with the message and answers at once; GET the chat to follow it."""
    try:
        image_agents.send(name, body.text)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/images/{name}/agent/stop")
async def stop_image_agent(name: str) -> dict:
    try:
        await image_agents.interrupt(name)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.delete("/images/{name}/agent")
async def clear_image_agent(name: str) -> dict:
    """A new conversation. The image's image.yaml stays as it is."""
    try:
        image_agents.clear(name)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.get("/images/tasks/{task_id}/log", response_class=PlainTextResponse)
def task_log(task_id: str) -> str:
    """The whole log of a build, save or inspect, as it is so far."""
    return images.read_log(task_id)


@router.post("/images/tasks/{task_id}/stop")
async def stop_task(task_id: str) -> dict:
    """The agent's work stops by interrupting the agent (a build it waits for stops too); others are killed."""
    try:
        task = images.get_task(task_id)
        if task["kind"] == "agent":
            await image_agents.interrupt(task["name"])
        else:
            await asyncio.to_thread(images.stop, task_id)
    except ImagesError as error:
        raise HTTPException(status_code=404, detail=str(error))
    return {}


@router.delete("/images/tasks/{task_id}")
def dismiss_task(task_id: str) -> dict:
    """Forget a failed build, save or inspect, and its log."""
    try:
        images.dismiss(task_id)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
