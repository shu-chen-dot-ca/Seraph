"""The Workspace tab's Pull requests (frontend/src/PullRequests.tsx): your pull requests anywhere on GitHub, open and
closed, like github.com/pulls. Read with your sign-in (your_repositories.py's graphql, github_account.py), so PRs in
private repos are there too; never the search tokens. Nothing is kept here: each read asks GitHub.

read(your_repositories, view) searches GitHub for one of GitHub's own views (VIEWS): created (you opened it), assigned
(it is assigned to you), mentioned (it mentions you) and review-requested (it asks you for a review). PRs in archived
repos are left out, like on GitHub. Open and closed (merged too) are searched one after the other, the most recently
updated first, at most MAX_PAGES pages of 100 each, so every open one is there even when there are many closed ones.
The page filters them (visibility, repository) and sorts them itself.

    {"items": [{"id": "owner/name#n", "repo", "private", "number", "title", "url", "state": "open" | "closed" | "merged",
                "draft", "author", "created_at", "updated_at", "closed_at", "labels": [{"name", "color"}], "comments",
                "review": "approved" | "changes_requested" | "review_required" | "none",
                "checks": "passed" | "failed" | "running" | "none",
                "files": how many files it changes, "additions": lines added, "deletions": lines removed}],
     "open": how many open ones GitHub has, "closed": how many closed ones, "login": who they are for, "at": when}
"""

from datetime import UTC, datetime

from github_searcher.pr_tracking import ROLLUP

# Each view, and GitHub's search word for it.
VIEWS = {"created": "author", "assigned": "assignee", "mentioned": "mentions", "review-requested": "review-requested"}
MAX_PAGES = 5

SEARCH_QUERY = """
query($query: String!, $after: String) {
  search(query: $query, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url state isDraft createdAt updatedAt closedAt reviewDecision author { login }
        changedFiles additions deletions
        repository { nameWithOwner isPrivate }
        labels(first: 10) { nodes { name color } }
        comments { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
"""


def read(your_repositories, view: str) -> dict:
    """One view's PRs, open and closed. ValueError when you aren't signed in or GitHub refuses."""
    if view not in VIEWS:
        raise ValueError(f"Unknown view {view}.")
    account = your_repositories.github_account.load()
    if account is None:
        raise ValueError("Sign in with GitHub first: the GitHub tab, Account.")
    login = account["login"]
    nodes = []
    counts = {"open": 0, "closed": 0}
    for state in ["open", "closed"]:
        query = f"is:pr is:{state} {VIEWS[view]}:{login} archived:false sort:updated-desc"
        after = None
        for _ in range(MAX_PAGES):
            search = your_repositories.graphql(SEARCH_QUERY, {"query": query, "after": after})["search"]
            counts[state] = search["issueCount"]
            nodes.extend(search["nodes"])
            if not search["pageInfo"]["hasNextPage"]:
                break
            after = search["pageInfo"]["endCursor"]

    items = []
    for node in nodes:
        checks = "none"
        last = node["commits"]["nodes"]
        if last and last[0]["commit"]["statusCheckRollup"] is not None:
            checks = ROLLUP.get(last[0]["commit"]["statusCheckRollup"]["state"], "running")
        repo = node["repository"]["nameWithOwner"]
        items.append({
            "id": f"{repo}#{node['number']}",
            "repo": repo,
            "private": node["repository"]["isPrivate"],
            "number": node["number"],
            "title": node["title"],
            "url": node["url"],
            "state": node["state"].lower(),
            "draft": node["isDraft"],
            "author": node["author"]["login"] if node["author"] is not None else "ghost",
            "created_at": node["createdAt"],
            "updated_at": node["updatedAt"],
            "closed_at": node["closedAt"],
            "labels": [{"name": label["name"], "color": label["color"]} for label in node["labels"]["nodes"]],
            "comments": node["comments"]["totalCount"],
            "review": (node["reviewDecision"] or "none").lower(),
            "checks": checks,
            "files": node["changedFiles"],
            "additions": node["additions"],
            "deletions": node["deletions"],
        })
    return {"items": items, "open": counts["open"], "closed": counts["closed"], "login": login, "at": datetime.now(UTC).isoformat()}
