"""The GitHub tab: your PRs and issues on GitHub and how each one stands (github_searcher/pr_tracking.py), each one's
whole thread for the thread pop-up, which agent follows each one, and the changes you make there, as you
(github_searcher/github_account.py). Its Account page signs you in (backend/github_account_api.py).

GET /api/github/thread?id=owner/name%23n is one PR or issue as GitHub has it now, read with the search tokens (with
your sign-in when it is in one of your repositories or stars, which may be private: github_searcher/your_repositories.py): the
description, the newest 100 timeline items (comments, reviews with their code comments, commits, and events in plain
words; "hidden" says how many earlier ones are left out), and for a PR its branch, commits, the newest commit's checks
(with GitHub Actions runs that wait for a maintainer to approve them) and files changed. "you" is your signed-in login,
and "mine" marks your comments. "yours" says it is in one of your repositories, where the pop-up offers what a
maintainer does there (backend/your_repositories_api.py); "repo_labels" are then every label the repo has,
and "failed_runs" a PR's newest commit's failed GitHub Actions runs (to run their failed jobs again).

POST /api/github/agent sets one followed PR's or issue's agent: drafts (with an agent; none makes a new one) or off.
Turning drafts on checks the thread at once. keep_prs(), which the app runs in the background, reads the PRs and
issues again every PRS_REFRESH_SECONDS, at once when Approve just sent something, and soon after you comment or delete
a comment here. After every read (Check now's too), every open PR of yours without an agent gets one that owns it
(unless you set it to Off), and each thread pr_tracking.needs_reply() lists (someone else wrote there, your PR's
checks failed, or anything else changed on your PR) goes to its agent as a follow_up job (agents.follow_up); what the
agent drafts then waits for you in the Inbox.

The buttons (each asks "are you sure?" in the browser first): post a comment as you, delete one of your comments
(refused when it isn't yours; a draft that posted it keeps when it was deleted), close or reopen one of your PRs,
delete a closed or merged PR's branch from your fork. After a change to a PR, the PRs are read again. Check now
(POST /api/github/refresh) reads them all at once. The PRs and issues reach the browser through /api/live (topic
"prs"), the drafts with the Inbox (topic "inbox").
"""

import asyncio
import re
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import agents, github_account, inbox, pr_tracking, workflow, your_repositories
from github_searcher.github_account import SendError
from github_searcher.pr_tracking import AGENT_MODES, ROLLUP
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


class AgentRequest(BaseModel):
    id: str
    mode: str
    agent: str | None = None  # drafts without one: a new agent is made for it.


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
    # One of your repositories or stars: read with your sign-in, as it may be private.
    yours = your_repositories.is_yours(f"{owner}/{name}")
    own_token = None
    if your_repositories.is_listed(f"{owner}/{name}"):
        own_token = your_repositories.token()
    try:
        thread = await asyncio.to_thread(get_full_thread, owner, name, number, own_token)
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
            asyncio.to_thread(get_check_runs, owner, name, sha, own_token),
            asyncio.to_thread(get_commit_statuses, owner, name, sha, own_token),
            asyncio.to_thread(get_action_runs, owner, name, sha, own_token),
            asyncio.to_thread(get_pr_files, owner, name, number, own_token),
        )
    repo_labels = []
    if yours:
        repo_labels = await asyncio.to_thread(your_repositories.labels, f"{owner}/{name}")

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

    # In one of your repositories: the newest commit's failed GitHub Actions runs, for the Checks tab's Re-run.
    failed_runs = []
    for run in runs:
        if yours and run["conclusion"] in ["failure", "timed_out", "startup_failure", "cancelled"]:
            failed_runs.append({"id": run["id"], "name": run["name"], "url": run["html_url"]})

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
        "yours": yours,
        "repo_labels": repo_labels,
        "failed_runs": failed_runs,
    }


@router.post("/github/agent")
async def set_agent(body: AgentRequest) -> dict:
    """Drafts or off for one PR or issue the GitHub tab follows. Drafts without an agent makes a new one. On the event
    loop: making an agent and giving it a job happen there."""
    if body.mode not in AGENT_MODES:
        raise HTTPException(status_code=400, detail=f"Unknown mode {body.mode}: drafts or off.")
    followed = pr_tracking.summary()
    ids = [item["id"] for item in followed["items"]] + [issue["id"] for issue in followed["issues"]]
    if body.id not in ids:
        raise HTTPException(status_code=404, detail=f"The GitHub tab doesn't follow {body.id}.")
    agent_id = None
    if body.mode == "drafts":
        agent_id = body.agent
    if agent_id is not None and agent_id not in agents.agents:
        raise HTTPException(status_code=404, detail=f"No agent {agent_id}.")
    if body.mode == "drafts" and agent_id is None:
        agent_id = agents.create()["id"]
    setting = pr_tracking.set_agent(body.id, body.mode, agent_id)

    # Drafts on: when someone else wrote last (or your PR's checks failed) and no agent was given it yet, the agent
    # gets a follow_up job now.
    for entry in pr_tracking.needs_reply():
        if entry["id"] != body.id:
            continue
        job = agents.follow_up(entry)
        if job is not None:
            pr_tracking.mark_answered(entry["id"], entry["at"], entry["failed_sha"], entry["signals"])
    return setting


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
    # Read again soon: your comment is your newest there, so its agent doesn't answer what you answered.
    pr_tracking.wanted = True
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
        raise HTTPException(status_code=400, detail="Sign in with GitHub first: the GitHub tab, Account.")
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
    pr_tracking.wanted = True
    return {"done": done}


async def keep_prs() -> None:
    """Runs as long as the backend. One that fails to read shows its error and is tried again next round. After every
    read, the threads that need their agent go to it; one that fails to is tried again after the next read."""
    last = None
    # The sent drafts a refresh has already seen.
    tried = set()
    # The read the follow-ups last ran after (pr_tracking's checked_at).
    followed_up = None
    while True:
        sent = [draft["id"] for draft in inbox.list() if draft["sent"] is not None]
        new = [draft_id for draft_id in sent if draft_id not in tried]
        if new or pr_tracking.wanted or last is None or time.monotonic() - last > PRS_REFRESH_SECONDS:
            last = time.monotonic()
            tried.update(sent)
            pr_tracking.wanted = False
            try:
                await asyncio.to_thread(pr_tracking.refresh)
            except Exception:
                pass

        # After every read, also Check now's: called here, on the event loop, like everything else in agents.
        entries = []
        if pr_tracking.data["checked_at"] != followed_up:
            followed_up = pr_tracking.data["checked_at"]
            # Every open PR of yours has an agent that owns it: the one whose draft opened it, or your pick. One you
            # opened by hand, or whose agent was deleted, gets the agent that last had a job on its repo, else a new
            # one. One you set to Off stays off.
            followed = pr_tracking.summary()
            settings = pr_tracking.data["agent_settings"]
            for pr in followed["items"]:
                if pr["relation"] != "author" or pr["state"] != "open":
                    continue
                if pr["agent"] is not None and pr["agent"] in agents.agents:
                    continue
                if settings.get(pr["id"], {}).get("mode") == "off":
                    continue
                # The Workflow tab's pull requests have their own agents (workflow.py).
                if workflow.get(pr["repo"]) is not None:
                    continue
                owner = None
                for job in agents.jobs.list():
                    if owner is None and job["repo"] is not None and job["repo"].lower() == pr["repo"].lower() and job["agent"] in agents.agents:
                        owner = job["agent"]
                if owner is None:
                    owner = agents.create()["id"]
                pr_tracking.set_agent(pr["id"], "drafts", owner)
            entries = pr_tracking.needs_reply()
        for entry in entries:
            job = None
            try:
                job = agents.follow_up(entry)
            except Exception as error:
                print(f"[github] could not give {entry['id']} to its agent: {error}")
            if job is not None:
                pr_tracking.mark_answered(entry["id"], entry["at"], entry["failed_sha"], entry["signals"])
        await asyncio.sleep(PRS_CHECK_SECONDS)
