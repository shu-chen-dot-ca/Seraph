"""The Artifacts tab of an agent's page: list, look at, upload, download, rename and delete the agent's files
(github_searcher/artifacts.py). The agent itself uses them through its tools, not through here.

A file is served with its own type only when it is a picture (PNG, JPEG, GIF, WebP) or text (as plain text), and
always with nosniff and a sandbox policy, so a file someone put there (an HTML page, an SVG) can never run as part
of the app. Anything else, and anything asked for with download=1, comes as a download.

Uploads stream to disk, one file per request (PUT .../file?path=folder/name), so a big file never sits in
memory; a folder is uploaded as its files, each with its path in it. Nothing is overwritten.
"""

import secrets
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.shared import agents, artifacts
from github_searcher.artifacts import ArtifactsError

router = APIRouter(prefix="/api")

PICTURE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
# Shown as text in the tab; the rest downloads.
TEXT_SUFFIXES = [".txt", ".md", ".log", ".json", ".yaml", ".yml", ".toml", ".csv", ".py", ".js", ".ts", ".tsx", ".sh", ".diff", ".patch", ".html", ".xml", ".svg"]
# The most one uploaded file may hold.
UPLOAD_LIMIT = 2_000_000_000


class PathRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    path: str
    name: str


def check_agent(agent_id: str) -> None:
    if agent_id not in agents.agents:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}")


@router.get("/agents/{agent_id}/artifacts")
def list_artifacts(agent_id: str, path: str = "") -> dict:
    """One folder of the agent's artifacts: {"path", "parent", "entries"}."""
    check_agent(agent_id)
    try:
        return artifacts.list(agent_id, path)
    except ArtifactsError as error:
        raise HTTPException(status_code=404, detail=str(error))


@router.get("/agents/{agent_id}/artifacts/file")
def artifact_file(agent_id: str, path: str, download: bool = False) -> FileResponse:
    check_agent(agent_id)
    try:
        target = artifacts.resolve(agent_id, path)
    except ArtifactsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"{path} is not a file in the artifacts.")
    headers = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "no-store"}
    suffix = target.suffix.lower()
    if not download and suffix in PICTURE_TYPES:
        return FileResponse(target, media_type=PICTURE_TYPES[suffix], headers=headers)
    if not download and suffix in TEXT_SUFFIXES:
        return FileResponse(target, media_type="text/plain; charset=utf-8", headers=headers)
    headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(target.name)}"
    return FileResponse(target, media_type="application/octet-stream", headers=headers)


@router.put("/agents/{agent_id}/artifacts/file")
async def upload_artifact(agent_id: str, path: str, request: Request) -> dict:
    """A new file at path (its folders are made), from the request body as it streams in."""
    check_agent(agent_id)
    try:
        target = artifacts.new_file(agent_id, path)
    except ArtifactsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    # Hidden while it comes in (the listing leaves .incoming- names out), then put in its place.
    temporary = target.with_name(f".incoming-{secrets.token_hex(3)}")
    size = 0
    try:
        with open(temporary, "wb") as file:
            async for chunk in request.stream():
                size += len(chunk)
                if size > UPLOAD_LIMIT:
                    raise HTTPException(status_code=413, detail=f"{target.name} is over {UPLOAD_LIMIT // 1_000_000_000} GB.")
                file.write(chunk)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    artifacts.changed(agent_id)
    return {"path": artifacts.name_of(agent_id, target)}


@router.post("/agents/{agent_id}/artifacts/folder")
def make_folder(agent_id: str, body: PathRequest) -> dict:
    check_agent(agent_id)
    try:
        artifacts.make_folder(agent_id, body.path)
    except ArtifactsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/agents/{agent_id}/artifacts/rename")
def rename_artifact(agent_id: str, body: RenameRequest) -> dict:
    check_agent(agent_id)
    try:
        artifacts.rename(agent_id, body.path, body.name)
    except ArtifactsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/agents/{agent_id}/artifacts/delete")
def delete_artifact(agent_id: str, body: PathRequest) -> dict:
    """A file, or a folder with everything in it."""
    check_agent(agent_id)
    try:
        artifacts.delete(agent_id, body.path)
    except ArtifactsError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
