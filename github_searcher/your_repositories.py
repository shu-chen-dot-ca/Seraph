"""Your repositories: every GitHub repo you can push to (your own, ones you collaborate on, your organizations'),
public and private, and the repos you starred, for the GitHub tab's "Your repositories" and "Starred"
(frontend/src/GitHubNav.tsx, Repository.tsx), and the changes you make in them, as you.

Everything here goes through your sign-in (github_account.py), never the search tokens: those can't see private repos.
Nothing here runs for an agent or Sherpa; only the GitHub tab's pages and buttons use it.

refresh() reads both lists in one GraphQL request: the 100 most recently pushed repos you can push to (not archived;
viewerPermission ADMIN, MAINTAIN or WRITE) in "repos", and the 100 you starred most recently in "starred" (the ones
you can push to are under "repos" only). Per repo: whether the newest commit on its default branch passed its checks,
how many issues and PRs are open, its stars and whether you starred it. It is kept in memory only (read again at
start) and goes to the browser as the live topic "your_repos". backend/your_repositories_api.py reads it every
minute, at once when you sign in or out, and soon after a change you made here (wanted); Star and Unstar read it
again at once, so the left list follows.

    {"repos": [{"name": "owner/name", "private", "fork", "description", "url", "default_branch", "pushed_at",
                "checks": "passed" | "failed" | "running" | "none", "open_issues", "open_prs", "stars",
                "starred": you starred it, "can_push"}],
     "starred": [the same],
     "login": your login | None, "checked_at", "error": why the last read failed | None}

What a repo's page shows is read when it opens (never kept): overview() (the README and the newest commits on the
default branch, each with its checks), issues(state) and pulls(state) (the newest 50 of the Open or Closed tab, and
how many are in each), runs() (the newest GitHub Actions runs) and labels() (for the thread pop-up's Labels).

act() is one change you make, as you: Star and Unstar (one click, like on GitHub, on any repo), a new issue (in a
repo of either list), and, only in a repo you can push to (is_yours), after the browser asked "are you sure?": edit a
title and description, close (an issue as completed or as not planned) or reopen, add or remove a label, assign or
unassign yourself, merge a PR (merge commit, squash or rebase), review a PR (approve, request changes, or comment),
re-run a GitHub Actions run's failed jobs. A refusal raises ValueError with what GitHub said.
"""

import copy
import threading
from datetime import UTC, datetime
from urllib.parse import quote

import httpx

from github_searcher.pr_tracking import ROLLUP

API = "https://api.github.com"
# viewerPermission that may push.
PUSH = ["ADMIN", "MAINTAIN", "WRITE"]
# How many issues, PRs and runs a tab shows.
LIST_SIZE = 50
RUNS_SIZE = 30
COMMITS_SIZE = 10
MERGE_METHODS = ["merge", "squash", "rebase"]
REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"]
CLOSE_REASONS = ["completed", "not_planned"]
ACTIONS = ["star", "unstar", "new_issue", "edit", "close", "reopen", "add_label", "remove_label", "assign_me", "unassign_me", "merge", "review", "rerun_failed"]

REPOS_QUERY = """
query {
  viewer {
    login
    repositories(first: 100, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                 ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { ...RepoFields }
    }
    starredRepositories(first: 100, orderBy: {field: STARRED_AT, direction: DESC}) {
      nodes { ...RepoFields }
    }
  }
}
fragment RepoFields on Repository {
  nameWithOwner isPrivate isFork isArchived description url pushedAt viewerPermission viewerHasStarred stargazerCount
  defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } }
  issues(states: OPEN) { totalCount }
  pullRequests(states: OPEN) { totalCount }
}
"""

COMMITS_QUERY = """
query($owner: String!, $name: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    description url isPrivate homepageUrl stargazerCount forkCount
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: $count) {
            nodes { oid messageHeadline committedDate url author { name user { login } } statusCheckRollup { state } }
          }
        }
      }
    }
  }
}
"""

ISSUES_QUERY = """
query($owner: String!, $name: String!, $states: [IssueState!], $count: Int!) {
  repository(owner: $owner, name: $name) {
    open: issues(states: OPEN) { totalCount }
    closed: issues(states: CLOSED) { totalCount }
    issues(first: $count, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state stateReason createdAt updatedAt author { login }
        labels(first: 10) { nodes { name color } }
        assignees(first: 5) { nodes { login } }
        comments { totalCount }
      }
    }
  }
}
"""

PULLS_QUERY = """
query($owner: String!, $name: String!, $states: [PullRequestState!], $count: Int!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN) { totalCount }
    closed: pullRequests(states: [CLOSED, MERGED]) { totalCount }
    pullRequests(first: $count, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state isDraft createdAt updatedAt reviewDecision headRefName author { login }
        labels(first: 10) { nodes { name color } }
        comments { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
"""


class YourRepositories:
    def __init__(self, github_account):
        self.github_account = github_account
        self.lock = threading.Lock()
        self.version = 0
        self.data = {"repos": [], "starred": [], "login": None, "checked_at": None, "error": None}
        # A change you made here: backend/your_repositories_api.py reads the list again soon.
        self.wanted = False

    def summary(self) -> dict:
        """For the live feed: the list as last read."""
        with self.lock:
            return copy.deepcopy(self.data)

    def is_yours(self, repo: str) -> bool:
        """Whether repo (owner/name) is one you can push to."""
        with self.lock:
            names = [each["name"].lower() for each in self.data["repos"]]
        return repo.lower() in names

    def is_listed(self, repo: str) -> bool:
        """Whether repo (owner/name) is one you can push to or one you starred: its page may be shown."""
        with self.lock:
            names = [each["name"].lower() for each in self.data["repos"] + self.data["starred"]]
        return repo.lower() in names

    def token(self) -> str | None:
        """Your sign-in's token, for reading one of your repositories (backend/github_api.py's thread pop-up)."""
        account = self.github_account.load()
        if account is None:
            return None
        return account["token"]

    def client(self) -> httpx.Client:
        """A client that acts as you. ValueError when you aren't signed in."""
        token = self.token()
        if token is None:
            raise ValueError("Sign in with GitHub first: the GitHub tab, Account.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28"}
        return httpx.Client(base_url=API, headers=headers, timeout=60)

    def graphql(self, query: str, variables: dict) -> dict:
        """One GraphQL query as you. ValueError with GitHub's message when it fails."""
        with self.client() as client:
            response = client.post("/graphql", json={"query": query, "variables": variables})
        if response.status_code == 401:
            raise ValueError("GitHub doesn't accept your sign-in anymore. Sign in with GitHub again: the GitHub tab, Account.")
        if response.status_code != 200:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
        answer = response.json()
        if answer.get("errors"):
            raise ValueError(answer["errors"][0]["message"])
        return answer["data"]

    def refresh(self) -> None:
        """Reads the list again. Not signed in: an empty list. A failure keeps the last list, with why."""
        if self.token() is None:
            with self.lock:
                self.data = {"repos": [], "starred": [], "login": None, "checked_at": None, "error": None}
                self.version += 1
            return
        try:
            viewer = self.graphql(REPOS_QUERY, {})["viewer"]
        except (httpx.HTTPError, ValueError) as error:
            with self.lock:
                self.data["error"] = str(error)
                self.data["checked_at"] = datetime.now(UTC).isoformat()
                self.version += 1
            return
        repos = []
        starred = []
        # Yours first: a repo you can push to and starred too is under repos only.
        names = []
        for node in viewer["repositories"]["nodes"] + viewer["starredRepositories"]["nodes"]:
            can_push = node["viewerPermission"] in PUSH and not node["isArchived"]
            if node["nameWithOwner"] in names or (not can_push and not node["viewerHasStarred"]):
                continue
            names.append(node["nameWithOwner"])
            default_branch = ""
            checks = "none"
            branch = node["defaultBranchRef"]
            if branch is not None:
                default_branch = branch["name"]
            if branch is not None and branch["target"] is not None and branch["target"].get("statusCheckRollup") is not None:
                checks = ROLLUP.get(branch["target"]["statusCheckRollup"]["state"], "running")
            item = {
                "name": node["nameWithOwner"],
                "private": node["isPrivate"],
                "fork": node["isFork"],
                "description": node["description"] or "",
                "url": node["url"],
                "default_branch": default_branch,
                "pushed_at": node["pushedAt"],
                "checks": checks,
                "open_issues": node["issues"]["totalCount"],
                "open_prs": node["pullRequests"]["totalCount"],
                "stars": node["stargazerCount"],
                "starred": node["viewerHasStarred"],
                "can_push": can_push,
            }
            if can_push:
                repos.append(item)
            else:
                starred.append(item)
        with self.lock:
            self.data = {"repos": repos, "starred": starred, "login": viewer["login"], "checked_at": datetime.now(UTC).isoformat(), "error": None}
            self.version += 1

    def overview(self, repo: str) -> dict:
        """A repo's Overview tab: its description, README (markdown, "" when it has none) and newest commits."""
        owner, name = repo.split("/")
        data = self.graphql(COMMITS_QUERY, {"owner": owner, "name": name, "count": COMMITS_SIZE})["repository"]
        readme = ""
        with self.client() as client:
            response = client.get(f"/repos/{repo}/readme", headers={"Accept": "application/vnd.github.raw+json"})
        if response.status_code == 200:
            readme = response.text
        commits = []
        branch = data["defaultBranchRef"]
        if branch is not None and branch["target"] is not None:
            for commit in branch["target"]["history"]["nodes"]:
                login = None
                if commit["author"] is not None and commit["author"]["user"] is not None:
                    login = commit["author"]["user"]["login"]
                checks = "none"
                if commit["statusCheckRollup"] is not None:
                    checks = ROLLUP.get(commit["statusCheckRollup"]["state"], "running")
                commits.append({
                    "sha": commit["oid"],
                    "message": commit["messageHeadline"],
                    "at": commit["committedDate"],
                    "url": commit["url"],
                    "login": login,
                    "name": commit["author"]["name"] if commit["author"] is not None else "",
                    "checks": checks,
                })
        return {
            "description": data["description"] or "",
            "url": data["url"],
            "private": data["isPrivate"],
            "homepage": data["homepageUrl"] or "",
            "stars": data["stargazerCount"],
            "forks": data["forkCount"],
            "default_branch": branch["name"] if branch is not None else "",
            "readme": readme,
            "commits": commits,
        }

    def issues(self, repo: str, state: str) -> dict:
        """The Issues tab: the newest LIST_SIZE open or closed issues (the newest change first), and how many of each."""
        owner, name = repo.split("/")
        states = ["OPEN"] if state == "open" else ["CLOSED"]
        data = self.graphql(ISSUES_QUERY, {"owner": owner, "name": name, "states": states, "count": LIST_SIZE})["repository"]
        items = []
        for node in data["issues"]["nodes"]:
            items.append({
                "id": f"{repo}#{node['number']}",
                "number": node["number"],
                "title": node["title"],
                "url": node["url"],
                "state": node["state"].lower(),
                "reason": node["stateReason"].lower() if node["stateReason"] is not None else None,
                "author": node["author"]["login"] if node["author"] is not None else "ghost",
                "created_at": node["createdAt"],
                "updated_at": node["updatedAt"],
                "labels": [{"name": label["name"], "color": label["color"]} for label in node["labels"]["nodes"]],
                "assignees": [person["login"] for person in node["assignees"]["nodes"]],
                "comments": node["comments"]["totalCount"],
            })
        return {"items": items, "open": data["open"]["totalCount"], "closed": data["closed"]["totalCount"]}

    def pulls(self, repo: str, state: str) -> dict:
        """The Pull requests tab: the newest LIST_SIZE open or closed (merged too) PRs, and how many of each."""
        owner, name = repo.split("/")
        states = ["OPEN"] if state == "open" else ["CLOSED", "MERGED"]
        data = self.graphql(PULLS_QUERY, {"owner": owner, "name": name, "states": states, "count": LIST_SIZE})["repository"]
        items = []
        for node in data["pullRequests"]["nodes"]:
            checks = "none"
            last = node["commits"]["nodes"]
            if last and last[0]["commit"]["statusCheckRollup"] is not None:
                checks = ROLLUP.get(last[0]["commit"]["statusCheckRollup"]["state"], "running")
            items.append({
                "id": f"{repo}#{node['number']}",
                "number": node["number"],
                "title": node["title"],
                "url": node["url"],
                "state": node["state"].lower(),
                "draft": node["isDraft"],
                "author": node["author"]["login"] if node["author"] is not None else "ghost",
                "branch": node["headRefName"],
                "created_at": node["createdAt"],
                "updated_at": node["updatedAt"],
                "review": (node["reviewDecision"] or "none").lower(),
                "checks": checks,
                "labels": [{"name": label["name"], "color": label["color"]} for label in node["labels"]["nodes"]],
                "comments": node["comments"]["totalCount"],
            })
        return {"items": items, "open": data["open"]["totalCount"], "closed": data["closed"]["totalCount"]}

    def runs(self, repo: str) -> dict:
        """The Actions tab: the newest RUNS_SIZE GitHub Actions runs."""
        with self.client() as client:
            response = client.get(f"/repos/{repo}/actions/runs", params={"per_page": RUNS_SIZE})
        if response.status_code != 200:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
        items = []
        for run in response.json()["workflow_runs"]:
            state = "running"
            if run["status"] == "completed":
                state = run["conclusion"] or "neutral"
            if run["status"] in ["waiting", "action_required"] or run["conclusion"] == "action_required":
                state = "waiting"
            items.append({
                "id": run["id"],
                "workflow": run["name"] or "",
                "title": run["display_title"] or "",
                "number": run["run_number"],
                "event": run["event"],
                "branch": run["head_branch"] or "",
                "state": state,
                "actor": run["actor"]["login"] if run["actor"] is not None else "",
                "at": run["created_at"],
                "url": run["html_url"],
            })
        return {"items": items}

    def labels(self, repo: str) -> list[dict]:
        """Every label of the repo, for the thread pop-up's Labels."""
        with self.client() as client:
            response = client.get(f"/repos/{repo}/labels", params={"per_page": 100})
        if response.status_code != 200:
            return []
        return [{"name": label["name"], "color": label["color"]} for label in response.json()]

    def act(self, repo: str, action: str, number: int | None, kind: str, fields: dict) -> dict:
        """One change you make, as you. kind is "issue" or "pr" (what number is). Returns {"done": what happened, in
        words, "url": the new issue's address (new_issue) | None}. ValueError says why not."""
        if action not in ACTIONS:
            raise ValueError(f"Unknown action {action}.")
        if action == "new_issue" and not self.is_listed(repo):
            raise ValueError(f"{repo} isn't one of your repositories or stars.")
        if action not in ["star", "unstar", "new_issue"] and not self.is_yours(repo):
            raise ValueError(f"{repo} isn't one of your repositories.")
        if action not in ["star", "unstar", "new_issue", "rerun_failed"] and number is None:
            raise ValueError("Which issue or PR?")
        account = self.github_account.load()
        if account is None:
            raise ValueError("Sign in with GitHub first: the GitHub tab, Account.")
        login = account["login"]
        what = f"{repo} #{number}"
        # Issues and PRs share GitHub's issue address for what both have (labels, assignees); state, title and
        # description of a PR go through its own.
        place = f"/repos/{repo}/issues/{number}"
        if kind == "pr":
            place = f"/repos/{repo}/pulls/{number}"
        url = None

        with self.client() as client:
            if action == "star":
                response = client.put(f"/user/starred/{repo}")
                done = f"Starred {repo}"
            elif action == "unstar":
                response = client.delete(f"/user/starred/{repo}")
                done = f"Unstarred {repo}"
            elif action == "new_issue":
                title = fields.get("title", "").strip()
                if title == "":
                    raise ValueError("Give the issue a title.")
                response = client.post(f"/repos/{repo}/issues", json={"title": title, "body": fields.get("body", "")})
                done = "Issue opened"
                if response.status_code == 201:
                    url = response.json()["html_url"]
                    done = f"Opened {repo} #{response.json()['number']}"
            elif action == "edit":
                title = fields.get("title", "").strip()
                if title == "":
                    raise ValueError("The title can't be empty.")
                response = client.patch(place, json={"title": title, "body": fields.get("body", "")})
                done = f"Saved {what}"
            elif action == "close":
                change = {"state": "closed"}
                done = f"Closed {what}"
                if kind == "issue":
                    reason = fields.get("reason", "completed")
                    if reason not in CLOSE_REASONS:
                        raise ValueError(f"Unknown reason {reason}.")
                    change["state_reason"] = reason
                    if reason == "not_planned":
                        done = f"Closed {what} as not planned"
                response = client.patch(place, json=change)
            elif action == "reopen":
                response = client.patch(place, json={"state": "open"})
                done = f"Reopened {what}"
            elif action == "add_label":
                label = fields.get("label", "")
                response = client.post(f"/repos/{repo}/issues/{number}/labels", json={"labels": [label]})
                done = f"Added the label {label}"
            elif action == "remove_label":
                label = fields.get("label", "")
                response = client.delete(f"/repos/{repo}/issues/{number}/labels/{quote(label, safe='')}")
                done = f"Removed the label {label}"
            elif action == "assign_me":
                response = client.post(f"/repos/{repo}/issues/{number}/assignees", json={"assignees": [login]})
                done = f"Assigned you to {what}"
            elif action == "unassign_me":
                response = client.request("DELETE", f"/repos/{repo}/issues/{number}/assignees", json={"assignees": [login]})
                done = f"Unassigned you from {what}"
            elif action == "merge":
                method = fields.get("method", "merge")
                if method not in MERGE_METHODS:
                    raise ValueError(f"Unknown merge method {method}.")
                response = client.put(f"/repos/{repo}/pulls/{number}/merge", json={"merge_method": method})
                done = f"Merged {what}"
            elif action == "review":
                event = fields.get("event", "")
                body = fields.get("body", "")
                if event not in REVIEW_EVENTS:
                    raise ValueError(f"Unknown review {event}.")
                if event != "APPROVE" and body.strip() == "":
                    raise ValueError("Write what you think first.")
                response = client.post(f"/repos/{repo}/pulls/{number}/reviews", json={"event": event, "body": body})
                done = {"APPROVE": f"Approved {what}", "REQUEST_CHANGES": f"Asked for changes on {what}", "COMMENT": f"Reviewed {what}"}[event]
            else:
                run_id = int(fields.get("run_id", 0))
                response = client.post(f"/repos/{repo}/actions/runs/{run_id}/rerun-failed-jobs")
                done = "Its failed jobs run again"

        if response.status_code >= 400:
            message = response.text[:200]
            try:
                message = response.json().get("message", message)
            except ValueError:
                pass
            raise ValueError(f"GitHub refused: {message}")
        self.wanted = True
        # Star and Unstar show in the left list at once.
        if action == "star" or action == "unstar":
            self.refresh()
        return {"done": done, "url": url}
