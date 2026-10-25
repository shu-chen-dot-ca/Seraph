"""The Images tab on the VMs page: the default image, rename, delete, New image (saves its image.yaml, the defaults
with the system, desktop and description picked; nothing is built), Build or Rebuild (image.yaml is built, no agent),
save a VM as an image, what each image has
(its inventory: system, languages, tools, packages), its image.yaml and its agent, and the defaults every new
image.yaml starts as (the Defaults tab). Check runs the mechanical check of either without saving it.

The list itself reaches the browser through /api/live (topic "images"). Builds and saves run in the
background and answer at once; the task shows in the list until it is done. Most of this makes Incus
calls that block, so those endpoints are plain `def` (FastAPI runs them in a thread pool). The image agent's
endpoints (its chat) are `async def`: its turns run on the event loop.
"""

import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.shared import image_agents, images
from sandbox import image_build
from sandbox.images import ImagesError, load_inventory

router = APIRouter(prefix="/api")


class RenameRequest(BaseModel):
    name: str


class NewImageRequest(BaseModel):
    name: str
    system: str
    desktop: str
    description: str = ""


class DefinitionRequest(BaseModel):
    text: str


class CheckRequest(BaseModel):
    text: str
    defaults: bool = False  # the defaults rather than an image.yaml


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
    """Give it another name, built or not. VMs made from it keep pointing at it. Its image.yaml, agent chat and builder
    VM move along."""
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
    """Only an image no VM was made from (stopped ones count too). Its image.yaml, agent chat and builder VM go too.
    Also one never built (its image.yaml)."""
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


@router.post("/image-check")
def check_image_yaml(body: CheckRequest) -> dict:
    """The mechanical check of an image.yaml or the defaults, the same as Save's, without saving: the YAML's keys and
    values, and every step's bash (bash -n, nothing runs). No problems: an empty list."""
    return {"problems": image_build.check_definition(body.text, body.defaults)}


@router.get("/image-defaults")
def image_defaults() -> dict:
    """The defaults every new image.yaml starts as ("" before the user wrote any)."""
    return images.read_defaults()


@router.put("/image-defaults")
def change_image_defaults(body: DefinitionRequest) -> dict:
    """Change the defaults (refused, with the reason, when they aren't right). Only images made from now on start from them."""
    try:
        images.write_defaults(body.text)
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.post("/images/new")
def new_image(body: NewImageRequest) -> dict:
    """Saves the new image's image.yaml: the system, desktop and description picked, then the defaults. Nothing is
    built; it is listed as not built until POST /images/<name>/rebuild."""
    try:
        images.new_image(body.name.strip(), body.system, body.desktop, body.description)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/images/{name}/rebuild")
def rebuild_image(name: str) -> dict:
    """Builds the image from its image.yaml (no agent), as a task; the new build replaces it. Also the first build of
    one never built. Answers at once."""
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
        images.write_definition(name, body.text)
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
    """Stops a build, save or inspect: its processes are killed."""
    try:
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
