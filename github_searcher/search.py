"""Reads from GitHub: repos, files, READMEs, PR and issue activity, threads, issue facts, issue and code search.

Every request goes through token_balancer.py, which spreads them over the team's tokens, paces
them and waits out rate limits. Errors come back as httpx.HTTPStatusError, as before.
"""

from urllib.parse import quote

from github_searcher.token_balancer import BALANCER

# GitHub answers by request, so opening a repo or a file again is instant. Agents clear it
# at the start of every turn (github_searcher/agents.py), so they never work from old data.
CACHE = {}


def get_repository(owner: str, repo: str) -> dict:
    key = ("repository", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request("GET", f"https://api.github.com/repos/{owner}/{repo}")
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]


def get_contents(owner: str, repo: str, path: str, ref: str = "") -> dict | list:
    key = ("contents", owner, repo, path, ref)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request(
        "GET",
        f"https://api.github.com/repos/{owner}/{repo}/contents/{quote(path)}",
        params={"ref": ref} if ref else None,
    )
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]


def get_readme(owner: str, repo: str) -> str:
    key = ("readme", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request("GET", f"https://api.github.com/repos/{owner}/{repo}/readme", accept="application/vnd.github.raw+json")
    response.raise_for_status()
    CACHE[key] = response.text
    return CACHE[key]


ACTIVITY_QUERY = """
query($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    labels(first: 20, query: "first") { nodes { name } }
    merged: pullRequests(states: MERGED, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title createdAt mergedAt authorAssociation author { login __typename }
        reviews(first: 5) { nodes { createdAt author { login __typename } } }
        comments(first: 5) { nodes { createdAt author { login __typename } } }
      }
    }
    open: pullRequests(states: OPEN, first: 30, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title createdAt authorAssociation author { login __typename }
        reviews(first: 5) { nodes { createdAt author { login __typename } } }
        comments(first: 5) { nodes { createdAt author { login __typename } } }
      }
    }
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, since: $since) { totalCount nodes { author { user { login } } } }
        }
      }
    }
  }
}
"""

ISSUES_QUERY = """
query($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: $labels, first: 20, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title createdAt
        comments { totalCount }
        assignees { totalCount }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT]) { totalCount }
      }
    }
  }
}
"""


def get_activity(owner: str, repo: str, since: str) -> dict:
    # Two GraphQL calls: PRs, commits and the repo's "first"-style labels, then the open issues with those labels.
    key = ("activity", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request(
        "POST",
        "https://api.github.com/graphql",
        json={"query": ACTIVITY_QUERY, "variables": {"owner": owner, "name": repo, "since": since}},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("errors"):
        raise ValueError(data["errors"][0]["message"])
    activity = data["data"]["repository"]

    labels = [label["name"] for label in activity["labels"]["nodes"]]
    activity["issues"] = {"totalCount": 0, "nodes": []}
    if labels:
        response = BALANCER.request(
            "POST",
            "https://api.github.com/graphql",
            json={"query": ISSUES_QUERY, "variables": {"owner": owner, "name": repo, "labels": labels}},
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("errors"):
            raise ValueError(data["errors"][0]["message"])
        activity["issues"] = data["data"]["repository"]["issues"]

    CACHE[key] = activity
    return CACHE[key]


THREAD_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        title body state createdAt authorAssociation author { login __typename }
        labels(first: 10) { nodes { name } }
        assignees(first: 5) { nodes { login } }
        comments(first: 40) {
          totalCount
          nodes { body createdAt authorAssociation author { login __typename } }
        }
      }
      ... on PullRequest {
        title body state merged createdAt mergedAt authorAssociation author { login __typename }
        labels(first: 10) { nodes { name } }
        comments(first: 40) {
          totalCount
          nodes { body createdAt authorAssociation author { login __typename } }
        }
        reviews(first: 20) {
          totalCount
          nodes {
            body state createdAt authorAssociation author { login __typename }
            comments(first: 10) { nodes { body path createdAt author { login __typename } } }
          }
        }
      }
    }
  }
}
"""


def get_thread(owner: str, repo: str, number: int) -> dict:
    key = ("thread", owner, repo, number)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request(
        "POST",
        "https://api.github.com/graphql",
        json={"query": THREAD_QUERY, "variables": {"owner": owner, "name": repo, "number": number}},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("errors"):
        raise ValueError(data["errors"][0]["message"])
    CACHE[key] = data["data"]["repository"]["issueOrPullRequest"]
    return CACHE[key]


def get_tree(owner: str, repo: str, ref: str) -> dict:
    # Every file path in the repo in one call. GitHub sets "truncated" on very big repos.
    key = ("tree", owner, repo, ref)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request(
        "GET",
        f"https://api.github.com/repos/{owner}/{repo}/git/trees/{quote(ref)}",
        params={"recursive": "1"},
        timeout=60,
    )
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]


def search_code(q: str) -> dict:
    response = BALANCER.request(
        "GET",
        "https://api.github.com/search/code",
        accept="application/vnd.github.text-match+json",
        params={"q": q, "per_page": 50},
    )
    response.raise_for_status()
    return response.json()


def search_issues(q: str) -> dict:
    response = BALANCER.request(
        "GET",
        "https://api.github.com/search/issues",
        params={"q": q, "per_page": 50},
    )
    response.raise_for_status()
    return response.json()


ISSUE_FACTS_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    stargazerCount pushedAt
    issue(number: $number) {
      title state createdAt updatedAt authorAssociation author { login __typename }
      labels(first: 20) { nodes { name } }
      assignees(first: 10) { nodes { login } }
      participants { totalCount }
      reactions(content: THUMBS_UP) { totalCount }
      comments(last: 1) { totalCount nodes { createdAt authorAssociation author { login __typename } } }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state url author { login } repository { nameWithOwner } } }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 25) {
        nodes {
          __typename
          ... on CrossReferencedEvent { source { __typename ... on PullRequest { number state url author { login } repository { nameWithOwner } } } }
          ... on ConnectedEvent { subject { __typename ... on PullRequest { number state url author { login } repository { nameWithOwner } } } }
        }
      }
    }
  }
}
"""


def get_issue_facts(owner: str, repo: str, number: int) -> dict:
    # Never cached: it is asked for to see what changed. Returns the repository node, with the issue in it.
    response = BALANCER.request(
        "POST",
        "https://api.github.com/graphql",
        json={"query": ISSUE_FACTS_QUERY, "variables": {"owner": owner, "name": repo, "number": number}},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("errors"):
        raise ValueError(data["errors"][0]["message"])
    return data["data"]["repository"]


# A tracked repo's open issues in one call: the newest ones, and every open issue under a label whose name
# has "first", "beginner" or "easy" in it. GitHub's label search is loose ("first" also finds "Difficulty: Hard"),
# so tracked_issues.py keeps only the labels that really mean a good first issue.
TRACKED_ISSUES_QUERY = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount description
    newest: issues(first: 100, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } }
    firstLabels: labels(first: 10, query: "first") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
    beginnerLabels: labels(first: 10, query: "beginner") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
    easyLabels: labels(first: 10, query: "easy") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
  }
}
fragment TrackedIssue on Issue {
  number title url createdAt author { login }
  labels(first: 10) { nodes { name } }
  comments { totalCount }
  assignees { totalCount }
}
"""


def get_tracked_issues(owner: str, repo: str) -> dict:
    # Never cached: it is asked for to see what is new. Returns the repository node.
    response = BALANCER.request(
        "POST",
        "https://api.github.com/graphql",
        json={"query": TRACKED_ISSUES_QUERY, "variables": {"owner": owner, "name": repo}},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("errors"):
        raise ValueError(data["errors"][0]["message"])
    return data["data"]["repository"]
