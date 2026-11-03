"""The Workflow tab: your own repositories that agents develop one confined issue at a time, each as a pull request that
the review agent checks before you merge or reject it (or, when you let it, the review agent does). It is apart from
Development (projects.py): its own repositories, agents, issues and pull requests, on the same VMs, desktops, jobs and
tools. backend/workflow_api.py runs it, frontend/src/Workflow.tsx shows it.

A repository here has agents of its own (backend/workflow_api.py, workflow_agents), their records' "workflow" (the repo)
and "workflow_role":
- its chat agent ("chat"): where you ask for things. It writes them as issues, each one clearly confined goal.
- its workers ("worker"), "agents" of them: each takes the next open issue as a fix_issue job, reproduces it, does
  exactly what it asks and nothing else, tests it and makes a pull request (draft_pr). What it finds on the way becomes
  a new issue, never part of its work.
- its review agent ("reviewer"): reviews every pull request, the workers' and the ones opened on GitHub by hand (yours):
  it runs the change and sees its effect, then advises merge or don't merge, with what you must know.
They work in the repository's VM ("vm"), each on a desktop of its own; the chat agent needs none.

Settings, per repository:
- prs_on: "seraph": issues and pull requests are kept here, so nothing an agent writes goes to GitHub; merging puts the
  change on the default branch on GitHub as one commit, as you. "github": issues and pull requests are on GitHub, as
  you: a worker's pull request opens there at once and the review is a comment on it; merging is GitHub's squash merge.
  It only changes while the repository has no issues or pull requests yet.
- decides: "you": merging and rejecting are your clicks, the review agent's advice is only shown. "agent": its advice
  is the decision, carried out the same way.
- agents: how many workers, 1 to MAX_AGENTS. on: whether workers take new issues.

Kept in DATA_DIR/workflow.json, a list:

    {"repo": "owner/name", "on", "prs_on", "decides", "agents", "vm", "chat", "workers": [agent ids], "reviewer",
     "next_number": the next issue or pull request number kept here, "issues": {"<n>": Issue}, "prs": {"<n>": PR},
     "error": why the last round failed | "", "created_at"}

    Issue: {"number", "title", "goal": one sentence, "requirements": [text, ...] (empty: not confined yet, its worker
            does that first), "validation": how to check it is done, "state": "open" | "closed",
            "reason": why it closed (REASONS) | None, "why": the words that came with it | "",
            "by": "you" | "github" (opened on GitHub by hand) | the agent's id, "found_in": the issue or pull request it
            was found while working on | None, "url": on GitHub | None, "agent": its worker | None, "job" | None,
            "pr": its newest pull request | None, "stopped": its job was cancelled; not given out again until Try again,
            "created_at", "closed_at" | None, "at"}
    PR:    {"number", "id": its parts' file, "title", "by": the worker's id | "you" (opened on GitHub by hand),
            "author": that one's GitHub login | None, "issue" | None, "job" | None, "agent" | None,
            "state": "review" (the review agent is on it) | "waiting" (reviewed, waiting for the decision) | "merged" |
                     "rejected" | "closed" (closed on GitHub by hand),
            "url": on GitHub | None, "github": its number on GitHub | None, "head": its newest commit there | None,
            "area": its title's scope | "", "files": [{"path", "added", "removed"}], "added", "removed",
            "review": {"agent", "job", "advice": "merge" | "dont_merge" | None, "summary": what changes, in a line,
                       "important": [text, ...], "checked": what it ran, "evidence": [Evidence, ...], "at"} | None,
            "decision": {"by": "you" | "agent", "action": "merge" | "reject", "reason", "at"} | None,
            "checks": GitHub's checks | None, "mergeable": GitHub's | None, "error": why the last merge failed | "",
            "created_at", "at"}

What a worker's pull request is made of (written once) is a file of its own, DATA_DIR/workflow_prs/<id>.json:
{"body", "overview", "diff", "commits", "base", "base_sha", "branch", "path", "vm", "evidence", "tests"}; one opened on
GitHub by hand has {"body", "diff"}. The live feed carries the records only.

Everything on GitHub is done as you (your_repositories.client(), your sign-in). A ValueError says what GitHub answered;
Conflict says a pull request no longer goes onto the newest default branch.

version goes up on every change, for the live feed (topic "workflow").
"""

import copy
import json
import os
import re
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

from github_searcher.github_account import API, SendError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
PARTS_DIR = DATA_DIR / "workflow_prs"
PRS_ON = ["seraph", "github"]
DECIDES = ["you", "agent"]
MAX_AGENTS = 3
# Why an issue closed, in words for the page and for GitHub.
REASONS = {
    "merged": "its pull request was merged",
    "duplicate": "it repeats another issue, or work that is done already",
    "not_valid": "it isn't a valid issue",
    "cannot_reproduce": "it can't be reproduced on the newest code",
    "too_big": "it is more than one pull request: it was split into smaller issues",
    "by_you": "you closed it",
    "on_github": "it was closed on GitHub",
}
# A pull request opened on GitHub by hand: its diff is read up to this size.
DIFF_LIMIT = 2_000_000
# Its changed files are read up to this many pages of 100.
FILE_PAGES = 3


class Conflict(ValueError):
    """The pull request's change doesn't go onto the newest default branch anymore."""


class Workflow:
    def __init__(self, your_repositories, github_account):
        # Your sign-in: every GitHub call here acts as you.
        self.your_repositories = your_repositories
        # Opening a worker's pull request on GitHub and merging one kept here build its commit the way the Inbox's
        # Approve does (github_account.py).
        self.github_account = github_account
        self.path = DATA_DIR / "workflow.json"
        self.lock = threading.Lock()
        self.version = 0
        self.repos: list[dict] = []
        if self.path.exists():
            self.repos = json.loads(self.path.read_text())
        # Called when there is work for a round now (backend/workflow_api.py sets it). Only from the event loop.
        self.wake = lambda: None
        # How many workers' pull requests are being opened on GitHub right now (add_pr): until each is kept here, a round
        # would take it for one opened by hand.
        self.opening = 0

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.repos, indent=2))
        temporary.replace(self.path)

    def list(self) -> list[dict]:
        with self.lock:
            return copy.deepcopy(self.repos)

    def get(self, repo: str | None) -> dict | None:
        """The repository's record (owner/name, any case), or None when it isn't on the Workflow tab."""
        if repo is None:
            return None
        with self.lock:
            for record in self.repos:
                if record["repo"].lower() == repo.lower():
                    return copy.deepcopy(record)
        return None

    def create(self, repo: str, vm: str, prs_on: str, decides: str) -> dict:
        if prs_on not in PRS_ON or decides not in DECIDES:
            raise ValueError("Pull requests are in Seraph or on GitHub, and you or the review agent decides.")
        with self.lock:
            for record in self.repos:
                if record["repo"].lower() == repo.lower():
                    raise ValueError(f"{repo} is on the Workflow tab already")
            record = {
                "repo": repo,
                "on": True,
                "prs_on": prs_on,
                "decides": decides,
                "agents": 2,
                "vm": vm,
                "chat": None,
                "workers": [],
                "reviewer": None,
                "next_number": 1,
                "issues": {},
                "prs": {},
                "error": "",
                "created_at": datetime.now(UTC).isoformat(),
            }
            self.repos.append(record)
            self.save()
            return copy.deepcopy(record)

    def update(self, repo: str, **fields) -> dict:
        """Change some of a repository's fields. Returns the record as it is now."""
        allowed = ["on", "prs_on", "decides", "agents", "vm", "chat", "workers", "reviewer", "error"]
        for name in fields:
            if name not in allowed:
                raise ValueError(f"A repository's {name} can't be changed")
        if "prs_on" in fields and fields["prs_on"] not in PRS_ON:
            raise ValueError(f"Pull requests are one of: {', '.join(PRS_ON)}")
        if "decides" in fields and fields["decides"] not in DECIDES:
            raise ValueError(f"Who decides is one of: {', '.join(DECIDES)}")
        if "agents" in fields and (fields["agents"] < 1 or fields["agents"] > MAX_AGENTS):
            raise ValueError(f"A repository has 1 to {MAX_AGENTS} workers")
        with self.lock:
            for record in self.repos:
                if record["repo"].lower() != repo.lower():
                    continue
                if "prs_on" in fields and fields["prs_on"] != record["prs_on"] and (record["issues"] or record["prs"]):
                    raise ValueError("Where pull requests and issues are can only change while the repository has none yet.")
                # Nothing changed: no new version, so the live feed doesn't send it again every round.
                if all(record[name] == value for name, value in fields.items()):
                    return copy.deepcopy(record)
                record.update(copy.deepcopy(fields))
                self.save()
                return copy.deepcopy(record)
        raise KeyError(f"{repo} isn't on the Workflow tab")

    def remove(self, repo: str) -> None:
        """Forget the repository, its issues and pull requests (backend/workflow_api.py archives its agents first)."""
        with self.lock:
            self.repos = [record for record in self.repos if record["repo"].lower() != repo.lower()]
            self.save()

    def set_issue(self, repo: str, number: int, fields: dict) -> None:
        """Change what is known of one issue. "at" becomes now."""
        with self.lock:
            for record in self.repos:
                if record["repo"].lower() != repo.lower() or str(number) not in record["issues"]:
                    continue
                issue = record["issues"][str(number)]
                issue.update(copy.deepcopy(fields))
                issue["at"] = datetime.now(UTC).isoformat()
                self.save()

    def set_pr(self, repo: str, number: int, fields: dict) -> None:
        """Change what is known of one pull request. "at" becomes now."""
        with self.lock:
            for record in self.repos:
                if record["repo"].lower() != repo.lower() or str(number) not in record["prs"]:
                    continue
                pr = record["prs"][str(number)]
                pr.update(copy.deepcopy(fields))
                pr["at"] = datetime.now(UTC).isoformat()
                self.save()

    def parts(self, pr_id: str) -> dict:
        """What a pull request is made of (its diff, text, overview, commits, evidence and test runs)."""
        path = PARTS_DIR / f"{pr_id}.json"
        if not path.is_file():
            return {"body": "", "diff": ""}
        return json.loads(path.read_text())

    def write_parts(self, pr_id: str, parts: dict) -> None:
        PARTS_DIR.mkdir(parents=True, exist_ok=True)
        temporary = PARTS_DIR / f"{pr_id}.json.tmp"
        temporary.write_text(json.dumps(parts))
        temporary.replace(PARTS_DIR / f"{pr_id}.json")

    def add_issue(self, repo: str, fields: dict) -> dict:
        """A new issue, from fields {"title", "goal", "requirements", "validation", "by", "found_in"}. In Seraph it gets
        the next number; on GitHub it is opened there as you first, and has GitHub's number. In a thread."""
        record = self.get(repo)
        if record is None:
            raise KeyError(f"{repo} isn't on the Workflow tab")
        number = None
        url = None
        if record["prs_on"] == "github":
            body = fields["goal"]
            if fields["requirements"]:
                body += "\n\n## Requirements\n" + "\n".join(f"- [ ] {item}" for item in fields["requirements"])
            if fields["validation"]:
                body += f"\n\n## How to check\n{fields['validation']}"
            if fields["found_in"] is not None:
                body += f"\n\nFound while working on #{fields['found_in']}."
            with self.your_repositories.client() as client:
                response = client.post(f"/repos/{repo}/issues", json={"title": fields["title"], "body": body})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            number = response.json()["number"]
            url = response.json()["html_url"]
        now = datetime.now(UTC).isoformat()
        with self.lock:
            for each in self.repos:
                if each["repo"].lower() != repo.lower():
                    continue
                if number is None:
                    number = each["next_number"]
                    each["next_number"] += 1
                issue = {
                    "number": number,
                    "title": fields["title"],
                    "goal": fields["goal"],
                    "requirements": list(fields["requirements"]),
                    "validation": fields["validation"],
                    "state": "open",
                    "reason": None,
                    "why": "",
                    "by": fields["by"],
                    "found_in": fields["found_in"],
                    "url": url,
                    "agent": None,
                    "job": None,
                    "pr": None,
                    "stopped": False,
                    "created_at": now,
                    "closed_at": None,
                    "at": now,
                }
                each["issues"][str(number)] = issue
                self.save()
                return copy.deepcopy(issue)
        raise KeyError(f"{repo} isn't on the Workflow tab")

    def add_github_issue(self, repo: str, item: dict) -> None:
        """An issue opened on GitHub by hand (github_issues()), with GitHub's number: not written down yet, its worker does
        that first (issue_scope)."""
        now = datetime.now(UTC).isoformat()
        with self.lock:
            for each in self.repos:
                if each["repo"].lower() != repo.lower() or str(item["number"]) in each["issues"]:
                    continue
                each["issues"][str(item["number"])] = {
                    "number": item["number"],
                    "title": item["title"],
                    "goal": "",
                    "requirements": [],
                    "validation": "",
                    "state": "open",
                    "reason": None,
                    "why": "",
                    "by": "github",
                    "found_in": None,
                    "url": item["url"],
                    "agent": None,
                    "job": None,
                    "pr": None,
                    "stopped": False,
                    "created_at": now,
                    "closed_at": None,
                    "at": now,
                }
                self.save()

    def close_issue(self, repo: str, number: int, reason: str, why: str) -> None:
        """Close an issue (reason: REASONS), with why. On GitHub it is closed there too, as you, with why as a comment:
        completed for a merge, else not planned. In a thread."""
        record = self.get(repo)
        if record is None or str(number) not in record["issues"]:
            raise KeyError(f"No issue #{number} in {repo}")
        issue = record["issues"][str(number)]
        if issue["url"] is not None and reason != "on_github":
            state_reason = "completed" if reason == "merged" else "not_planned"
            with self.your_repositories.client() as client:
                if why:
                    response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": why})
                    if response.status_code >= 400:
                        raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
                response = client.patch(f"/repos/{repo}/issues/{number}", json={"state": "closed", "state_reason": state_reason})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
        self.set_issue(repo, number, {"state": "closed", "reason": reason, "why": why, "closed_at": datetime.now(UTC).isoformat()})

    def add_pr(self, repo: str, fields: dict, parts: dict) -> dict:
        """A worker's new pull request (work_tools.py draft_pr), from fields {"title", "by", "issue", "job", "agent",
        "area", "files", "added", "removed"} and its parts. On GitHub it is opened there as you first, and has GitHub's
        number; in Seraph the next number. Its issue's "pr" becomes it. In a thread."""
        record = self.get(repo)
        if record is None:
            raise KeyError(f"{repo} isn't on the Workflow tab")
        pr_id = "wpr_" + secrets.token_hex(4)
        github = None
        url = None
        with self.lock:
            self.opening += 1
        try:
            if record["prs_on"] == "github":
                sent = self.open_on_github(repo, pr_id, fields["title"], parts, fields["issue"])
                github = sent["number"]
                url = sent["url"]
            self.write_parts(pr_id, parts)
            return self.keep_pr(repo, pr_id, github, url, fields)
        finally:
            with self.lock:
                self.opening -= 1

    def keep_pr(self, repo: str, pr_id: str, github: int | None, url: str | None, fields: dict) -> dict:
        """The record of a worker's new pull request (add_pr), once it is on GitHub when it goes there."""
        now = datetime.now(UTC).isoformat()
        with self.lock:
            for each in self.repos:
                if each["repo"].lower() != repo.lower():
                    continue
                number = github
                if number is None:
                    number = each["next_number"]
                    each["next_number"] += 1
                pr = {
                    "number": number,
                    "id": pr_id,
                    "title": fields["title"],
                    "by": fields["by"],
                    "author": None,
                    "issue": fields["issue"],
                    "job": fields["job"],
                    "agent": fields["agent"],
                    "state": "review",
                    "url": url,
                    "github": github,
                    "head": None,
                    "area": fields["area"],
                    "files": fields["files"],
                    "added": fields["added"],
                    "removed": fields["removed"],
                    "review": None,
                    "decision": None,
                    "checks": None,
                    "mergeable": None,
                    "error": "",
                    "created_at": now,
                    "at": now,
                }
                each["prs"][str(number)] = pr
                if fields["issue"] is not None and str(fields["issue"]) in each["issues"]:
                    each["issues"][str(fields["issue"])]["pr"] = number
                    each["issues"][str(fields["issue"])]["at"] = now
                self.save()
                return copy.deepcopy(pr)
        raise KeyError(f"{repo} isn't on the Workflow tab")

    def add_github_pr(self, repo: str, pull: dict, number: int | None = None) -> dict:
        """A pull request opened on GitHub by hand (github_pulls()), for the review agent: its changed files and diff are
        read now. In Seraph it gets the next number of its own, on GitHub it keeps GitHub's. With number, the one known
        as that got new commits since: read again, and back to review. In a thread."""
        record = self.get(repo)
        if record is None:
            raise KeyError(f"{repo} isn't on the Workflow tab")
        files = []
        with self.your_repositories.client() as client:
            for page in range(1, FILE_PAGES + 1):
                response = client.get(f"/repos/{repo}/pulls/{pull['number']}/files", params={"per_page": 100, "page": page})
                if response.status_code >= 400:
                    raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
                items = response.json()
                for item in items:
                    files.append({"path": item["filename"], "added": item["additions"], "removed": item["deletions"]})
                if len(items) < 100:
                    break
            response = client.get(f"/repos/{repo}/pulls/{pull['number']}", headers={"Accept": "application/vnd.github.diff"})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            diff = response.text[:DIFF_LIMIT]
        pr_id = "wpr_" + secrets.token_hex(4)
        if number is not None and str(number) in record["prs"]:
            pr_id = record["prs"][str(number)]["id"]
        self.write_parts(pr_id, {"body": pull["body"], "diff": diff})
        area = ""
        match = re.match(r"[a-z]+\(([^)]+)\)", pull["title"])
        if match is not None:
            area = match.group(1)
        now = datetime.now(UTC).isoformat()
        with self.lock:
            for each in self.repos:
                if each["repo"].lower() != repo.lower():
                    continue
                if number is not None and str(number) in each["prs"]:
                    pr = each["prs"][str(number)]
                    fields = {"title": pull["title"], "state": "review", "head": pull["head"], "area": area, "files": files, "review": None, "decision": None, "error": "", "at": now}
                    fields["added"] = sum(item["added"] for item in files)
                    fields["removed"] = sum(item["removed"] for item in files)
                    pr.update(fields)
                    self.save()
                    return copy.deepcopy(pr)
                number = pull["number"]
                if each["prs_on"] == "seraph":
                    number = each["next_number"]
                    each["next_number"] += 1
                pr = {
                    "number": number,
                    "id": pr_id,
                    "title": pull["title"],
                    "by": "you",
                    "author": pull["author"],
                    "issue": None,
                    "job": None,
                    "agent": None,
                    "state": "review",
                    "url": pull["url"],
                    "github": pull["number"],
                    "head": pull["head"],
                    "area": area,
                    "files": files,
                    "added": sum(item["added"] for item in files),
                    "removed": sum(item["removed"] for item in files),
                    "review": None,
                    "decision": None,
                    "checks": None,
                    "mergeable": None,
                    "error": "",
                    "created_at": now,
                    "at": now,
                }
                each["prs"][str(number)] = pr
                self.save()
                return copy.deepcopy(pr)
        raise KeyError(f"{repo} isn't on the Workflow tab")

    def open_on_github(self, repo: str, pr_id: str, title: str, parts: dict, issue: int | None) -> dict:
        """Opens a worker's pull request on GitHub as you, the way the Inbox's Approve opens one (github_account.py
        send_pr: its commits rebuilt on its base, on a new branch in the repo). Returns GitHub's {"number", "url", ...}."""
        account = self.github_account.load()
        if account is None:
            raise ValueError("Sign in with GitHub first: the GitHub tab, Account.")
        draft = {
            "id": pr_id,
            "repo": repo,
            "base_sha": parts["base_sha"],
            "commits": parts["commits"],
            "base": parts["base"],
            "diff": parts["diff"],
            "branch": parts["branch"],
            "target": f"{repo}#{issue}" if issue is not None else None,
            "title": title,
            "body": parts["body"],
            "evidence": parts["evidence"],
        }
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        with self.github_account.send_lock:
            self.github_account.step = "starting"
            self.github_account.listings = {}
            self.github_account.blobs = {}
            try:
                with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                    return self.github_account.send_pr(client, account, draft)
            except httpx.HTTPStatusError as error:
                raise ValueError(f"GitHub refused while {self.github_account.step}: {error.response.text[:300]}") from None
            except httpx.HTTPError as error:
                raise ValueError(f"Could not reach GitHub while {self.github_account.step}: {error}") from None
            except SendError as error:
                raise ValueError(str(error)) from None

    def merge(self, repo: str, number: int) -> None:
        """Merge a pull request, as you. One on GitHub: GitHub's squash merge, titled like it. One kept here: its change
        as one commit on top of the newest default branch, pushed there (never forced). Conflict when its change doesn't
        go on anymore; ValueError for anything else GitHub refused. In a thread."""
        record = self.get(repo)
        if record is None or str(number) not in record["prs"]:
            raise KeyError(f"No pull request #{number} in {repo}")
        pr = record["prs"][str(number)]
        if pr["github"] is not None:
            status = self.github_pull(repo, pr["github"])
            if status["state"] != "open":
                raise ValueError(f"It is {status['state']} on GitHub already.")
            if status["mergeable"] is False:
                raise Conflict("It conflicts with the default branch on GitHub.")
            with self.your_repositories.client() as client:
                payload = {"merge_method": "squash", "commit_title": f"{pr['title']} (#{pr['github']})"}
                response = client.put(f"/repos/{repo}/pulls/{pr['github']}/merge", json=payload)
            if response.status_code >= 400:
                message = response.text[:200]
                try:
                    message = response.json().get("message", message)
                except ValueError:
                    pass
                raise ValueError(f"GitHub refused: {message}")
            return

        parts = self.parts(pr["id"])
        account = self.github_account.load()
        if account is None:
            raise ValueError("Sign in with GitHub first: the GitHub tab, Account.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        you = {"name": account["name"], "email": f"{account['id']}+{account['login']}@users.noreply.github.com"}
        with self.github_account.send_lock:
            self.github_account.step = "reading the default branch"
            self.github_account.listings = {}
            self.github_account.blobs = {}
            try:
                with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                    response = client.get(f"/repos/{repo}")
                    response.raise_for_status()
                    branch = response.json()["default_branch"]
                    response = client.get(f"/repos/{repo}/git/ref/heads/{branch}")
                    response.raise_for_status()
                    head = response.json()["object"]["sha"]
                    response = client.get(f"/repos/{repo}/git/commits/{head}")
                    response.raise_for_status()
                    base_tree = response.json()["tree"]["sha"]
                    self.github_account.step = "putting the change on it"
                    try:
                        tree = self.github_account.tree(client, repo, base_tree, parts["diff"])
                    except SendError as error:
                        if "doesn't apply" in str(error):
                            raise Conflict(f"It doesn't go onto the newest {branch} anymore: {error}") from None
                        raise ValueError(str(error)) from None
                    self.github_account.step = "making the commit"
                    message = f"{pr['title']}\n\nSeraph pull request #{number}\n"
                    payload = {"message": message, "tree": tree, "parents": [head], "author": you, "committer": you}
                    response = client.post(f"/repos/{repo}/git/commits", json=payload)
                    response.raise_for_status()
                    commit = response.json()["sha"]
                    self.github_account.step = f"pushing it to {branch}"
                    response = client.patch(f"/repos/{repo}/git/refs/heads/{branch}", json={"sha": commit, "force": False})
                    response.raise_for_status()
            except httpx.HTTPStatusError as error:
                raise ValueError(f"GitHub refused while {self.github_account.step}: {error.response.text[:300]}") from None
            except httpx.HTTPError as error:
                raise ValueError(f"Could not reach GitHub while {self.github_account.step}: {error}") from None

    def close_pr(self, repo: str, number: int, comment: str) -> None:
        """Close a pull request on GitHub (by its GitHub number), as you, with comment on it first when there is one."""
        with self.your_repositories.client() as client:
            if comment:
                response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": comment})
                if response.status_code >= 400:
                    raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            response = client.patch(f"/repos/{repo}/pulls/{number}", json={"state": "closed"})
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")

    def comment(self, repo: str, number: int, body: str) -> None:
        """A comment on an issue or pull request on GitHub (by its GitHub number), as you."""
        with self.your_repositories.client() as client:
            response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": body})
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")

    def github_issues(self, repo: str) -> list[dict]:
        """Every open issue on GitHub (no pull requests), the oldest first: {"number", "title", "url", "updated_at"}."""
        issues = []
        page = 1
        with self.your_repositories.client() as client:
            while True:
                params = {"state": "open", "sort": "created", "direction": "asc", "per_page": 100, "page": page}
                response = client.get(f"/repos/{repo}/issues", params=params)
                if response.status_code >= 400:
                    raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
                items = response.json()
                for item in items:
                    if "pull_request" in item:
                        continue
                    issues.append({"number": item["number"], "title": item["title"], "url": item["html_url"], "updated_at": item["updated_at"]})
                if len(items) < 100 or page >= 10:
                    break
                page += 1
        return issues

    def github_pulls(self, repo: str) -> list[dict]:
        """Every open pull request on GitHub: {"number", "title", "url", "author", "draft", "head", "body"}."""
        pulls = []
        page = 1
        with self.your_repositories.client() as client:
            while True:
                params = {"state": "open", "per_page": 100, "page": page}
                response = client.get(f"/repos/{repo}/pulls", params=params)
                if response.status_code >= 400:
                    raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
                items = response.json()
                for item in items:
                    pulls.append({
                        "number": item["number"],
                        "title": item["title"],
                        "url": item["html_url"],
                        "author": item["user"]["login"] if item["user"] is not None else "",
                        "draft": item.get("draft", False),
                        "head": item["head"]["sha"],
                        "body": item["body"] or "",
                    })
                if len(items) < 100 or page >= 5:
                    break
                page += 1
        return pulls

    def github_pull(self, repo: str, number: int) -> dict:
        """How a pull request on GitHub stands: {"state": "open" | "merged" | "closed", "checks": "passed" | "failed" |
        "running" | "none", "mergeable": GitHub's (None while it works it out), "head": its newest commit}."""
        with self.your_repositories.client() as client:
            response = client.get(f"/repos/{repo}/pulls/{number}")
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            data = response.json()
            state = "open"
            if data["merged_at"] is not None:
                state = "merged"
            elif data["state"] == "closed":
                state = "closed"
            result = {"state": state, "checks": "none", "mergeable": data["mergeable"], "head": data["head"]["sha"]}
            if state != "open":
                return result
            response = client.get(f"/repos/{repo}/commits/{data['head']['sha']}/check-runs", params={"per_page": 100})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            runs = response.json()["check_runs"]
            if runs:
                result["checks"] = "passed"
            for run in runs:
                if run["status"] != "completed" and result["checks"] != "failed":
                    result["checks"] = "running"
                if run["status"] == "completed" and run["conclusion"] in ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]:
                    result["checks"] = "failed"
        return result
