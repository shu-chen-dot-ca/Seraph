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
issues again every refresh_prs_minutes (the Issues board's robot, "Needs action and Waiting approval": 10 at first), at
once when Approve just sent something, and soon after you comment or delete a comment here. After every read (Check
now's too), every open PR of yours without an agent gets one that owns it (unless you set it to Off), and each thread
pr_tracking.needs_reply() lists (someone else wrote there, your PR's checks failed, or anything else changed on your PR)
goes to its agent as a follow_up job (agents.follow_up); what the agent drafts then waits for you in the Inbox.

What each open PR of yours needs from us (the Issues board's Needs action, else Waiting approval) is worked out every
PRS_CHECK_SECONDS (pr_tracking.update_actions): by rules, and by Claude (judge_prs), which reads a PR again, JUDGE_BATCH
at a time, when it changed on GitHub or a job on it ended since it last did, never while a job on it is open. One that
needs action, as Claude last read it, with no job open on it, goes to its agent as a follow_up job saying what it needs:
ACTION_TRIES times at most on the same newest commit, each after a new judgment (never for a draft you approved and
only have to send), and again only once something really changed on it since its last job was given it (a commit,
checks, a conflict, the draft state, labels, someone else's comment or review, a comment on an issue it fixes): a job
that ended finding nothing we can do isn't given the same need again for nothing. Every need is the agent's, never
yours: it settles a CLA too (Nothing waits on the user in agent/prompt.md). Agents work in the Issues board's order:
the ones with a job queued or working on a PR that needs action get priority (agents.set_pr_priority): ahead in the
VM's line, more CPU, stepped down last; then the ones reviewing a PR draft before the Inbox, the board's Review
(agents.set_review_priority): next in the line, stepped down after the rest; then the rest (In progress and Catalog).

keep_profile_readme(), also in the background, keeps the merged pull requests table on your GitHub profile's README
(github_searcher/profile_readme.py): every time Seraph starts, whenever a PR of yours shows up merged here (so within a
few minutes of the merge), and every PROFILE_README_SECONDS for the ones not followed here. One that fails (GitHub or
the network down, say right after the computer starts) is tried again PROFILE_README_RETRY_SECONDS later. It commits as
you without the Inbox: only that one file in your own profile repository.

The buttons (each asks "are you sure?" in the browser first): post a comment as you, delete one of your comments
(refused when it isn't yours; a draft that posted it keeps when it was deleted), close or reopen one of your PRs,
delete a closed or merged PR's branch from your fork. After a change to a PR, the PRs are read again.

keep_branches_clean(), also in the background, does that last one by itself: every BRANCHES_CHECK_SECONDS, each PR of
yours that is no longer open (merged or closed) and still has its branch in your own fork gets that branch deleted, like
GitHub's Delete branch button (the PR's page on GitHub has Restore branch, to reopen one, while its fork is there). Only
branches in your fork, only PRs that aren't open; one GitHub refuses is tried again only when the branch has a newer
commit.

keep_forks_trimmed(), also in the background, keeps your GitHub account from filling up with forks (Approve makes one
per project): every BRANCHES_CHECK_SECONDS, each fork in your account that nothing uses anymore is deleted. A fork
stays while it has any branch besides its default one and pr-pictures (an open PR's: keep_branches_clean deletes the
finished ones first; or one that isn't ours to judge), an open PR of yours comes from it, or a job on its project
isn't done or cancelled (a PR may go there soon). Never a repository of your own, never while a draft is being sent,
and only once you signed in with the delete_repo permission (the Account page asks you to sign in again). A later PR
to the same project makes the fork again. Pictures on PRs live in your profile repository, not the fork
(github_account.pictures). Check now
(POST /api/github/refresh) reads them all at once. The PRs and issues reach the browser through /api/live (topic
"prs"), the drafts with the Inbox (topic "inbox").
"""

import asyncio
import json
import re
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.issues_api import AUTO_REMOVE_FILE, AUTO_REMOVE_OFF
from backend.shared import agents, github_account, inbox, pr_tracking, workflow, your_repositories
from github_searcher.claude_judge import judge
from github_searcher.github_account import PICTURES_BRANCH, SendError
from github_searcher import profile_readme
from github_searcher.pr_tracking import AGENT_MODES, ROLLUP
from github_searcher.search import get_action_runs, get_check_runs, get_commit_statuses, get_full_thread, get_issue_comment, get_pr_files

router = APIRouter(prefix="/api")

PRS_CHECK_SECONDS = 15
# A PR whose judgment failed (Claude or GitHub down) is tried again after this long.
JUDGE_RETRY_SECONDS = 10 * 60
# PRs in one judgment: Claude reads them all at once.
JUDGE_BATCH = 4
# How much of a PR's text goes into its judgment: the description, each comment or review, each comment on a line.
JUDGE_BODY_CHARS = 3000
JUDGE_COMMENT_CHARS = 1500
JUDGE_LINE_CHARS = 600
# How many times the same need (the same reasons on the same newest commit) goes to its agent.
# A try after the first only once something changed on the PR since the last one (keep_prs).
ACTION_TRIES = 3
JUDGE_REASONS = ["Changes requested", "Reply needed", "Checks failing", "Merge conflicts", "Rebase needed", "CLA not signed",
                 "Draft", "Description out of date", "Other"]
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "prs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "needs_action": {"type": "boolean"},
                    "reasons": {"type": "array", "items": {"type": "string", "enum": JUDGE_REASONS}},
                    "detail": {"type": "string"},
                },
                "required": ["id", "needs_action", "reasons", "detail"],
            },
        },
    },
    "required": ["prs"],
}
BRANCHES_CHECK_SECONDS = 10 * 60
# Your forks, with the repo each was forked from and its first branches (keep_forks_trimmed).
FORKS_QUERY = """
query($after: String) {
  viewer {
    repositories(first: 100, after: $after, isFork: true, ownerAffiliations: [OWNER]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        parent { nameWithOwner }
        defaultBranchRef { name }
        refs(refPrefix: "refs/heads/", first: 10) { totalCount nodes { name } }
      }
    }
  }
}
"""
PROFILE_README_SECONDS = 24 * 60 * 60
PROFILE_README_RETRY_SECONDS = 5 * 60
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


async def keep_branches_clean() -> None:
    """Runs as long as the backend: deletes the branch in your fork of every PR of yours that is no longer open (see the
    top of this file)."""
    # Each PR's branch tried already, by the commit it was at: the PRs' next read shows it gone.
    tried = {}
    while True:
        account = github_account.status()
        prs = []
        if account["connected"]:
            prs = pr_tracking.summary()["items"]
        for pr in prs:
            head = pr["head"]
            if pr["relation"] != "author" or pr["state"] == "open" or head is None:
                continue
            if head["repo"].split("/")[0].lower() != account["login"].lower() or tried.get(pr["id"]) == head["sha"]:
                continue
            tried[pr["id"]] = head["sha"]
            try:
                await asyncio.to_thread(github_account.manage, "delete_branch", pr["repo"], pr["number"])
            except SendError:
                continue
            pr_tracking.wanted = True
        await asyncio.sleep(BRANCHES_CHECK_SECONDS)


async def keep_forks_trimmed() -> None:
    """Runs as long as the backend: deletes each fork in your account that nothing uses anymore (see the top of this
    file). One GitHub refuses is tried again next round."""
    while True:
        account = github_account.status()
        if account["connected"] and "delete_repo" in account["scopes"] and github_account.sending_draft is None:
            forks = []
            try:
                after = None
                for _ in range(10):
                    found = await asyncio.to_thread(your_repositories.graphql, FORKS_QUERY, {"after": after})
                    forks += found["viewer"]["repositories"]["nodes"]
                    if not found["viewer"]["repositories"]["pageInfo"]["hasNextPage"]:
                        break
                    after = found["viewer"]["repositories"]["pageInfo"]["endCursor"]
            except Exception as error:
                print(f"[github] could not list your forks: {error}")
                forks = []
            # What is in use: the forks your open PRs come from, and the projects with a job not done or cancelled.
            prs = pr_tracking.summary()["items"]
            used_forks = []
            for pr in prs:
                if pr["relation"] == "author" and pr["state"] == "open" and pr["head"] is not None:
                    used_forks.append(pr["head"]["repo"].lower())
            used_repos = []
            for job in agents.jobs.list():
                if job["status"] not in ["done", "cancelled"] and job["repo"] is not None:
                    used_repos.append(job["repo"].lower())
            for fork in forks:
                name = fork["nameWithOwner"]
                if fork["parent"] is None or fork["defaultBranchRef"] is None:
                    continue
                branches = [ref["name"] for ref in fork["refs"]["nodes"]]
                others = [branch for branch in branches if branch not in [fork["defaultBranchRef"]["name"], PICTURES_BRANCH]]
                if others or fork["refs"]["totalCount"] > len(branches):
                    continue
                if name.lower() in used_forks or fork["parent"]["nameWithOwner"].lower() in used_repos:
                    continue
                # A send may have started since this round began.
                if github_account.sending_draft is not None:
                    break
                try:
                    done = await asyncio.to_thread(github_account.manage, "delete_fork", name, 0)
                    print(f"[github] {done}")
                except SendError as error:
                    print(f"[github] could not delete your fork {name}: {error}")
                    continue
                your_repositories.wanted = True
        await asyncio.sleep(BRANCHES_CHECK_SECONDS)


async def keep_profile_readme() -> None:
    """Runs as long as the backend: brings your profile README's merged pull requests table up to date at start, when a
    PR of yours newly shows up merged, and every PROFILE_README_SECONDS (see the top of this file). One that fails is
    tried again PROFILE_README_RETRY_SECONDS later."""
    merged = None
    last = None
    failed = False
    while True:
        now_merged = set()
        for pr in pr_tracking.summary()["items"]:
            if pr["relation"] == "author" and pr["state"] == "merged":
                now_merged.add(pr["id"])
        due = merged is None or not now_merged.issubset(merged) or time.monotonic() - last > PROFILE_README_SECONDS
        if failed and time.monotonic() - last > PROFILE_README_RETRY_SECONDS:
            due = True
        if due:
            merged = now_merged
            last = time.monotonic()
            failed = False
            try:
                done = await asyncio.to_thread(profile_readme.update, your_repositories)
                print(f"[profile readme] {done}")
            except Exception as error:
                print(f"[profile readme] could not update: {error}")
                failed = True
        await asyncio.sleep(PRS_CHECK_SECONDS)


async def judge_prs(due: list[dict], jobs: list[dict], failed_at: dict) -> None:
    """Claude reads the PRs in due, JUDGE_BATCH at a time, and says for each what it needs from us now, if anything
    (pr_tracking.set_judgment): the thread as GitHub has it (the description, comments, reviews with their comments on
    lines, commits, checks), the newest comments on the issues it fixes, and what our agents' jobs on it said. One that
    fails goes in failed_at, tried again after JUDGE_RETRY_SECONDS."""
    you = github_account.status().get("login") or "the user"
    for start in range(0, len(due), JUDGE_BATCH):
        batch = due[start:start + JUDGE_BATCH]
        keys = {}
        texts = []
        for pr in batch:
            keys[pr["id"]] = pr_tracking.judgment_key(pr, jobs)
            try:
                thread = await thread_details(pr["id"])
            except Exception as error:
                print(f"[github] could not read {pr['id']} to judge it: {error}")
                failed_at[pr["id"]] = time.monotonic()
                continue
            text = f"## PR {pr['id']}: {thread['title']}\n{thread['url']}\n"
            conflicts = {"yes": "no", "conflicts": "YES, it has merge conflicts", "unknown": "not known yet (GitHub is still working it out: don't count it as a conflict)"}[pr["mergeable"]]
            text += f"GitHub draft: {'yes' if thread['draft'] else 'no'}. Merge conflicts with {thread['base']}: {conflicts}. "
            text += f"Checks of the newest commit: {pr['checks']}"
            if pr.get("failed_checks"):
                text += f" (failed: {', '.join(pr['failed_checks'])})"
            if pr["waiting_runs"] > 0:
                text += f" ({pr['waiting_runs']} GitHub Actions runs wait for a maintainer to approve them)"
            text += f". Labels: {', '.join(pr['labels']) or 'none'}.\n"
            head = pr["head"]["sha"][:10] if pr["head"] is not None else "gone"
            text += f"Newest commit: {head} at {pr.get('head_at')}. Our newest comment or review: {pr['your_last_at']}.\n"
            text += f"Description:\n{(thread['body'] or '')[:JUDGE_BODY_CHARS]}\n"
            text += f"Timeline, oldest first ({thread['hidden']} earlier items left out):\n"
            for item in thread["timeline"][-40:]:
                who = item.get("login", "ghost")
                if item.get("mine") or who == you:
                    who += " (you)"
                if item.get("bot"):
                    who += " (bot)"
                if item.get("role"):
                    who += f" [{item['role']}]"
                if item["type"] == "comment":
                    text += f"- {item['at']} {who} commented: {item['body'][:JUDGE_COMMENT_CHARS]}\n"
                if item["type"] == "review":
                    text += f"- {item['at']} {who} reviewed ({item['state']}): {item['body'][:JUDGE_COMMENT_CHARS]}\n"
                    for comment in item["comments"][:10]:
                        text += f"    on {comment['path']}:{comment['line']}, {comment['login']}: {comment['body'][:JUDGE_LINE_CHARS]}\n"
                if item["type"] == "commit":
                    text += f"- {item['at']} commit {item['sha'][:10]} by {item['login']}: {item['message'].splitlines()[0] if item['message'] else ''}\n"
                if item["type"] == "event":
                    text += f"- {item['at']} {who} {item['text']}\n"
            for issue in pr["issues"][:2]:
                try:
                    linked = await thread_details(f"{pr['repo']}#{issue['number']}")
                except Exception:
                    continue
                comments = [item for item in linked["timeline"] if item["type"] == "comment"]
                text += f"The issue it fixes, #{issue['number']} ({linked['state']}), its newest comments:\n"
                for item in comments[-8:]:
                    who = item["login"] + (" (you)" if item.get("mine") or item["login"] == you else "") + f" [{item['role']}]"
                    text += f"- {item['at']} {who}: {item['body'][:JUDGE_COMMENT_CHARS]}\n"
            linked_ids = [f"{pr['repo']}#{issue['number']}".lower() for issue in pr["issues"]]
            own = [job for job in jobs if job["thread"] == pr["id"] or (job["issue"] or "").lower() in linked_ids or (job["thread"] or "").lower() in linked_ids]
            own.sort(key=lambda job: job["updated_at"])
            if own:
                text += "What our agents' newest jobs on it said:\n"
            for job in own[-3:]:
                said = job.get("notes") or job.get("headline") or ""
                # Which thread: a follow-up on the issue it fixes answers that issue's comments there.
                text += f"- {job['updated_at']} {job['kind']} on {job['thread'] or job['issue']}, {job['status']}: {said[:800]}\n"
            texts.append(text)
        if not texts:
            continue
        prompt = (
            f"The pull requests below were opened by the GitHub user {you} (the user), with the help of our AI agents, "
            "who write the code, replies, rebases and new versions for them. For each one, decide whether it needs "
            "something from our side NOW to move on, or whether it waits on others: the maintainers' review, their OK "
            "to run CI for a first-time contributor, a re-review after we answered, the merge.\n"
            "- A request from a reviewer or maintainer (in a review, a comment, a comment on a line, or on the issue the "
            "PR fixes) that we haven't done: compare its time with our newest commit and our replies. A reply that only "
            "promises it, without the commit, is not done. What our agents' jobs said is no proof: check the commits.\n"
            "- Once we pushed and/or replied to a request, it waits on the reviewer: no action, even while GitHub still "
            "shows changes requested.\n"
            "- A comment on the issue the PR fixes is answered on that issue, by its own follow-up job (below, \"on\" "
            "that issue): it needs action on the PR only when it asks for a change to the PR's code or text that isn't "
            "done yet.\n"
            "- Failed checks need action only when our change causes them or we must fix them (lint, tests of our code, "
            "a DCO sign-off, a check of the PR's text). A failure of infrastructure, a flaky test, a check of other code, "
            "or a gate that waits for a maintainer's label or approval: no action. Failures we already explained on the "
            "PR as not our change's (a reply of ours after them), with no newer commit or check run since: no action.\n"
            "- Merge conflicts only when the line above says YES. A branch that is only behind its base is no conflict and "
            "needs no rebase, unless a maintainer or the project's rules ask for one.\n"
            "- A CLA that isn't signed: action (our agent finds out whether it really blocks the merge and settles it).\n"
            "- A GitHub draft PR: our agents can't mark it ready for review (no tool does). When a bot or the project's "
            "gate keeps it a draft until a checklist or check passes, only what of that is ours and not done yet is "
            "action (a box to tick in the description, a failing check of our change); once that is done it waits on "
            "the gate or a maintainer (their label, their OK to run the workflows, the gate's next run): no action. Also "
            "when the project only waits for its author to mark it ready: nothing of ours can.\n"
            "- A bot or maintainer saying something the project requires is missing (a template field, a changelog "
            "entry, an attachment, a rebase): action.\n"
            "- A description that claims what the commits don't have: action.\n"
            "- Real findings of a review bot (CodeRabbit, Codex, Copilot, ...) not yet fixed or answered: action; ones "
            "already answered or that don't apply: no.\n"
            "- Thank-yous, approvals with no asks, a maintainer saying they'll look later, bot notes with no findings, "
            "coverage reports: no action.\n"
            "reasons: the kinds of what is needed (Changes requested also for a request made in a comment). detail: when "
            "action is needed, one to three plain sentences saying exactly what has to be done, with who asked and when "
            "(it is handed to our agent as its task); empty otherwise. Everything that needs action is our agents' to "
            "settle, never the user's: they write code, new versions and rebases, replies, new titles and descriptions, "
            "and close the PR when only something they can't do would move it on. Never ask them to mark it ready for "
            "review, change its labels, request reviewers, or approve or re-run checks, which no tool of theirs does. "
            "When only the maintainers or the project's gate can move it on: no action.\n"
            "Answer for every pull request, by its id.\n\n" + "\n\n".join(texts)
        )
        try:
            answer = await judge(prompt, JUDGE_SCHEMA, "medium")
        except Exception as error:
            # Any failure (no valid answer, an API error or a usage limit ending Claude Code): tried again later.
            print(f"[github] could not judge {', '.join(keys)}: {error}")
            for pr_id in keys:
                failed_at[pr_id] = time.monotonic()
            continue
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        answered = []
        for each in answer["prs"]:
            if each["id"] not in keys:
                continue
            answered.append(each["id"])
            reasons = [reason for reason in each["reasons"] if reason in JUDGE_REASONS]
            if each["needs_action"] and not reasons:
                reasons = ["Other"]
            if not each["needs_action"]:
                reasons = []
            pr = [one for one in batch if one["id"] == each["id"]][0]
            judgment = {
                "key": keys[each["id"]], "needs": each["needs_action"], "reasons": reasons,
                "detail": each["detail"] if each["needs_action"] else "", "judged_at": now,
                "head": pr["head"]["sha"] if pr["head"] is not None else "", "failed_checks": pr.get("failed_checks", []),
            }
            pr_tracking.set_judgment(each["id"], judgment)
        # One Claude left out is tried again later.
        for pr_id in keys:
            if pr_id not in answered:
                failed_at[pr_id] = time.monotonic()


async def keep_prs() -> None:
    """Runs as long as the backend. One that fails to read shows its error and is tried again next round. After every
    read, the threads that need their agent go to it; one that fails to is tried again after the next read. Every round,
    what each open PR of yours needs from us is worked out again (pr_tracking.update_actions), Claude judges the ones that
    changed (judge_prs, one batch at a time), a PR that needs action with no job open on it goes to its agent, the
    agents working on one get priority (agents.set_pr_priority), and the agents reviewing a PR draft come next
    (agents.set_review_priority)."""
    last = None
    # The sent drafts a refresh has already seen.
    tried = set()
    # The read the follow-ups last ran after (pr_tracking's checked_at).
    followed_up = None
    # The judgment running now, and when each PR whose judgment failed was tried.
    judging = None
    failed_at = {}
    while True:
        # Every refresh_prs_minutes, the board's setting (the robot over the Issues board).
        rules = dict(AUTO_REMOVE_OFF)
        try:
            rules.update(json.loads(AUTO_REMOVE_FILE.read_text()))
        except (OSError, ValueError):
            # Not saved yet, or broken by hand: the defaults for this round.
            pass
        sent = [draft["id"] for draft in inbox.list() if draft["sent"] is not None]
        new = [draft_id for draft_id in sent if draft_id not in tried]
        if new or pr_tracking.wanted or last is None or time.monotonic() - last > rules["refresh_prs_minutes"] * 60:
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

        try:
            all_jobs = agents.jobs.list()
            # What each open PR of yours needs from us now: the board's Needs action, else Waiting approval.
            pr_tracking.update_actions(all_jobs)
            prs = [pr for pr in pr_tracking.summary()["items"] if pr["relation"] == "author" and pr["state"] == "open"]
            judgments = pr_tracking.data["judgments"]
            settings = pr_tracking.data["agent_settings"]
            # Each PR's jobs: follow-ups on it, and the jobs on the issues it fixes (follow-ups on them too).
            own = {}
            for pr in prs:
                linked = [f"{pr['repo']}#{issue['number']}".lower() for issue in pr["issues"]]
                own[pr["id"]] = [job for job in all_jobs if job["thread"] == pr["id"] or (job["issue"] or "").lower() in linked or (job["thread"] or "").lower() in linked]

            # Claude judges the ones that changed since their judgment, and none with a job open: its agent is on it.
            if judging is None or judging.done():
                due = []
                for pr in prs:
                    if [job for job in own[pr["id"]] if job["status"] in ["queued", "working", "waiting_on_user"]]:
                        continue
                    if pr["id"] in failed_at and time.monotonic() - failed_at[pr["id"]] < JUDGE_RETRY_SECONDS:
                        continue
                    judgment = judgments.get(pr["id"])
                    if judgment is None or judgment["key"] != pr_tracking.judgment_key(pr, all_jobs):
                        due.append(pr)
                if due:
                    judging = asyncio.create_task(judge_prs(due, all_jobs, failed_at))

            # One that needs action with no job open on it goes to its agent, ACTION_TRIES times at most on the same newest
            # commit, each time after a new judgment, and again only once something changed on it since the last time. Only
            # once Claude read it as it is now: what happened since needs_reply gives already, and may need nothing.
            followed_issues = pr_tracking.summary()["issues"]
            for pr in prs:
                action = pr.get("action")
                if action is None or not action["needs"] or pr["agent"] is None or pr["agent"] not in agents.agents:
                    continue
                judgment = judgments.get(pr["id"])
                if judgment is None or judgment["key"] != pr_tracking.judgment_key(pr, all_jobs):
                    continue
                # A draft you approved and didn't send is yours to send: nothing for the agent.
                if action["reasons"] == ["Not sent"]:
                    continue
                if pr["agent_mode"] != "drafts" or workflow.get(pr["repo"]) is not None:
                    continue
                if [job for job in own[pr["id"]] if job["status"] in ["queued", "working", "waiting_on_user", "paused"]]:
                    continue
                # Tries count per newest commit: the reasons Claude gives can change from one judgment to the next.
                head = pr["head"]["sha"] if pr["head"] is not None else ""
                base = head
                judged_at = (judgments.get(pr["id"]) or {}).get("judged_at", "")
                key = ",".join(action["reasons"]) + "|" + head + "|" + judged_at
                setting = settings.get(pr["id"], {})
                tries = setting.get("action_tries", 0) if setting.get("action_base") == base else 0
                if setting.get("action_key") == key or tries >= ACTION_TRIES:
                    continue
                # Nothing changed on it since its last job was given this, apart from what we did ourselves (a reply): that
                # job ended, having settled it or found nothing we can do (lancedb#4922: failures it had explained on the
                # PR as not ours, given again on the same commit; opencodex#8556: a draft only the project's gate or a
                # maintainer could lift, given three times). It goes again only once something really changed: a new
                # commit, its checks, a conflict (GitHub's word), the draft state, its labels, someone else's comment or
                # review (a bot's too, a gate's), or a new comment on an issue it fixes.
                linked = [f"{pr['repo']}#{issue['number']}".lower() for issue in pr["issues"]]
                issues_at = ""
                for issue in followed_issues:
                    if issue["id"].lower() in linked and issue["last_activity"] is not None:
                        issues_at = max(issues_at, issue["last_activity"]["at"])
                state = [
                    head, pr["checks"], sorted(set(pr.get("failed_checks", []))), pr["mergeable"] == "conflicts", pr["draft"],
                    sorted(pr["labels"]), (pr["last_activity"] or {}).get("at"), (pr["bot_activity"] or {}).get("at"), issues_at,
                ]
                if setting.get("action_state") == state:
                    continue
                reason = "it needs action from us: " + ", ".join(action["reasons"])
                if action["detail"]:
                    reason += f" ({action['detail']})"
                if "CLA not signed" in action["reasons"]:
                    reason += (
                        ". The user signs nothing: settle the CLA as Nothing waits on the user says (no blocker when it is "
                        "signed or on its way, or the project merges the user's PRs with it pending; else close the PR)"
                    )
                if tries > 0:
                    reason += f". Your last job on it ended without settling this, and something changed on it since; this is try {tries + 1} of {ACTION_TRIES}"
                entry = {
                    "id": pr["id"], "kind": "pr", "relation": "author", "state": "open", "title": pr["title"], "url": pr["url"],
                    "agent": pr["agent"], "reason": reason, "at": None, "failed_sha": None, "head": pr["head"],
                    "base": pr["base"], "signals": None,
                }
                if agents.follow_up(entry) is not None:
                    pr_tracking.mark_action_given(pr["id"], base, key, state)

            # The agents working on a PR that needs action go first in the VM's line.
            first = set()
            for pr in prs:
                action = pr.get("action")
                if action is None or not action["needs"]:
                    continue
                for job in own[pr["id"]]:
                    if job["status"] in ["queued", "working"]:
                        first.add(job["agent"])
            agents.set_pr_priority(first)
            # Then the agents reviewing a PR draft before the Inbox (the board's Review), ahead of In progress and Catalog.
            reviewing = set()
            for job in all_jobs:
                if job["kind"] == "review" and job["status"] in ["queued", "working"]:
                    reviewing.add(job["agent"])
            agents.set_review_priority(reviewing)
        except Exception as error:
            # A file or an agent failed: the next round tries again.
            print(f"[github] could not work out what your PRs need: {error}")
        await asyncio.sleep(PRS_CHECK_SECONDS)
