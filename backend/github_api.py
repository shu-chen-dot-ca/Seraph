"""The GitHub tab: your PRs and issues on GitHub and how each one stands (github_searcher/pr_tracking.py), each one's
whole thread for the thread pop-up, and the changes you make there, as you
(github_searcher/github_account.py). Its Account page connects the account itself (backend/github_account_api.py).

GET /api/github/thread?id=owner/name%23n is one PR or issue as GitHub has it now, read with the search tokens: the
description, the newest 100 timeline items (comments, reviews with their code comments, commits, and events in plain
words; "hidden" says how many earlier ones are left out), and for a PR its branch, commits, the newest commit's checks
(with GitHub Actions runs that wait for a maintainer to approve them) and files changed. "you" is your connected login,
and "mine" marks your comments.

keep_prs(), which the app runs in the background, reads the PRs again every PRS_REFRESH_SECONDS, and at once
when Approve just sent a PR that isn't followed yet.

The buttons (each asks "are you sure?" in the browser first): post a comment as you, delete one of your comments
(refused when it isn't yours; a draft that posted it keeps when it was deleted), close or reopen one of your PRs,
delete a closed or merged PR's branch from your fork. After a change to a PR, the PRs are read again. Check now
(POST /api/github/refresh) reads them all at once. The PRs reach the browser through /api/live (topic
"prs"), the drafts with the Inbox (topic "inbox").
"""

import asyncio
import re
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import github_account, inbox, pr_tracking
from github_searcher.github_account import SendError
from github_searcher.pr_tracking import ROLLUP
from github_searcher.search import get_action_runs, get_check_runs, get_commit_statuses, get_full_thread, get_issue_comment, get_pr_files

router = APIRouter(prefix="/api")

PRS_CHECK_SECONDS = 15
PRS_REFRESH_SECONDS = 5 * 60
PR_ACTIONS = ["close", "reopen", "delete_branch"]
THREAD_ID = r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)"
NAME = r"[A-Za-z0-9_.-]+"
# A finished check run's conclusion, and a commit status, in the pop-up's words.
CONCLUSIONS = {
    "success": "passed",
    "failure": "failed",
    "timed_out": "failed",
    "startup_failure": "failed",
    "cancelled": "cancelled",
    "skipped": "skipped",
    "neutral": "neutral",
    "stale": "neutral",
    "action_required": "waiting",
}
STATUSES = {"success": "passed", "failure": "failed", "error": "failed", "pending": "running"}
# Why an issue was closed, after "closed this".
CLOSE_REASONS = {"COMPLETED": " as completed", "NOT_PLANNED": " as not planned", "DUPLICATE": " as a duplicate"}
# How much of a check's summary is kept.
SUMMARY_CHARS = 300


class CommentRequest(BaseModel):
    target: str
    body: str


@router.post("/github/refresh")
async def refresh_prs() -> dict:
    """Read every PR and issue again now. Takes a few seconds per open one."""
    await asyncio.to_thread(pr_tracking.refresh)
    return {"ok": True}


@router.get("/github/thread")
async def thread_details(id: str) -> dict:
    """One PR or issue as GitHub has it now, for the thread pop-up (frontend/src/ThreadDialog.tsx). Its timeline is
    oldest first: comments, reviews, commits and events, each in a simpler shape than GitHub's."""
    match = re.fullmatch(THREAD_ID, id)
    if match is None:
        raise HTTPException(status_code=400, detail="The id must be owner/name#number.")
    owner = match.group(1)
    name = match.group(2)
    number = int(match.group(3))
    try:
        thread = await asyncio.to_thread(get_full_thread, owner, name, number)
    except (ValueError, httpx.RequestError) as error:
        raise HTTPException(status_code=400, detail=str(error))
    if thread is None:
        raise HTTPException(status_code=404, detail=f"GitHub has no {id}.")

    you = None
    account = github_account.status()
    if account["connected"]:
        you = account["login"]
    kind = "issue"
    if thread["__typename"] == "PullRequest":
        kind = "pr"

    # A PR's newest commit's checks and its files changed, all at once.
    check_runs = []
    statuses = []
    runs = []
    changed = []
    if kind == "pr":
        sha = thread["headRefOid"]
        check_runs, statuses, runs, changed = await asyncio.gather(
            asyncio.to_thread(get_check_runs, owner, name, sha),
            asyncio.to_thread(get_commit_statuses, owner, name, sha),
            asyncio.to_thread(get_action_runs, owner, name, sha),
            asyncio.to_thread(get_pr_files, owner, name, number),
        )

    checks = []
    for run in check_runs:
        state = "running"
        if run["status"] == "completed":
            state = CONCLUSIONS.get(run["conclusion"], "neutral")
        summary = run["output"]["title"] or run["output"]["summary"] or ""
        app = ""
        if run["app"] is not None:
            app = run["app"]["name"]
        checks.append({"name": run["name"], "state": state, "summary": " ".join(summary.split())[:SUMMARY_CHARS], "url": run["html_url"] or "", "app": app})
    for status in statuses:
        checks.append({"name": status["context"], "state": STATUSES.get(status["state"], "running"), "summary": status["description"] or "", "url": status["target_url"] or "", "app": ""})
    # GitHub Actions runs that wait for a maintainer to approve them (a first-time contributor's): nothing else shows them.
    for run in runs:
        if run["conclusion"] == "action_required":
            checks.append({"name": run["name"], "state": "waiting", "summary": "Waits for a maintainer to approve running it.", "url": run["html_url"], "app": "GitHub Actions"})

    # patch is missing for a binary or very big file.
    files = []
    for file in changed:
        status = file["status"]
        if status == "unchanged":
            status = "changed"
        files.append({
            "path": file["filename"],
            "old_path": file.get("previous_filename"),
            "status": status,
            "additions": file["additions"],
            "deletions": file["deletions"],
            "patch": file.get("patch", ""),
        })

    draft = False
    base = None
    head = None
    commit_nodes = []
    if kind == "pr":
        draft = thread["isDraft"]
        base = thread["baseRefName"]
        commit_nodes = thread["commits"]["nodes"]
    # Its branch, gone once deleted (or with the fork).
    if kind == "pr" and thread["headRepository"] is not None and thread["headRef"] is not None:
        head = {"repo": thread["headRepository"]["nameWithOwner"], "branch": thread["headRefName"], "sha": thread["headRefOid"]}

    commits = []
    for each in commit_nodes:
        commit = each["commit"]
        login = None
        author_name = ""
        if commit["author"] is not None and commit["author"]["user"] is not None:
            login = commit["author"]["user"]["login"]
        if commit["author"] is not None:
            author_name = commit["author"]["name"]
        state = "none"
        if commit["statusCheckRollup"] is not None:
            state = ROLLUP.get(commit["statusCheckRollup"]["state"], "running")
        commits.append({"sha": commit["oid"], "message": commit["message"], "at": commit["committedDate"], "login": login, "name": author_name, "checks": state})

    timeline = []
    for item in thread["timelineItems"]["nodes"]:
        if item is None:
            continue
        typename = item["__typename"]
        # Who wrote it (comments and reviews), or who did it (events). Deleted accounts are "ghost", as on GitHub.
        login = "ghost"
        bot = False
        if item.get("author") is not None:
            login = item["author"]["login"]
            bot = item["author"]["__typename"] == "Bot" or login.endswith("[bot]")
        actor = "ghost"
        if item.get("actor") is not None:
            actor = item["actor"]["login"]
        # Who an assignment or a review request is about.
        who = "someone"
        target = item.get("assignee") or item.get("requestedReviewer")
        if target:
            who = target.get("login") or target.get("name") or "someone"
        if who == actor:
            who = "themselves"

        if typename == "IssueComment":
            timeline.append({
                "type": "comment",
                "id": item["databaseId"],
                "login": login,
                "bot": bot,
                "role": item["authorAssociation"],
                "at": item["createdAt"],
                "body": item["body"],
                "url": item["url"],
                "mine": you is not None and login == you,
            })
            continue
        # A pending review is only its author's own, not shown to anyone else.
        if typename == "PullRequestReview" and item["state"] != "PENDING":
            comments = []
            for comment in item["comments"]["nodes"]:
                comments.append({
                    "path": comment["path"],
                    "line": comment["line"] if comment["line"] is not None else comment["originalLine"],
                    "hunk": comment["diffHunk"],
                    "body": comment["body"],
                    "login": comment["author"]["login"] if comment["author"] else "ghost",
                    "at": comment["createdAt"],
                    "url": comment["url"],
                })
            timeline.append({
                "type": "review",
                "login": login,
                "bot": bot,
                "role": item["authorAssociation"],
                "at": item["submittedAt"] or item["createdAt"],
                "state": item["state"].lower(),
                "body": item["body"],
                "url": item["url"],
                "comments": comments,
            })
            continue
        if typename == "PullRequestCommit":
            commit = item["commit"]
            committer = "ghost"
            if commit["author"] is not None and commit["author"]["user"] is not None:
                committer = commit["author"]["user"]["login"]
            elif commit["author"] is not None:
                committer = commit["author"]["name"]
            timeline.append({"type": "commit", "at": commit["committedDate"], "sha": commit["oid"], "message": commit["message"], "login": committer})
            continue

        text = None
        if typename == "LabeledEvent":
            text = f"added the label {item['label']['name']}"
        if typename == "UnlabeledEvent":
            text = f"removed the label {item['label']['name']}"
        if typename == "ClosedEvent":
            text = "closed this" + CLOSE_REASONS.get(item["stateReason"], "")
        if typename == "ReopenedEvent":
            text = "reopened this"
        if typename == "MergedEvent":
            text = f"merged this into {item['mergeRefName']}"
        if typename == "AssignedEvent":
            text = f"assigned {who}"
        if typename == "UnassignedEvent":
            text = f"unassigned {who}"
        if typename == "CrossReferencedEvent" and item["source"].get("repository") is not None:
            text = f"mentioned this in {item['source']['repository']['nameWithOwner']}#{item['source']['number']}"
        if typename == "RenamedTitleEvent":
            text = f'changed the title from "{item["previousTitle"]}" to "{item["currentTitle"]}"'
        if typename == "HeadRefForcePushedEvent":
            text = "force-pushed the branch"
        if typename == "ReadyForReviewEvent":
            text = "marked this ready for review"
        if typename == "ConvertToDraftEvent":
            text = "converted this to a draft"
        if typename == "ReviewRequestedEvent":
            text = f"asked {who} for a review"
        if text is not None:
            timeline.append({"type": "event", "at": item["createdAt"], "login": actor, "text": text})

    author = "ghost"
    author_bot = False
    if thread["author"] is not None:
        author = thread["author"]["login"]
        author_bot = thread["author"]["__typename"] == "Bot" or author.endswith("[bot]")
    # Why an issue was closed: completed, not_planned or duplicate.
    reason = None
    if kind == "issue" and thread["state"] == "CLOSED" and thread["stateReason"] is not None:
        reason = thread["stateReason"].lower()

    return {
        "id": f"{owner}/{name}#{number}",
        "kind": kind,
        "repo": f"{owner}/{name}",
        "number": number,
        "title": thread["title"],
        "url": thread["url"],
        "author": author,
        "author_bot": author_bot,
        "role": thread["authorAssociation"],
        "state": thread["state"].lower(),
        "reason": reason,
        "draft": draft,
        "body": thread["body"],
        "created_at": thread["createdAt"],
        "labels": [{"name": label["name"], "color": label["color"]} for label in thread["labels"]["nodes"]],
        "assignees": [person["login"] for person in thread["assignees"]["nodes"]],
        "timeline": timeline,
        "hidden": max(0, thread["timelineItems"]["totalCount"] - len(thread["timelineItems"]["nodes"])),
        "head": head,
        "base": base,
        "commits": commits,
        "checks": checks,
        "files": files,
        "you": you,
    }


@router.post("/github/comment")
async def post_comment(request: CommentRequest) -> dict:
    """Your own comment on a PR or issue, as you (the browser asked "are you sure?"). Returns {"url", "id"}."""
    if re.fullmatch(THREAD_ID, request.target) is None:
        raise HTTPException(status_code=400, detail="The target must be owner/name#number.")
    if request.body.strip() == "":
        raise HTTPException(status_code=400, detail="Write the comment first.")
    try:
        posted = await asyncio.to_thread(github_account.comment, request.target, request.body)
    except SendError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return posted


@router.post("/github/prs/{owner}/{name}/{number}/{action}")
async def change_pr(owner: str, name: str, number: int, action: str) -> dict:
    """Close or reopen one of your PRs, or delete its branch from your fork. Returns what happened, in words."""
    if action not in PR_ACTIONS:
        raise HTTPException(status_code=404, detail=f"Unknown action {action}.")
    try:
        done = await asyncio.to_thread(github_account.manage, action, f"{owner}/{name}", number)
    except SendError as error:
        raise HTTPException(status_code=400, detail=str(error))
    await asyncio.to_thread(pr_tracking.refresh)
    return {"done": done}


@router.post("/github/comments/{owner}/{name}/{comment_id}/delete")
async def delete_comment(owner: str, name: str, comment_id: int) -> dict:
    """Delete one of your comments on GitHub, as you. Refused when it isn't yours. A draft that posted it keeps that
    it was deleted, and when."""
    if re.fullmatch(NAME, owner) is None or re.fullmatch(NAME, name) is None:
        raise HTTPException(status_code=400, detail="That isn't a GitHub repo.")
    account = github_account.status()
    if not account["connected"]:
        raise HTTPException(status_code=400, detail="Connect your GitHub account first: the GitHub tab, Account.")
    # Whose it is, read with the search tokens first: GitHub deletes by id alone, and your token may delete other
    # people's comments on a repo you maintain.
    comment = None
    try:
        comment = await asyncio.to_thread(get_issue_comment, owner, name, comment_id)
    except httpx.HTTPStatusError as error:
        if error.response.status_code != 404:
            raise
    login = "ghost"
    if comment is not None and comment["user"] is not None:
        login = comment["user"]["login"]
    if comment is not None and login.lower() != account["login"].lower():
        raise HTTPException(status_code=400, detail=f"That comment is by {login}, not you.")
    done = "The comment is gone already."
    if comment is not None:
        try:
            done = await asyncio.to_thread(github_account.manage, "delete_comment", f"{owner}/{name}", comment_id)
        except SendError as error:
            raise HTTPException(status_code=400, detail=str(error))

    now = datetime.now(UTC).isoformat()
    for draft in inbox.list():
        sent = draft["sent"]
        if sent is None or sent["kind"] != "comment" or sent.get("id") != comment_id:
            continue
        if sent["repo"].lower() != f"{owner}/{name}".lower():
            continue
        inbox.mark_sent(draft["id"], {**sent, "deleted_at": now})
    return {"done": done}


async def keep_prs() -> None:
    """Runs as long as the backend. A PR that fails to read shows its error and is tried again next round."""
    last = None
    # The sent PRs a refresh has already tried to read.
    tried = set()
    while True:
        sent = []
        for draft in inbox.list():
            if draft["sent"] is not None and draft["sent"]["kind"] == "pr":
                sent.append(f"{draft['sent']['repo']}#{draft['sent']['number']}")
        new = [pr_id for pr_id in sent if pr_id not in tried]
        if new or last is None or time.monotonic() - last > PRS_REFRESH_SECONDS:
            last = time.monotonic()
            tried.update(sent)
            try:
                await asyncio.to_thread(pr_tracking.refresh)
            except Exception:
                pass
        await asyncio.sleep(PRS_CHECK_SECONDS)
