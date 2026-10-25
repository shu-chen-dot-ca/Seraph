"""The Repos page: remove or reject rows, undo/redo, the repo explorer (file tree, one file, README), and keeping the signals fresh.

Agents and Explore fill the list (github_searcher/agent/work_tools.py, github_searcher/explore.py);
the browser removes rows, rejects them and steps through the undo history. The list reaches the
browser through /api/live, each repo with its signals and score. The explorer reads the default branch
from GitHub through search.py, which caches every answer, so opening a repo or a file again is instant.

Remove only takes repos off the list: Explore may find them again. Reject also blocks them for 14 days
(github_searcher/rejections.py). Both take many repos at once (the page's multi-select), as one undo step.

The signals (github_searcher/repo_signals.py) are kept fresh by keep_signals(), which the app runs in
the background, for the Repos list and the Tracked list alike (the Tracked page shows them as tags under an
open repo): a new repo gets them within SIGNALS_CHECK_SECONDS, and each is fetched again once it is
SIGNALS_REFRESH_SECONDS old (they change slowly).
"""

import asyncio
import base64
import re
import time
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import rejections, repo_signals, repos, tracked
from github_searcher.search import get_contents, get_readme, get_repository, get_tree

router = APIRouter(prefix="/api")

# Bigger files are not shown: GitHub's contents API only sends files up to 1 MB.
MAX_FILE_BYTES = 1024 * 1024
SIGNALS_CHECK_SECONDS = 10
SIGNALS_REFRESH_SECONDS = 24 * 60 * 60
SIGNALS_RETRY_SECONDS = 60 * 60
# Repos whose signals are fetched at the same time in a full round.
SIGNALS_AT_ONCE = 4


class NamesRequest(BaseModel):
    names: list[str]


@router.post("/repos/remove")
def remove_repos(body: NamesRequest) -> dict:
    removed = repos.remove(body.names)
    if not removed:
        raise HTTPException(status_code=404, detail="None of them is in the list.")
    return {"removed": removed}


@router.post("/repos/reject")
def reject_repos(body: NamesRequest) -> dict:
    """Take repos off the list (those that are there) and keep Explore and agents from bringing them back for 14 days."""
    for name in body.names:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
            raise HTTPException(status_code=400, detail=f"{name} is not owner/name.")
    until = ""
    for name in body.names:
        until = rejections.reject(name)["until"]
    removed = repos.remove(body.names)
    return {"removed": removed, "until": until}


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


async def keep_signals() -> None:
    """Runs as long as the backend: fetches signals for repos that have none, or whose are a day old.

    By age, not by when the backend started, so a restart doesn't fetch them all again. A repo that
    fails (GitHub down, the repo gone or renamed) is tried again after SIGNALS_RETRY_SECONDS.
    Signals of repos that left both lists are dropped (an undo that brings one back fetches them again).
    """
    failed = []
    failed_since = time.monotonic()
    while True:
        if time.monotonic() - failed_since > SIGNALS_RETRY_SECONDS:
            failed = []
            failed_since = time.monotonic()
        # The Repos list's repos, then the tracked ones not in it.
        names = [item["full_name"] for item in repos.items()]
        for item in tracked.items():
            if item["full_name"] not in names:
                names.append(item["full_name"])
        repo_signals.forget(names)
        known = repo_signals.all()
        old = (datetime.now(UTC) - timedelta(seconds=SIGNALS_REFRESH_SECONDS)).isoformat()
        todo = []
        for name in names:
            if name in failed:
                continue
            # Signals from before activity was counted are as good as missing.
            if name not in known or known[name]["fetched_at"] < old or "activity" not in known[name]:
                todo.append(name)
        for start in range(0, len(todo), SIGNALS_AT_ONCE):
            batch = todo[start:start + SIGNALS_AT_ONCE]
            results = await asyncio.gather(*[repo_signals.refresh(name) for name in batch], return_exceptions=True)
            for name, result in zip(batch, results):
                if isinstance(result, Exception):
                    failed.append(name)
        await asyncio.sleep(SIGNALS_CHECK_SECONDS)
