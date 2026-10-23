"""The Repos page: remove rows, undo/redo, and the repo explorer (file tree, one file, README).

Agents fill the list (github_searcher/agent/work_tools.py); the browser only
removes rows and steps through the undo history. The list itself reaches the
browser through /api/live. The explorer reads the default branch from GitHub
through search.py, which caches every answer, so opening a repo or a file
again is instant.
"""

import base64
import re

import httpx
from fastapi import APIRouter, HTTPException

from backend.shared import repos
from github_searcher.search import get_contents, get_readme, get_repository, get_tree

router = APIRouter(prefix="/api")

# Bigger files are not shown: GitHub's contents API only sends files up to 1 MB.
MAX_FILE_BYTES = 1024 * 1024


@router.delete("/repos")
def remove_repo(name: str) -> dict:
    removed = repos.remove([name])
    if not removed:
        raise HTTPException(status_code=404, detail=f"{name} is not in the list.")
    return {"removed": removed}


@router.post("/repos/undo")
def undo_repos() -> dict:
    return {"changed": repos.undo()}


@router.post("/repos/redo")
def redo_repos() -> dict:
    return {"changed": repos.redo()}


@router.get("/repos/tree")
def repo_tree(name: str) -> dict:
    """Every file and folder of the default branch in one answer, and the README at the root."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise HTTPException(status_code=400, detail="The repo must be owner/name.")
    owner, repo = name.split("/")
    ref = get_repository(owner, repo)["default_branch"]
    tree = get_tree(owner, repo, ref)

    files = []
    readme = None
    for item in tree["tree"]:
        # "commit" items are submodules: nothing to open.
        if item["type"] not in ("blob", "tree"):
            continue
        files.append({"path": item["path"], "type": item["type"], "size": item.get("size")})
        if readme is not None or item["type"] != "blob" or "/" in item["path"]:
            continue
        if item["path"].lower().startswith("readme"):
            readme = item["path"]
    return {"ref": ref, "files": files, "truncated": tree.get("truncated", False), "readme": readme}


@router.get("/repos/file")
def repo_file(name: str, path: str) -> dict:
    """One file of the default branch. Text comes back as text; binary and big files only say what they are."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise HTTPException(status_code=400, detail="The repo must be owner/name.")
    owner, repo = name.split("/")
    data = get_contents(owner, repo, path)
    if isinstance(data, list):
        raise HTTPException(status_code=400, detail=f"{path} is a folder.")

    size = data.get("size", 0)
    if size > MAX_FILE_BYTES:
        return {"path": path, "text": None, "size": size, "binary": False, "too_big": True}
    # Symlinks and submodules come back without content: nothing to show, like a binary file.
    if data.get("encoding") != "base64":
        return {"path": path, "text": None, "size": size, "binary": True, "too_big": False}
    content = base64.b64decode(data["content"])
    # A NUL byte, or bytes that are not UTF-8, mean a binary file (images, archives, ...).
    if b"\0" in content:
        return {"path": path, "text": None, "size": size, "binary": True, "too_big": False}
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return {"path": path, "text": None, "size": size, "binary": True, "too_big": False}
    return {"path": path, "text": text, "size": size, "binary": False, "too_big": False}


@router.get("/repos/readme")
def repo_readme(name: str) -> dict:
    """The README as markdown, and the branch it is from (for relative links and images)."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise HTTPException(status_code=400, detail="The repo must be owner/name.")
    owner, repo = name.split("/")
    ref = get_repository(owner, repo)["default_branch"]
    try:
        markdown = get_readme(owner, repo)
    except httpx.HTTPStatusError as error:
        if error.response.status_code != 404:
            raise
        markdown = None
    return {"markdown": markdown, "ref": ref}
