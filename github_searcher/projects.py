"""Projects: your own repositories that agents develop all the time, from an issue to a pull request you merge, and
their releases. The Workspace tab's repo page shows them: Development (frontend/src/Development.tsx) and Releases
(Releases.tsx). backend/projects_api.py runs them.

A project has agents of its own (agents.py, start_project):
- its chat agent: the repository's agent (its record's "repo"), where you talk about the project. In Drafts mode it
  writes what you ask for as issue drafts you create with one click; in Auto mode it creates the issues itself, only
  ones that fit your goals. For the app's own repo (SELF_REPO) it also turns the app's errors (crashes.py) into issues.
- its workers (record "project", role "worker"), "agents" of them: each takes the next open issue, checks it is a
  real, new issue worth doing and reproduces it, then fixes it (a fix_issue job), or denies it (deny_issue: closed as
  not planned, with why). Their PR drafts go to review first.
- its reviewer (role "reviewer"): reviews each PR draft before it reaches your Inbox.
They work in the project's VM ("vm"), made for it with one desktop; each adds one of its own (up to the VM's max
desktops) when none is free, so they work at the same time.

Kept in DATA_DIR/projects.json, a list:

    {"repo": "owner/name", "on": bool, "mode": "drafts" | "auto", "agents": workers (1 to MAX_AGENTS), "goals": text,
     "vm": the project's VM | None, "chat": agent id | None, "workers": [agent ids], "reviewer": agent id | None,
     "issues": {"<number>": Issue}, "prs": {"<number>": PR}, "crashes_sent_at": when errors last went to the chat
     agent | None, "error": why the last round failed | "", "created_at"}

    Issue: {"number", "title", "state": "working" | "denied" | "stopped" | "closed" | "done", "job", "agent",
            "kind": why it was denied (DENY_KINDS) | None, "why": the agent's words | "", "at"}
    PR:    {"number", "title", "url", "draft", "job", "agent", "issue": its issue's number | None,
            "state": "open" | "merged" | "closed", "checks": "passed" | "failed" | "running" | "none",
            "mergeable": bool | None, "redo": its agent was asked to make it again on the new main,
            "replaces": the PR it replaces ("owner/name#n") until that one is closed | None, "at"}

working: a worker has a job on it. denied: a worker closed it as not planned. stopped: its job was cancelled (you
stopped it, or its agent was archived): not taken again until you pick Try again. closed: closed on GitHub while a
worker had it. done: its job is done or its PR merged. A denied or closed issue that is open again on GitHub (reopened
after "at") is taken again; Try again takes a stopped or done one again.

The GitHub side is always as you (your_repositories.client(): your sign-in, which reads private repos too):
open_issues, close_issue, comment, pull, update_branch, merge, close_pr; for Releases: release_info (the releases, the
PRs merged into the default branch since the latest, the next version and its notes, and the issues planned for it:
the milestone NEXT_MILESTONE), plan (an issue into or out of that milestone) and release (a GitHub release of the
next version; the milestone is closed under the version's name). A ValueError says what GitHub answered.

The next version: the latest release's vX.Y.Z with Y one up when any PR since is a feat, else Z one up (a project's PR
titles are Conventional Commits: draft_pr makes sure). The first release is v0.1.0.

version goes up on every change, for the live feed (topic "projects").
"""

import copy
import json
import os
import re
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
MODES = ["drafts", "auto"]
MAX_AGENTS = 3
# Why a worker may deny an issue, and how the comment on GitHub says it.
DENY_KINDS = {
    "not_valid": "it isn't a valid issue",
    "duplicate": "it repeats another issue, or work that is already done",
    "conflicting": "it conflicts with another issue or with where the project is going",
    "out_of_scope": "it is outside the project's goals",
    "cannot_reproduce": "it can't be reproduced on the newest code",
}
NEXT_MILESTONE = "Next release"
# A project's PR titles: Conventional Commits, type(scope): summary, lower case, no period at the end.
TITLE = re.compile(r"(feat|fix|refactor|docs|style|test|chore|perf)\([a-z0-9_.-]+\): [a-z0-9].*[^.]")
TITLE_CHARS = 72
# How the release notes group the PRs, by their title's type.
SECTIONS = [("feat", "Features"), ("fix", "Fixes"), ("other", "Other changes")]
# The app's own repo: its errors become its issues. The live copy has it in .env (deploy/install.sh); the dev copy is
# a clone, so its origin says it.
SELF_REPO = os.environ.get("SERAPH_REPO", "")
if SELF_REPO == "":
    try:
        result = subprocess.run(["git", "-C", str(PROJECT_ROOT), "remote", "get-url", "origin"], capture_output=True, text=True, timeout=10)
        match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(\.git)?$", result.stdout.strip())
        if match is not None:
            SELF_REPO = match.group(1)
    except (OSError, subprocess.TimeoutExpired):
        pass


class Projects:
    def __init__(self, your_repositories):
        # Your sign-in: every GitHub call here acts as you.
        self.your_repositories = your_repositories
        self.path = DATA_DIR / "projects.json"
        self.lock = threading.Lock()
        self.version = 0
        self.projects: list[dict] = []
        if self.path.exists():
            self.projects = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.projects, indent=2))
        temporary.replace(self.path)

    def list(self) -> list[dict]:
        with self.lock:
            return copy.deepcopy(self.projects)

    def get(self, repo: str | None) -> dict | None:
        """The project of repo (owner/name, any case), or None when it isn't one."""
        if repo is None:
            return None
        with self.lock:
            for project in self.projects:
                if project["repo"].lower() == repo.lower():
                    return copy.deepcopy(project)
        return None

    def create(self, repo: str, vm: str) -> dict:
        with self.lock:
            for project in self.projects:
                if project["repo"].lower() == repo.lower():
                    raise ValueError(f"{repo} is a project already")
            project = {
                "repo": repo,
                "on": True,
                "mode": "drafts",
                "agents": 2,
                "goals": "",
                "vm": vm,
                "chat": None,
                "workers": [],
                "reviewer": None,
                "issues": {},
                "prs": {},
                "crashes_sent_at": None,
                "error": "",
                "created_at": datetime.now(UTC).isoformat(),
            }
            self.projects.append(project)
            self.save()
            return copy.deepcopy(project)

    def update(self, repo: str, **fields) -> dict:
        """Change some of a project's fields. Returns the project as it is now."""
        allowed = ["on", "mode", "agents", "goals", "vm", "chat", "workers", "reviewer", "crashes_sent_at", "error"]
        for name in fields:
            if name not in allowed:
                raise ValueError(f"A project's {name} can't be changed")
        if "mode" in fields and fields["mode"] not in MODES:
            raise ValueError(f"mode must be one of: {', '.join(MODES)}")
        if "agents" in fields and (fields["agents"] < 1 or fields["agents"] > MAX_AGENTS):
            raise ValueError(f"A project has 1 to {MAX_AGENTS} agents")
        with self.lock:
            for project in self.projects:
                if project["repo"].lower() != repo.lower():
                    continue
                # Nothing changed: no new version, so the live feed doesn't send it again every round.
                if all(project[name] == value for name, value in fields.items()):
                    return copy.deepcopy(project)
                project.update(copy.deepcopy(fields))
                self.save()
                return copy.deepcopy(project)
        raise KeyError(f"{repo} isn't a project")

    def set_issue(self, repo: str, number: int, fields: dict) -> None:
        """Change what the project knows of one issue (a new one gets every field). "at" becomes now."""
        with self.lock:
            for project in self.projects:
                if project["repo"].lower() != repo.lower():
                    continue
                issue = project["issues"].get(str(number))
                if issue is None:
                    issue = {"number": number, "title": "", "state": "working", "job": None, "agent": None, "kind": None, "why": ""}
                    project["issues"][str(number)] = issue
                issue.update(copy.deepcopy(fields))
                issue["at"] = datetime.now(UTC).isoformat()
                self.save()

    def drop_issue(self, repo: str, number: int) -> None:
        """Forget one issue, so a worker takes it again while it is open (Try again)."""
        with self.lock:
            for project in self.projects:
                if project["repo"].lower() == repo.lower() and str(number) in project["issues"]:
                    del project["issues"][str(number)]
                    self.save()

    def set_pr(self, repo: str, number: int, fields: dict) -> None:
        """Change what the project knows of one of its PRs (a new one gets every field). "at" becomes now."""
        with self.lock:
            for project in self.projects:
                if project["repo"].lower() != repo.lower():
                    continue
                pr = project["prs"].get(str(number))
                if pr is None:
                    pr = {"number": number, "title": "", "url": "", "draft": None, "job": None, "agent": None, "issue": None, "state": "open",
                          "checks": "none", "mergeable": None, "redo": False, "replaces": None}
                    project["prs"][str(number)] = pr
                # Nothing changed: no new version.
                if all(pr.get(name) == value for name, value in fields.items()):
                    return
                pr.update(copy.deepcopy(fields))
                pr["at"] = datetime.now(UTC).isoformat()
                self.save()

    def open_issues(self, repo: str) -> list[dict]:
        """Every open issue (no PRs), the oldest first, with its milestone's title."""
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
                    milestone = None
                    if item["milestone"] is not None:
                        milestone = item["milestone"]["title"]
                    issues.append({
                        "number": item["number"],
                        "title": item["title"],
                        "milestone": milestone,
                        "created_at": item["created_at"],
                        "updated_at": item["updated_at"],
                    })
                # 1,000 open issues is more than any project here has.
                if len(items) < 100 or page >= 10:
                    break
                page += 1
        return issues

    def comment(self, repo: str, number: int, body: str) -> str:
        """A comment on an issue or PR, as you. Returns its address."""
        with self.your_repositories.client() as client:
            response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": body})
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
        return response.json()["html_url"]

    def close_issue(self, repo: str, number: int, comment: str) -> None:
        """Closes an issue as not planned, as you, with comment on it first."""
        self.comment(repo, number, comment)
        with self.your_repositories.client() as client:
            response = client.patch(f"/repos/{repo}/issues/{number}", json={"state": "closed", "state_reason": "not_planned"})
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")

    def pull(self, repo: str, number: int) -> dict:
        """How a PR stands: {"state": "open" | "merged" | "closed", "checks", "mergeable": GitHub's (None while it works
        it out), "behind": main has commits the PR's branch doesn't}."""
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
            result = {"state": state, "checks": "none", "mergeable": data["mergeable"], "behind": False}
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

            response = client.get(f"/repos/{repo}/compare/{data['base']['ref']}...{data['head']['sha']}")
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            result["behind"] = response.json()["behind_by"] > 0
        return result

    def update_branch(self, repo: str, number: int) -> None:
        """Merges the PR's base into its branch (GitHub's Update branch), as you."""
        with self.your_repositories.client() as client:
            response = client.put(f"/repos/{repo}/pulls/{number}/update-branch")
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")

    def merge(self, repo: str, number: int, title: str) -> None:
        """Squash-merges a PR, as you: one commit on main, titled like the PR."""
        with self.your_repositories.client() as client:
            response = client.put(f"/repos/{repo}/pulls/{number}/merge", json={"merge_method": "squash", "commit_title": f"{title} (#{number})"})
        if response.status_code >= 400:
            message = response.text[:200]
            try:
                message = response.json().get("message", message)
            except ValueError:
                pass
            raise ValueError(f"GitHub refused: {message}")

    def close_pr(self, repo: str, number: int, comment: str) -> None:
        """Closes a PR, as you, with comment on it first."""
        self.comment(repo, number, comment)
        with self.your_repositories.client() as client:
            response = client.patch(f"/repos/{repo}/pulls/{number}", json={"state": "closed"})
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")

    def release_info(self, repo: str) -> dict:
        """For Releases: {"releases": [{"tag", "name", "url", "at", "notes"}, ...] (the newest first), "default_branch",
        "prs": [{"number", "title", "url", "at", "kind"}, ...] (merged into the default branch since the latest release,
        the newest first), "next": the next version | None (nothing merged since), "notes": its release notes,
        "milestone": NEXT_MILESTONE's number | None, "planned": [{"number", "title", "url", "state"}, ...]}."""
        with self.your_repositories.client() as client:
            response = client.get(f"/repos/{repo}")
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            default_branch = response.json()["default_branch"]

            response = client.get(f"/repos/{repo}/releases", params={"per_page": 30})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            releases = []
            for item in response.json():
                if item["draft"]:
                    continue
                releases.append({"tag": item["tag_name"], "name": item["name"] or item["tag_name"], "url": item["html_url"], "at": item["published_at"], "notes": item["body"] or ""})

            since = ""
            if releases:
                since = releases[0]["at"]
            params = {"state": "closed", "base": default_branch, "sort": "updated", "direction": "desc", "per_page": 100}
            response = client.get(f"/repos/{repo}/pulls", params=params)
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            prs = []
            for item in response.json():
                if item["merged_at"] is None or item["merged_at"] <= since:
                    continue
                kind = "other"
                match = TITLE.fullmatch(item["title"])
                if match is not None and match.group(1) in ["feat", "fix"]:
                    kind = match.group(1)
                prs.append({"number": item["number"], "title": item["title"], "url": item["html_url"], "at": item["merged_at"], "kind": kind})
            prs.sort(key=lambda pr: pr["at"], reverse=True)

            response = client.get(f"/repos/{repo}/milestones", params={"state": "open", "per_page": 100})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            milestone = None
            for item in response.json():
                if item["title"] == NEXT_MILESTONE:
                    milestone = item["number"]
            planned = []
            if milestone is not None:
                response = client.get(f"/repos/{repo}/issues", params={"milestone": milestone, "state": "all", "per_page": 100})
                if response.status_code >= 400:
                    raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
                for item in response.json():
                    if "pull_request" not in item:
                        planned.append({"number": item["number"], "title": item["title"], "url": item["html_url"], "state": item["state"]})

        next_version = None
        if prs and not releases:
            next_version = "v0.1.0"
        if prs and releases:
            major, minor, patch = 0, 0, 0
            match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", releases[0]["tag"])
            if match is not None:
                major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
            if any(pr["kind"] == "feat" for pr in prs):
                next_version = f"v{major}.{minor + 1}.0"
            else:
                next_version = f"v{major}.{minor}.{patch + 1}"

        notes = []
        for kind, heading in SECTIONS:
            lines = [f"- {pr['title']} (#{pr['number']})" for pr in prs if pr["kind"] == kind]
            if lines:
                notes.append(f"## {heading}\n\n" + "\n".join(lines))
        return {
            "releases": releases,
            "default_branch": default_branch,
            "prs": prs,
            "next": next_version,
            "notes": "\n\n".join(notes),
            "milestone": milestone,
            "planned": planned,
        }

    def plan(self, repo: str, number: int, add: bool) -> None:
        """Puts an issue into the next release (NEXT_MILESTONE, made the first time), or takes it out."""
        with self.your_repositories.client() as client:
            response = client.get(f"/repos/{repo}/milestones", params={"state": "open", "per_page": 100})
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            milestone = None
            for item in response.json():
                if item["title"] == NEXT_MILESTONE:
                    milestone = item["number"]
            if milestone is None and add:
                response = client.post(f"/repos/{repo}/milestones", json={"title": NEXT_MILESTONE})
                if response.status_code >= 400:
                    raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
                milestone = response.json()["number"]
            value = None
            if add:
                value = milestone
            response = client.patch(f"/repos/{repo}/issues/{number}", json={"milestone": value})
        if response.status_code >= 400:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")

    def release(self, repo: str) -> dict:
        """Releases the next version: a GitHub release on the default branch with its notes, as you. The next-release
        milestone is closed under the version's name. Returns {"tag", "url"}."""
        info = self.release_info(repo)
        if info["next"] is None:
            raise ValueError("Nothing was merged since the last release.")
        with self.your_repositories.client() as client:
            payload = {"tag_name": info["next"], "target_commitish": info["default_branch"], "name": info["next"], "body": info["notes"]}
            response = client.post(f"/repos/{repo}/releases", json=payload)
            if response.status_code >= 400:
                raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
            url = response.json()["html_url"]
            if info["milestone"] is not None:
                client.patch(f"/repos/{repo}/milestones/{info['milestone']}", json={"title": info["next"], "state": "closed"})
        return {"tag": info["next"], "url": url}
