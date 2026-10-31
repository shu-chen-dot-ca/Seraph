"""A repository's Live tab on the Workspace tab (frontend/src/RepoLive.tsx): the repo running in a VM of its own, next
to a chat with its agent (Agents.set_up_live), and the issues that agent drafts (github_searcher/issue_drafts.py).

POST /api/repo_live/{owner}/{name} is Set up: a new VM for the repo (named after it, from the default image, with the
default CPUs, memory and disk), then its agent, which gets the code into the VM and sets the repo up there
(Agents.prepare_live). After a failed set-up it is Try again: on the same VM, or on a new one when that one is gone.
The agent and how far its set-up is reach the browser through /api/live (topic "agents": its "repo" and "live").

POST /api/issue_drafts/{draft_id}/create opens a draft on GitHub as you (your_repositories.act "new_issue", with its
labels), and POST /api/issue_drafts/{draft_id}/discard drops it; either tells its agent (Agents.issue_decided). Each
draft is decided once. The drafts reach the browser through /api/live (topic "issue_drafts").
"""

import asyncio
import re

import httpx
from fastapi import APIRouter, HTTPException

from backend.shared import agents, images, issue_drafts, vms, your_repositories
from sandbox.images import ImagesError
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")

NAME = r"[A-Za-z0-9_.-]+"
# One Create issue or Discard at a time, so a double click never opens the issue twice.
DECIDING = asyncio.Lock()


@router.post("/repo_live/{owner}/{name}")
async def set_up(owner: str, name: str) -> dict:
    if re.fullmatch(NAME, owner) is None or re.fullmatch(NAME, name) is None:
        raise HTTPException(status_code=400, detail="That isn't a GitHub repo.")
    repo = f"{owner}/{name}"
    if not your_repositories.is_listed(repo):
        raise HTTPException(status_code=404, detail=f"{repo} isn't one of your repositories or stars.")
    record = agents.live_agent(repo)
    if record is not None and (record["live"] is None or record["live"]["state"] != "failed"):
        raise HTTPException(status_code=409, detail=f"{repo} is set up already.")

    # Try again keeps the VM it had, while that is still there.
    vm_name = None
    if record is not None:
        for each in vms.list():
            if each.name == record["target_vm"]:
                vm_name = each.name
    if vm_name is None:
        # Named after the repo: lower case, only a-z, 0-9 and -, starting with a letter, and -2, -3, ... when taken.
        base = re.sub(r"[^a-z0-9-]+", "-", name.lower())
        base = re.sub(r"^[^a-z]+", "", base)[:27].strip("-")
        if base == "":
            base = "repo"
        names = [each.name for each in vms.list()]
        vm_name = base
        number = 2
        while vm_name in names:
            vm_name = f"{base}-{number}"
            number += 1
        options = vms.options()
        try:
            image = images.find(images.get_default())["name"]
            await asyncio.to_thread(vms.create, vm_name, image, options["cpus_default"], options["memory_gb_default"], options["disk_gb_default"], 1)
        except (ImagesError, VMsError) as error:
            raise HTTPException(status_code=400, detail=str(error))

    try:
        if record is None:
            agents.set_up_live(repo, vm_name)
        else:
            agents.retry_live(record["id"], vm_name)
    except (ValueError, VMsError) as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/issue_drafts/{draft_id}/create")
async def create_issue(draft_id: str) -> dict:
    """Opens the draft on GitHub as you, as it is; answers with the draft, now created, with the issue's url."""
    async with DECIDING:
        try:
            draft = issue_drafts.get(draft_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error.args[0]))
        if draft["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"{draft_id} is {draft['status']} already.")
        fields = {"title": draft["title"], "body": draft["body"], "labels": draft["labels"]}
        try:
            result = await asyncio.to_thread(your_repositories.act, draft["repo"], "new_issue", None, "issue", fields)
        except (ValueError, httpx.HTTPError) as error:
            raise HTTPException(status_code=400, detail=str(error))
        number = None
        if result["url"] is not None:
            number = int(result["url"].rstrip("/").split("/")[-1])
        draft = issue_drafts.decide(draft_id, "created", result["url"], number)
    agents.issue_decided(draft)
    return draft


@router.post("/issue_drafts/{draft_id}/discard")
async def discard_issue(draft_id: str) -> dict:
    async with DECIDING:
        try:
            draft = issue_drafts.decide(draft_id, "discarded")
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error.args[0]))
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error))
    agents.issue_decided(draft)
    return draft
