"""The Repos page: add a repo by hand, remove rows, undo/redo, the repo explorer (file tree, one file, README), and keeping the signals fresh.

Agents and Explore fill the list (github_searcher/agent/work_tools.py, github_searcher/explore.py);
the browser removes rows and steps through the undo history. The list reaches the
browser through /api/live, each repo with its signals. The explorer reads the default branch
from GitHub through search.py, which caches every answer, so opening a repo or a file again is instant.

The user adds one by hand (add_repo): a GitHub link or owner/name, from the box on the Repos page. It is looked up on
GitHub for its own spelling, stars and description, and added by the user as one undo step.

Remove only takes repos off the list: nothing is blocked, so Explore and agents may find and add them again. It takes
many repos at once (the page's multi-select), as one undo step, and stops tracking them too (an undo step on Tracked).
When they have issues in the Issues list, the page asks whether those go too (an undo step on Issues). The ones on the
Issues board's Open and Catalog go either way, and so do an archived repo's (auto_remove_issues in backend/issues_api.py).

A click on a card on the Dashboard's Repository page shows every open issue of the repo, read from GitHub each time
(repo_issues), with the tags the app has for each, and whether those are complete: there are some, by the current
rules (a merge, a complexity), and read since the issue last changed on GitHub. The pop-up has the others tagged at
once (tag_repo_issues), so each issue of a repo is read once, and again only after it changes; the next time the
pop-up opens they are there. One that goes into the Issues list is read again there (keep_new_tags in
backend/issues_api.py).

Tag puts picked repos under one tag of the user's own, or takes them out of theirs, as one undo step. It is only
grouping: the page shows each tag's repos on top, under a header that folds them away, and the rest under No tag.

The signals (github_searcher/repo_signals.py) are read by keep_signals(), which the app runs in the background, for
the Repos list and the Tracked list alike (the Tracked page shows them as tags under an open repo): a new repo gets
them within SIGNALS_CHECK_SECONDS, and keeps them. They are read again only when you ask: Refresh on the Dashboard's
Repository page, in a card's menu or for the picked cards (refresh_signals). Signals kept from before the totals
(commits, open, merged and closed PRs, open issues) were counted get just those, with one small read each.

Set up (a button on each row) gives a repo to an agent as a set_up_repo job (Agents.set_up_repo): the agent sets
it up in its VM, running when it has a clear frontend, else cloned and opened in VS Code, and ends with a short
introduction to the repo. It wakes the agent, so that endpoint runs on the event loop (`async def`).
"""

import asyncio
import base64
import re
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.issues_api import auto_remove_issues
from backend.shared import agents, issue_tags, issues, repo_signals, repos, tracked
from github_searcher.issue_tags import RULES_VERSION
from github_searcher.repo_signals import NEWCOMER_VERSION, NON_LATIN_SHARE, POLICY_VERSION
from github_searcher.search import get_contents, get_open_issues, get_readme, get_repo_totals, get_repository, get_tree
from sandbox.vms import VMsError

router = APIRouter(prefix="/api")

# Bigger files are not shown: GitHub's contents API only sends files up to 1 MB.
MAX_FILE_BYTES = 1024 * 1024
SIGNALS_CHECK_SECONDS = 10
SIGNALS_RETRY_SECONDS = 60 * 60
# Repos whose signals are fetched at the same time in a full round.
SIGNALS_AT_ONCE = 4


class AddRequest(BaseModel):
    name: str  # "owner/name" or a GitHub link to the repo


class RemoveRequest(BaseModel):
    names: list[str]
    issues: bool = False  # True: their issues leave the Issues list too


class ArchiveRequest(BaseModel):
    names: list[str]
    archived: bool


class RefreshRequest(BaseModel):
    names: list[str]


class TagIssuesRequest(BaseModel):
    name: str  # owner/name
    numbers: list[int]


class TagRequest(BaseModel):
    names: list[str]
    tag: str  # "" takes them out of their tag


class SetUpRequest(BaseModel):
    repo: str
    agent: str | None = None  # None: a new agent is made for it.
    vm: str | None = None  # None: the agent keeps its target VM.
    instructions: str = ""


@router.post("/repos/add")
def add_repo(body: AddRequest) -> dict:
    """Put a repo in Repos by hand. Takes a second: the repo is looked up on GitHub."""
    name = body.name.strip().removeprefix("https://").removeprefix("http://").removeprefix("www.").removeprefix("github.com/")
    name = name.removesuffix("/").removesuffix(".git")
    # A link to a page inside the repo (issues, a file) still names the repo first.
    name = "/".join(name.split("/")[:2])
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise HTTPException(status_code=400, detail="Paste the repo's GitHub link, or type it as owner/name.")
    try:
        info = get_repository(name.split("/")[0], name.split("/")[1])
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            raise HTTPException(status_code=404, detail=f"GitHub has no repo {name}.")
        raise HTTPException(status_code=502, detail=f"GitHub error {error.response.status_code}: {error.response.text[:200]}")

    item = {
        "full_name": info["full_name"],
        "description": info["description"] or "",
        "stars": info["stargazers_count"],
        "default_branch": info["default_branch"],
        "html_url": info["html_url"],
        "note": "",
        "added_by": "user",
        "added_at": datetime.now(UTC).isoformat(),
    }
    added = repos.add([item])
    if not added:
        raise HTTPException(status_code=409, detail=f"{info['full_name']} is already in Repos.")
    return {"added": added}


@router.post("/repos/archive")
def archive_repos(body: ArchiveRequest) -> dict:
    """Delete on the Dashboard's Repository page for a repo with pull requests of yours (open, closed or merged): it moves to the page's
    Archived section (archived true), or back (false). Repos not in the list are left out."""
    listed = [item["full_name"] for item in repos.items()]
    names = [name for name in body.names if name in listed]
    repos.set_archived(names, body.archived)
    # Its issues on the Issues board's Open and Catalog go now, not after keep_tags' round.
    auto_remove_issues()
    return {"archived": repos.archived()}


@router.get("/repos/issues")
def repo_issues(name: str) -> dict:
    """Every open issue of a repo on GitHub, newest first, each with the tags the app has for it (None for one it never
    read): a click on a card on the Dashboard's Repository page. A second or two; one more per 100 issues."""
    if name.count("/") != 1:
        raise HTTPException(status_code=400, detail="Give the repo as owner/name.")
    try:
        nodes = get_open_issues(name.split("/")[0], name.split("/")[1])
    except httpx.HTTPStatusError as error:
        raise HTTPException(status_code=502, detail=f"GitHub error {error.response.status_code}: {error.response.text[:200]}")
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=502, detail=f"Could not read its issues from GitHub: {error}")
    tags = issue_tags.all()
    found = []
    for node in nodes:
        tag = tags.get(f"{name}#{node['number']}")
        # Complete: by the current rules (a merge, a complexity unless GitHub shows an assignee), read since its last change.
        complete = (
            tag is not None
            and tag.get("merge") is not None
            and (tag.get("checks") is None or tag.get("complexity") is not None)
            and tag.get("rules_version") == RULES_VERSION
            and tag["updated_at"] == node["updatedAt"]
        )
        found.append(
            {
                "number": node["number"],
                "title": node["title"],
                "url": node["url"],
                "created_at": node["createdAt"],
                "labels": [label["name"] for label in node["labels"]["nodes"]],
                "comments": node["comments"]["totalCount"],
                "tags": tag,
                "complete": complete,
            }
        )
    return {"issues": found}


@router.post("/repos/issues/tag")
async def tag_repo_issues(body: TagIssuesRequest) -> dict:
    """Tag these issues of a repo now, from fresh: the ones its pop-up shows without complete tags (repo_issues). Returns
    their tags by number, None for one that couldn't be read (the pop-up asks again the next time it opens). Many
    issues take a few minutes."""
    ids = [f"{body.name}#{number}" for number in body.numbers]
    await issue_tags.tag(ids, force=True)
    tags = issue_tags.all()
    return {"tags": {str(number): tags.get(f"{body.name}#{number}") for number in body.numbers}}


@router.post("/repos/refresh")
async def refresh_signals(body: RefreshRequest) -> dict:
    """Read repos' signals from GitHub again now, with Claude's judgments, and keep them (Refresh on the Dashboard's
    Repository page: a card's, or the picked cards'). SIGNALS_AT_ONCE at a time, like keep_signals(); a few seconds
    each. Answers when all are done, with the ones that failed."""
    listed = [item["full_name"] for item in repos.items()]
    names = [name for name in body.names if name in listed]
    if not names:
        raise HTTPException(status_code=404, detail="None of them is in Repos.")
    failed = []
    for start in range(0, len(names), SIGNALS_AT_ONCE):
        batch = names[start:start + SIGNALS_AT_ONCE]
        results = await asyncio.gather(*[repo_signals.refresh(name) for name in batch], return_exceptions=True)
        for name, result in zip(batch, results):
            if isinstance(result, Exception):
                failed.append(name)
    return {"refreshed": [name for name in names if name not in failed], "failed": failed}


@router.post("/repos/remove")
def remove_repos(body: RemoveRequest) -> dict:
    """Delete repos from Repos and stop tracking them too; with issues, their issues leave the Issues list too, but not
    the ones an agent is working on (working lists them). Each list one undo step of its own."""
    removed = repos.remove(body.names)
    if not removed:
        raise HTTPException(status_code=404, detail="None of them is in the list.")
    # The Tracked list may spell a name its own way (GitHub's), so names are compared without case.
    removed_lower = [name.lower() for name in removed]
    untracked = [item["full_name"] for item in tracked.items() if item["full_name"].lower() in removed_lower]
    if untracked:
        tracked.remove(untracked)
    working = []
    if body.issues:
        ids = [item["id"] for item in issues.items() if item["repo"].lower() in removed_lower]
        if ids:
            working = issues.remove(ids)["working"]
    # Without issues too, the ones on the Issues board's Open and Catalog go, now rather than after keep_tags' round.
    auto_remove_issues()
    return {"removed": removed, "working": working}


@router.post("/repos/tag")
def tag_repos(body: TagRequest) -> dict:
    tagged = repos.set_tag(body.names, body.tag.strip())
    if not tagged:
        raise HTTPException(status_code=404, detail="None of them is in the list.")
    # The same repos on the Tracked list get it too, so a repo has one tag on every page.
    tracked.set_tag(tagged, body.tag.strip())
    return {"tagged": tagged}


@router.post("/repos/set_up")
async def set_up_repo(body: SetUpRequest) -> dict:
    """Makes a set_up_repo job for a repo in the list and gives it to an agent; returns the job."""
    try:
        return agents.set_up_repo(body.repo, body.agent, body.vm, body.instructions.strip())
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error.args[0]))
    except VMsError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        # An unknown VM, or a different VM for an agent that is already queued for or holding its target VM.
        raise HTTPException(status_code=409, detail=str(error))


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
    """Runs as long as the backend: fetches signals for repos that have none, once; they are kept after that
    (refresh_signals reads one again when you ask).

    A repo that fails (GitHub down, the repo gone or renamed) is tried again after SIGNALS_RETRY_SECONDS.
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
        todo = []
        for name in names:
            if name in failed:
                continue
            # Signals from before activity, the 30-day average merge by contributor or the newcomer verdict was counted
            # are as good as missing: every repo is read again once for them.
            if name not in known or "activity" not in known[name] or "merge_authors_30d" not in known[name] or "newcomer_verdict" not in known[name]:
                todo.append(name)
                continue
            # An AI policy read by older rules, or from fewer files, that may mean no_ai now (POLICY_VERSION): read again
            # once. A no_ai one stays.
            policy = known[name].get("ai_policy") or {}
            if policy.get("tag") != "no_ai" and policy.get("version") != POLICY_VERSION:
                todo.append(name)
                continue
            # A welcome newcomer verdict from before it read the PR template and the reviews (NEWCOMER_VERSION): read
            # again once. A closed one stays closed.
            verdict = known[name].get("newcomer_verdict") or {}
            if verdict.get("verdict") == "welcome" and verdict.get("version") != NEWCOMER_VERSION:
                todo.append(name)
        for start in range(0, len(todo), SIGNALS_AT_ONCE):
            batch = todo[start:start + SIGNALS_AT_ONCE]
            results = await asyncio.gather(*[repo_signals.refresh(name) for name in batch], return_exceptions=True)
            for name, result in zip(batch, results):
                if isinstance(result, Exception):
                    failed.append(name)
                    continue
                # Claude didn't give the newcomer verdict (the one before stays): later, not on every round.
                verdict = (repo_signals.get(name) or {}).get("newcomer_verdict") or {}
                if verdict.get("verdict") == "welcome" and verdict.get("version") != NEWCOMER_VERSION:
                    failed.append(name)
        # Signals from before the totals (commits, open, merged and closed PRs, open issues) were counted get them with one
        # small read each, not a whole new read (that asks Claude again).
        known = repo_signals.all()
        for name in names:
            if name in failed or name not in known or "merged_prs_total" in known[name]:
                continue
            try:
                totals = await asyncio.to_thread(get_repo_totals, name.split("/")[0], name.split("/")[1])
            except (httpx.HTTPError, ValueError):
                failed.append(name)
                continue
            repo_signals.update(name, totals)
        # Signals from before the README's language was checked get it with one small read each, the README alone, as
        # repo_signals.py does it (None without a README).
        known = repo_signals.all()
        for name in names:
            if name in failed or name not in known or "readme_english" in known[name]:
                continue
            english = None
            try:
                readme = await asyncio.to_thread(get_readme, name.split("/")[0], name.split("/")[1])
                text = re.sub(r"```.*?```|`[^`]*`|https?://\S+|<[^>]+>", " ", readme, flags=re.S)
                letters = [char for char in text if char.isalpha()]
                other = [char for char in letters if ord(char) > 0x24F]
                english = len(other) <= NON_LATIN_SHARE * len(letters)
            except httpx.HTTPStatusError as error:
                if error.response.status_code != 404:
                    failed.append(name)
                    continue
            except (httpx.HTTPError, ValueError):
                failed.append(name)
                continue
            repo_signals.update(name, {"readme_english": english})
        await asyncio.sleep(SIGNALS_CHECK_SECONDS)
