"""The Images tab on the VMs page: the default image, rename, describe, delete, build, and save a VM as an image.

The list itself reaches the browser through /api/live (topic "images"). Building and saving run as
background tasks in sandbox/images.py and answer at once; the task shows in the list until it is
done. Everything here makes Incus calls that block, so the endpoints are plain `def` (FastAPI runs
them in a thread pool).
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from backend.shared import images
from sandbox.images import ImagesError

router = APIRouter(prefix="/api")


class ChangeRequest(BaseModel):
    name: str | None = None  # A new name.
    description: str | None = None


class BuildRequest(BaseModel):
    name: str
    description: str = ""


class SaveRequest(BaseModel):
    vm: str
    name: str
    description: str = ""


@router.post("/images/{name}/default")
def set_default_image(name: str) -> dict:
    """New VM picks this image first."""
    try:
        images.set_default(name)
    except ImagesError as error:
        raise HTTPException(status_code=404, detail=str(error))
    return {}


@router.put("/images/{name}")
def change_image(name: str, body: ChangeRequest) -> dict:
    """Rename it and/or change its description."""
    try:
        if body.description is not None:
            images.set_description(name, body.description.strip())
        if body.name is not None and body.name.strip() != name:
            images.rename(name, body.name.strip())
    except ImagesError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {}


@router.delete("/images/{name}")
def delete_image(name: str) -> dict:
    """VMs made from it keep working; only new VMs can't use it anymore."""
    try:
        images.delete(name)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/images/build")
def build_image(body: BuildRequest) -> dict:
    """Builds with sandbox/image/build.sh in the background (about an hour). An existing name is rebuilt."""
    try:
        return images.build(body.name.strip(), body.description.strip())
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.post("/images/save")
def save_vm_as_image(body: SaveRequest) -> dict:
    """Makes an image from a stopped VM in the background (a few minutes)."""
    try:
        return images.save_vm(body.vm.strip(), body.name.strip(), body.description.strip())
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))


@router.get("/images/tasks/{task_id}/log", response_class=PlainTextResponse)
def task_log(task_id: str) -> str:
    """The whole log of a build or save, as it is so far."""
    return images.read_log(task_id)


@router.post("/images/tasks/{task_id}/stop")
def stop_task(task_id: str) -> dict:
    try:
        images.stop(task_id)
    except ImagesError as error:
        raise HTTPException(status_code=404, detail=str(error))
    return {}


@router.delete("/images/tasks/{task_id}")
def dismiss_task(task_id: str) -> dict:
    """Forget a failed build or save, and its log."""
    try:
        images.dismiss(task_id)
    except ImagesError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
