"""Your PRs on GitHub and how each one stands, for the PRs page (frontend/src/PRs.tsx).

Which PRs: every PR the Inbox's Approve sent (a draft's "sent", github_account.py), and, with your GitHub
account connected, your other open and closed PRs on other people's projects (a search for author:<you>), so
the ones you sent by hand are there too. Read with the search tokens (token_balancer.py), never your own.

For each PR it keeps, in DATA_DIR/pr_tracking.json, by "owner/name#number":

    {"id", "repo", "number", "title", "url", "author",
     "state": "open" | "merged" | "closed", "draft": bool (GitHub's draft PR),
     "opened_at", "updated_at", "closed_at": str | None, "merged_by": str | None,
     "labels": [name, ...],
     "checks": "waiting" | "running" | "passed" | "failed" | "none",
     "waiting_runs": int,
     "review": "approved" | "changes_requested" | "commented" | "none",
     "reviewers": [{"login", "state", "at", "role"}, ...] (each reviewer's latest review),
     "comments": int, "last_comment": {"login", "role", "at", "text"} | None,
     "issues": [{"number", "title", "url", "state": "open" | "closed", "reason", "assignees"}, ...],
     "draft_id": "draft_..." | None, "job": "job_..." | None, "agent": "<agent id>" | None,
     "checked_at", "error": str | None}

checks is the newest commit's checks: waiting when any of the project's GitHub Actions runs on it waits for a
maintainer to approve it (GitHub does that for a first-time contributor: nothing runs until someone clicks
Approve, and the checks list shows nothing), else running, passed or failed, or none when the project has no
checks. review weighs each reviewer's latest review: approved (and nobody asks for changes), changes_requested,
commented, or none. issues are the issues the PR says it fixes. role is GitHub's word for the person (MEMBER,
COLLABORATOR, OWNER, CONTRIBUTOR, NONE, or BOT). draft_id, job and agent link a PR the app sent to its draft.

refresh() reads them all again, one GraphQL query and one Actions call each; the backend calls it every few
minutes and at once when a PR was just sent (backend/prs_api.py). A PR that fails to read keeps its last
status, with the error. error at the top is why the search for your PRs failed. version goes up on every change.
"""

import copy
import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.search import get_action_runs, get_pr_status, search_issues

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# How much of the latest comment is kept.
COMMENT_CHARS = 300
ROLLUP = {"SUCCESS": "passed", "FAILURE": "failed", "ERROR": "failed", "PENDING": "running", "EXPECTED": "running"}


class PRTracking:
    def __init__(self, inbox, github_account):
        self.inbox = inbox
        self.github_account = github_account
        self.path = DATA_DIR / "pr_tracking.json"
        self.lock = threading.Lock()
        # One refresh at a time: Check now and the background one.
        self.refresh_lock = threading.Lock()
        self.refreshing = False
        self.version = 0
        self.data = {"prs": {}, "checked_at": None, "error": None}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.data))
        temporary.replace(self.path)

    def summary(self) -> dict:
        """For the live feed: every PR, the newest change first."""
        with self.lock:
            items = sorted(self.data["prs"].values(), key=lambda pr: pr["updated_at"], reverse=True)
            return {"items": copy.deepcopy(items), "checked_at": self.data["checked_at"], "error": self.data["error"], "refreshing": self.refreshing}

    def refresh(self) -> None:
        """Read every PR to follow from GitHub again. Runs in a thread; a second call waits for the first."""
        with self.refresh_lock:
            with self.lock:
                self.refreshing = True
                self.version += 1
            try:
                self.read_all()
            finally:
                with self.lock:
                    self.refreshing = False
                    self.version += 1

    def read_all(self) -> None:
        # The PRs the app sent, with their drafts.
        follow = {}
        for draft in self.inbox.list():
            sent = draft["sent"]
            if sent is not None and sent["kind"] == "pr":
                follow[f"{sent['repo']}#{sent['number']}"] = {"draft_id": draft["id"], "job": draft["job"], "agent": draft["agent"]}
        # Yours on other people's projects, also the ones sent by hand.
        error = None
        account = self.github_account.status()
        if account["connected"]:
            login = account["login"]
            try:
                result = search_issues(f"is:pr author:{login} -user:{login}")
                for item in result["items"]:
                    repo = item["repository_url"].removeprefix("https://api.github.com/repos/")
                    pr_id = f"{repo}#{item['number']}"
                    if pr_id not in follow:
                        follow[pr_id] = {"draft_id": None, "job": None, "agent": None}
            except Exception as problem:
                error = f"Could not search GitHub for your PRs: {problem}"

        for pr_id, link in follow.items():
            repo = pr_id.split("#")[0]
            number = int(pr_id.split("#")[1])
            now = datetime.now(UTC).isoformat()
            try:
                pull = get_pr_status(repo.split("/")[0], repo.split("/")[1], number)
                if pull is None:
                    raise ValueError("GitHub has no such PR anymore.")
                runs = []
                if pull["commits"]["nodes"]:
                    runs = get_action_runs(repo.split("/")[0], repo.split("/")[1], pull["commits"]["nodes"][0]["commit"]["oid"])
            except Exception as problem:
                with self.lock:
                    if pr_id in self.data["prs"]:
                        self.data["prs"][pr_id]["error"] = str(problem)
                        self.data["prs"][pr_id]["checked_at"] = now
                        self.data["prs"][pr_id].update(link)
                        self.save()
                continue

            # The newest commit's checks; runs waiting for a maintainer's approval show nowhere else.
            checks = "none"
            rollup = None
            if pull["commits"]["nodes"]:
                rollup = pull["commits"]["nodes"][0]["commit"]["statusCheckRollup"]
            if rollup is not None:
                checks = ROLLUP.get(rollup["state"], "running")
            waiting_runs = len([run for run in runs if run["conclusion"] == "action_required"])
            if waiting_runs > 0:
                checks = "waiting"

            # Each reviewer's latest review, not the PR's author's own.
            latest = {}
            for review in pull["reviews"]["nodes"]:
                if review["author"] is None or review["state"] == "PENDING":
                    continue
                login = review["author"]["login"]
                if pull["author"] is not None and login == pull["author"]["login"]:
                    continue
                role = review["authorAssociation"]
                if review["author"]["__typename"] == "Bot":
                    role = "BOT"
                latest[login] = {"login": login, "state": review["state"].lower(), "at": review["submittedAt"], "role": role}
            states = [reviewer["state"] for reviewer in latest.values()]
            review = "none"
            if "commented" in states:
                review = "commented"
            if "changes_requested" in states:
                review = "changes_requested"
            elif pull["reviewDecision"] == "APPROVED" or "approved" in states:
                review = "approved"

            last_comment = None
            if pull["comments"]["nodes"]:
                comment = pull["comments"]["nodes"][0]
                login = comment["author"]["login"] if comment["author"] else "ghost"
                role = comment["authorAssociation"]
                if comment["author"] is not None and comment["author"]["__typename"] == "Bot":
                    role = "BOT"
                text = " ".join(comment["body"].split())
                if len(text) > COMMENT_CHARS:
                    text = text[:COMMENT_CHARS - 1] + "…"
                last_comment = {"login": login, "role": role, "at": comment["createdAt"], "text": text}

            issues = []
            for issue in pull["closingIssuesReferences"]["nodes"]:
                reason = None
                if issue["stateReason"] is not None:
                    reason = issue["stateReason"].lower()
                issues.append({
                    "number": issue["number"],
                    "title": issue["title"],
                    "url": issue["url"],
                    "state": issue["state"].lower(),
                    "reason": reason,
                    "assignees": [person["login"] for person in issue["assignees"]["nodes"]],
                })

            record = {
                "id": pr_id,
                "repo": repo,
                "number": number,
                "title": pull["title"],
                "url": pull["url"],
                "author": pull["author"]["login"] if pull["author"] else "ghost",
                "state": pull["state"].lower(),
                "draft": pull["isDraft"],
                "opened_at": pull["createdAt"],
                "updated_at": pull["updatedAt"],
                "closed_at": pull["closedAt"],
                "merged_by": pull["mergedBy"]["login"] if pull["mergedBy"] else None,
                "labels": [label["name"] for label in pull["labels"]["nodes"]],
                "checks": checks,
                "waiting_runs": waiting_runs,
                "review": review,
                "reviewers": list(latest.values()),
                "comments": pull["comments"]["totalCount"],
                "last_comment": last_comment,
                "issues": issues,
                "draft_id": link["draft_id"],
                "job": link["job"],
                "agent": link["agent"],
                "checked_at": now,
                "error": None,
            }
            with self.lock:
                self.data["prs"][pr_id] = record
                self.save()

        with self.lock:
            # Only the PRs still followed: one the search no longer finds goes too, unless the search failed.
            for pr_id in list(self.data["prs"]):
                if pr_id not in follow and error is None:
                    del self.data["prs"][pr_id]
            self.data["checked_at"] = datetime.now(UTC).isoformat()
            self.data["error"] = error
            self.save()
