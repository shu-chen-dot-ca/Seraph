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


def search_repositories(q: str, page: int = 1) -> dict:
    # Most stars first, 100 a page. GitHub gives at most 1,000 results (10 pages) for one query.
    response = BALANCER.request(
        "GET",
        "https://api.github.com/search/repositories",
        params={"q": q, "sort": "stars", "order": "desc", "per_page": 100, "page": page},
    )
    response.raise_for_status()
    return response.json()


def get_readme(owner: str, repo: str) -> str:
    key = ("readme", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = BALANCER.request("GET", f"https://api.github.com/repos/{owner}/{repo}/readme", accept="application/vnd.github.raw+json")
    response.raise_for_status()
    CACHE[key] = response.text
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


# What repo_signals.py works its numbers out from, in two calls that run at the same time (one would take
# GitHub over its 10 seconds for a big repo). $prs is 100, less for huge repos (see SIGNALS_SIZES).
# SIGNALS_QUERY:
# - oldestOpen: the $prs oldest open PRs (the ones nobody answered for a month are the stale pile);
# - commits on the default branch since $since;
# - open issues under beginner-style labels (GitHub's label search is loose, repo_signals.py keeps the real ones);
# - the files where projects write their AI policy, read from the default branch (null when missing).
# PULLS_QUERY:
# - recent: the $prs newest PRs (reply speed of outside contributors' PRs, and who is new);
# - finished: the $prs most recently updated merged or closed PRs (merge rate and merge time, who merges).
# closing says what closed a closed PR: a Commit when its change landed some other way (pytorch's bot).
SIGNALS_QUERY = """
query($owner: String!, $name: String!, $since: GitTimestamp!, $prs: Int!, $issues: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner description stargazerCount isArchived isFork pushedAt
    primaryLanguage { name }
    repositoryTopics(first: 20) { nodes { topic { name } } }
    oldestOpen: pullRequests(states: OPEN, first: $prs, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        createdAt authorAssociation author { login __typename }
        reviews(first: 5) { nodes { author { login __typename } } }
        comments(first: 5) { nodes { author { login __typename } } }
      }
    }
    defaultBranchRef { target { ... on Commit { history(since: $since) { totalCount } } } }
    firstLabels: labels(first: 10, query: "first") { nodes { ...LabelIssues } }
    beginnerLabels: labels(first: 10, query: "beginner") { nodes { ...LabelIssues } }
    easyLabels: labels(first: 10, query: "easy") { nodes { ...LabelIssues } }
    helpLabels: labels(first: 10, query: "help") { nodes { ...LabelIssues } }
    contributing: object(expression: "HEAD:CONTRIBUTING.md") { ... on Blob { text } }
    contributingRst: object(expression: "HEAD:CONTRIBUTING.rst") { ... on Blob { text } }
    githubContributing: object(expression: "HEAD:.github/CONTRIBUTING.md") { ... on Blob { text } }
    docsContributing: object(expression: "HEAD:docs/CONTRIBUTING.md") { ... on Blob { text } }
    aiPolicy: object(expression: "HEAD:AI_POLICY.md") { ... on Blob { text } }
    agentsFile: object(expression: "HEAD:AGENTS.md") { ... on Blob { text } }
    prTemplate: object(expression: "HEAD:.github/PULL_REQUEST_TEMPLATE.md") { ... on Blob { text } }
  }
}
fragment LabelIssues on Label {
  name
  issues(states: OPEN, first: $issues, orderBy: {field: CREATED_AT, direction: DESC}) {
    nodes {
      number title createdAt
      assignees { totalCount }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT]) { totalCount }
    }
  }
}
"""


# GitHub gives one GraphQL query 10 seconds and a budget of work; a huge repo (pytorch) can need more. Then
# GitHub answers 502 or 504, an answer cut off halfway, or an error like "Resource limits for this query
# exceeded". The heavy queries then try again asking for fewer items at a time, which is still plenty for
# medians and rates. These are the page sizes, from the normal one down; TOO_HEAVY are those errors' words.
SIGNALS_SIZES = [(100, 30), (50, 15), (25, 10)]
ACTIVITY_SIZES = [100, 50, 25]
FEEDBACK_SIZES = [40, 20, 10]
TIMEOUT_STATUSES = [502, 503, 504]
TOO_HEAVY = ["resource limits", "timeout", "timed out", "something went wrong"]


PULLS_QUERY = """
query($owner: String!, $name: String!, $prs: Int!) {
  repository(owner: $owner, name: $name) {
    recent: pullRequests(first: $prs, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        createdAt state merged mergedAt closedAt authorAssociation author { login __typename }
        closing: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { closer { __typename } } } }
        reviews(first: 5) { nodes { createdAt author { login __typename } } }
        comments(first: 5) { nodes { createdAt author { login __typename } } }
      }
    }
    finished: pullRequests(states: [MERGED, CLOSED], first: $prs, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        createdAt merged mergedAt closedAt mergedBy { login } authorAssociation author { login __typename }
        closing: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { closer { __typename } } } }
      }
    }
  }
}
"""


def get_repo_signals(owner: str, repo: str, since: str) -> dict:
    # Never cached: it is asked for to see how the repo is doing now. Returns the repository node, with
    # pageSize added: how many PRs each list asked for (fewer for huge repos).
    for prs, issues in SIGNALS_SIZES:
        variables = {"owner": owner, "name": repo, "since": since, "prs": prs, "issues": issues}
        last = prs == SIGNALS_SIZES[-1][0]
        response = BALANCER.request("POST", "https://api.github.com/graphql", json={"query": SIGNALS_QUERY, "variables": variables}, timeout=90)
        if response.status_code in TIMEOUT_STATUSES and not last:
            continue
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError:
            if not last:
                continue
            raise
        if data.get("errors"):
            message = data["errors"][0]["message"]
            if not last and any(words in message.lower() for words in TOO_HEAVY):
                continue
            raise ValueError(message)
        if data["data"]["repository"] is None:
            raise ValueError(f"GitHub has no repo {owner}/{repo}")
        repository = data["data"]["repository"]
        repository["pageSize"] = prs
        return repository


def get_repo_pulls(owner: str, repo: str) -> dict:
    # Never cached. Returns the repository node, with pageSize added: how many PRs each list asked for.
    for prs, issues in SIGNALS_SIZES:
        last = prs == SIGNALS_SIZES[-1][0]
        response = BALANCER.request("POST", "https://api.github.com/graphql", json={"query": PULLS_QUERY, "variables": {"owner": owner, "name": repo, "prs": prs}}, timeout=90)
        if response.status_code in TIMEOUT_STATUSES and not last:
            continue
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError:
            if not last:
                continue
            raise
        if data.get("errors"):
            message = data["errors"][0]["message"]
            if not last and any(words in message.lower() for words in TOO_HEAVY):
                continue
            raise ValueError(message)
        if data["data"]["repository"] is None:
            raise ValueError(f"GitHub has no repo {owner}/{repo}")
        repository = data["data"]["repository"]
        repository["pageSize"] = prs
        return repository


# How busy a repo is, for repo_signals.py: PRs and issues opened, merged and closed in the last 30 and 90 days
# (GitHub search counts, exact), commits in 90 days, the last release, community bits, and the 100 newest issues
# with their first comments (does a maintainer answer new issues?). The searches come in as variables.
REPO_ACTIVITY_QUERY = """
query($owner: String!, $name: String!, $since90: GitTimestamp!, $size: Int!,
      $prs30: String!, $prs90: String!, $merged30: String!, $merged90: String!,
      $issues30: String!, $issues90: String!, $closed30: String!, $closed90: String!) {
  prs30: search(query: $prs30, type: ISSUE) { issueCount }
  prs90: search(query: $prs90, type: ISSUE) { issueCount }
  merged30: search(query: $merged30, type: ISSUE) { issueCount }
  merged90: search(query: $merged90, type: ISSUE) { issueCount }
  issues30: search(query: $issues30, type: ISSUE) { issueCount }
  issues90: search(query: $issues90, type: ISSUE) { issueCount }
  closed30: search(query: $closed30, type: ISSUE) { issueCount }
  closed90: search(query: $closed90, type: ISSUE) { issueCount }
  repository(owner: $owner, name: $name) {
    hasDiscussionsEnabled
    codeOfConduct { name }
    releases(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt tagName } }
    defaultBranchRef { target { ... on Commit { history(since: $since90) { totalCount } } } }
    recentIssues: issues(first: $size, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        createdAt authorAssociation author { login __typename }
        comments(first: 10) { nodes { createdAt authorAssociation author { login __typename } } }
      }
    }
  }
}
"""


def get_repo_activity(owner: str, repo: str, since30: str, since90: str) -> dict:
    # Never cached. since30 and since90 are dates (2026-09-24). Returns the whole answer: the counts and the repository.
    name = f"{owner}/{repo}"
    variables = {
        "owner": owner,
        "name": repo,
        "since90": f"{since90}T00:00:00Z",
        "prs30": f"repo:{name} is:pr created:>={since30}",
        "prs90": f"repo:{name} is:pr created:>={since90}",
        "merged30": f"repo:{name} is:pr is:merged merged:>={since30}",
        "merged90": f"repo:{name} is:pr is:merged merged:>={since90}",
        "issues30": f"repo:{name} is:issue created:>={since30}",
        "issues90": f"repo:{name} is:issue created:>={since90}",
        "closed30": f"repo:{name} is:issue is:closed closed:>={since30}",
        "closed90": f"repo:{name} is:issue is:closed closed:>={since90}",
    }
    for size in ACTIVITY_SIZES:
        variables["size"] = size
        last = size == ACTIVITY_SIZES[-1]
        response = BALANCER.request("POST", "https://api.github.com/graphql", json={"query": REPO_ACTIVITY_QUERY, "variables": variables}, timeout=90)
        if response.status_code in TIMEOUT_STATUSES and not last:
            continue
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError:
            if not last:
                continue
            raise
        if data.get("errors"):
            message = data["errors"][0]["message"]
            if not last and any(words in message.lower() for words in TOO_HEAVY):
                continue
            raise ValueError(message)
        return data["data"]


def count_earlier_prs(owner: str, repo: str, logins: list[str], before: str) -> dict:
    """How many PRs each person opened in the repo before a date (2026-07-26): 0 means they are new there.

    One GraphQL call with a search per person. Never cached. Returns {login: count}.
    """
    if not logins:
        return {}
    names = []
    fields = []
    variables = {}
    for index, login in enumerate(logins):
        names.append(f"$q{index}: String!")
        fields.append(f"a{index}: search(query: $q{index}, type: ISSUE) {{ issueCount }}")
        variables[f"q{index}"] = f"repo:{owner}/{repo} is:pr author:{login} created:<{before}"
    query = "query(" + ", ".join(names) + ") {\n" + "\n".join(fields) + "\n}"
    response = BALANCER.request("POST", "https://api.github.com/graphql", json={"query": query, "variables": variables}, timeout=90)
    response.raise_for_status()
    data = response.json()
    if data.get("errors"):
        raise ValueError(data["errors"][0]["message"])
    counts = {}
    for index, login in enumerate(logins):
        counts[login] = data["data"][f"a{index}"]["issueCount"]
    return counts


# What maintainers write on finished PRs, for repo_signals.py to have Claude judge the review atmosphere:
# the 40 most recently updated merged or closed PRs (fewer for huge repos), with their comments, reviews and review line comments.
REVIEW_FEEDBACK_QUERY = """
query($owner: String!, $name: String!, $size: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, CLOSED], first: $size, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title merged authorAssociation author { login __typename }
        comments(first: 15) { nodes { body authorAssociation author { login __typename } } }
        reviews(first: 10) {
          nodes {
            body state authorAssociation author { login __typename }
            comments(first: 5) { nodes { body } }
          }
        }
      }
    }
  }
}
"""


def get_review_feedback(owner: str, repo: str) -> dict:
    # Never cached. Returns the repository node.
    for size in FEEDBACK_SIZES:
        variables = {"owner": owner, "name": repo, "size": size}
        last = size == FEEDBACK_SIZES[-1]
        response = BALANCER.request("POST", "https://api.github.com/graphql", json={"query": REVIEW_FEEDBACK_QUERY, "variables": variables}, timeout=90)
        if response.status_code in TIMEOUT_STATUSES and not last:
            continue
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError:
            if not last:
                continue
            raise
        if data.get("errors"):
            message = data["errors"][0]["message"]
            if not last and any(words in message.lower() for words in TOO_HEAVY):
                continue
            raise ValueError(message)
        return data["data"]["repository"]


# A tracked repo's open issues in one call: the newest ones, and every open issue under a label whose name
# has "first", "beginner", "easy", "help" or "grabs" in it. GitHub's label search is loose ("first" also finds
# "Difficulty: Hard"), so tracked_issues.py keeps only the labels that really mean a good first issue or help wanted.
TRACKED_ISSUES_QUERY = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount description
    newest: issues(first: 100, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } }
    firstLabels: labels(first: 10, query: "first") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
    beginnerLabels: labels(first: 10, query: "beginner") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
    easyLabels: labels(first: 10, query: "easy") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
    helpLabels: labels(first: 10, query: "help") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
    grabsLabels: labels(first: 10, query: "grabs") { nodes { name issues(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...TrackedIssue } } } }
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
