"""A repository's agent's own tools (the Workspace tab's Live): it reads its repo with the user's sign-in, and drafts
issues for it.

Only an agent that belongs to one of the user's repositories (its record's "repo", Agents.set_up_live) gets these
(agent.py). Every tool acts on that one repo, so none takes a repo's name: these can't read any other private repo.
They read GitHub from this computer, with the user's sign-in (your_repositories.py; the search tokens can't see a
private repo), and need no VM:
- repo_files: the files on the default branch (one folder, or all);
- repo_read: files, with line numbers;
- repo_search_code: GitHub's code search, in the repo only;
- repo_issues: the newest open or closed issues, or the ones a search finds (open and closed), and the repo's labels;
- repo_pulls: the newest open or closed pull requests;
- repo_thread: one issue or PR in full, with its comments and reviews.
draft_issue writes an issue for the user (github_searcher/issue_drafts.py): it shows in the chat as a card, and only
the user's Create issue opens it on GitHub, as them. Its labels must be the repo's own, and like every draft it has no
emoji. When the repo is a project in Auto mode (github_searcher/projects.py), the user asked for issues to be made
without them: draft_issue opens it on GitHub at once, as them, and the card says it was created. The chat's line for
each call is in WorkTools.describe().

A project's workers and reviewer get these too, for their project (their record's "project"). So do the Workflow tab's
agents (their record's "workflow"), only the ones that read the code and threads: their issues and pull requests may be
kept in the app, and they create issues with their own tools (workflow_tools.py).

    tools = RepoTools(agents, record).list()
"""

import asyncio
import json

import httpx
from claude_agent_sdk import tool

from github_searcher.agent.work_tools import EMOJI, NO_EMOJI
from github_searcher.search import THREAD_QUERY
from github_searcher.token_balancer import BALANCER

# repo_files lists this many files at most; repo_read shows this many lines of a file at a time.
FILES_SHOWN = 1000
LINES_SHOWN = 400
# Bodies, comments and review comments are cut, so one long thread doesn't flood the reply.
BODY_CHARS = 4000
COMMENT_CHARS = 1500
LINE_COMMENT_CHARS = 500
# GitHub's longest issue title.
TITLE_CHARS = 256
NOT_SIGNED_IN = "The user isn't signed in to GitHub, so your repository can't be read. Ask them to sign in (the GitHub tab, Account)."


class RepoTools:
    def __init__(self, agents, record: dict):
        # The Agents manager: your_repositories (the user's sign-in) and issue_drafts.
        self.agents = agents
        # The agent's record (the same dict): its "repo" is the repository these act on, or for a project's worker or
        # reviewer (github_searcher/projects.py), its "project".
        self.record = record
        self.agent_id = record["id"]
        self.repo = record.get("repo") or record.get("project") or record.get("workflow")

    def list(self) -> list:
        repo = self.repo
        tools = [
            tool(
                "repo_files",
                f"List the files of your repository ({repo}) on its default branch, with sizes. path limits it to one folder, "
                "e.g. 'src/'; leave it empty for the whole repo. Reads GitHub with the user's sign-in, so a private repo works too.",
                {"type": "object", "properties": {"path": {"type": "string"}}},
            )(self.repo_files),
            tool(
                "repo_read",
                f"Read files of your repository ({repo}) on its default branch, by path, all in one call. Lines are numbered. "
                f"Each file is cut at {LINES_SHOWN} lines; start_line reads further down.",
                {
                    "type": "object",
                    "properties": {"paths": {"type": "array", "items": {"type": "string"}}, "start_line": {"type": "integer"}},
                    "required": ["paths"],
                },
            )(self.repo_read),
            tool(
                "repo_search_code",
                f"Search the code of your repository ({repo}) with GitHub's code search: q is the words or code to find, e.g. "
                "'def send_pr' or 'retry language:python' (the repo is added for you). Up to 50 files with the matching "
                "lines. Only the default branch, and code pushed in the last minutes may be missing: read the file to be sure.",
                {"q": str},
            )(self.repo_search_code),
            tool(
                "repo_issues",
                f"See the issues of your repository ({repo}) and its labels. Without search: the newest 50 open ones (state "
                "closed: the closed ones), the newest change first, with how many are open and closed. search: words to look "
                "for, e.g. 'dark mode', to find issues (open and closed) about something, before you draft one that may exist.",
                {
                    "type": "object",
                    "properties": {"state": {"type": "string", "enum": ["open", "closed"]}, "search": {"type": "string"}},
                },
            )(self.repo_issues),
            tool(
                "repo_pulls",
                f"See the pull requests of your repository ({repo}): the newest 50 open ones (state closed: closed and "
                "merged), each with its branch, checks, review and labels.",
                {"type": "object", "properties": {"state": {"type": "string", "enum": ["open", "closed"]}}},
            )(self.repo_pulls),
            tool(
                "repo_thread",
                f"Read one issue or pull request of your repository ({repo}) in full, by number: its description, comments "
                "and, for a PR, its reviews with their comments on lines.",
                {"number": int},
            )(self.repo_thread),
            tool(
                "draft_issue",
                f"Draft an issue for your repository ({repo}), for the user to create. It shows in your chat with them as a "
                "card; their Create issue opens it on GitHub as them, Discard drops it, and you hear which with your next "
                "message. title: short and specific, in the repo's style. body: the issue in markdown, written for the agent "
                "that will do the work: what and why, where in the code (files, functions), what done looks like (a short "
                "checklist), and what to watch out for. labels: the repo's own labels that fit (repo_issues lists them); "
                "leave it out when none fits. No emoji.",
                {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "labels": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["title", "body"],
                },
            )(self.draft_issue),
        ]
        # The Workflow tab's agents: its issues and pull requests are in workflow_status, and issue_create makes issues.
        if self.record.get("workflow") is not None:
            tools = [item for item in tools if item.name in ["repo_files", "repo_read", "repo_search_code", "repo_thread"]]
        return tools

    async def repo_files(self, args: dict) -> dict:
        repo = self.repo
        try:
            tree = await asyncio.to_thread(self.agents.your_repositories.tree, repo)
        except (ValueError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not read the files: {error}"}], "is_error": True}

        path = (args.get("path") or "").strip("/")
        files = []
        for item in tree["files"]:
            if item["type"] != "blob":
                continue
            if path and not item["path"].startswith(path + "/"):
                continue
            files.append(f"{item['path']} ({item['size']:,} B)")

        text = "\n".join(files[:FILES_SHOWN])
        if len(files) > FILES_SHOWN:
            text += f"\n[{len(files) - FILES_SHOWN:,} more files not shown; pass a folder as path]"
        if tree["truncated"]:
            text += "\n[GitHub cut this listing: the repo is very big; pass a folder as path]"
        if not files:
            text = "No files there."
        return {"content": [{"type": "text", "text": text}]}

    async def repo_read(self, args: dict) -> dict:
        repo = self.repo
        start = max(args.get("start_line") or 1, 1)
        # All files at the same time instead of one after another.
        paths = [path.strip("/") for path in args["paths"]]
        results = await asyncio.gather(*[asyncio.to_thread(self.agents.your_repositories.file, repo, path) for path in paths], return_exceptions=True)
        parts = []
        for path, data in zip(paths, results):
            if isinstance(data, Exception):
                parts.append(f"=== {path}\nCould not read it: {data}")
                continue
            if data["too_big"]:
                parts.append(f"=== {path}\nToo big to read here ({data['size']:,} B).")
                continue
            if data["binary"]:
                parts.append(f"=== {path}\nBinary file, not text.")
                continue
            lines = data["text"].splitlines()
            shown = lines[start - 1:start - 1 + LINES_SHOWN]
            numbered = [f"{start + index}: {line[:300]}" for index, line in enumerate(shown)]
            header = f"=== {path} (lines {start}-{start + len(shown) - 1} of {len(lines)})"
            if start - 1 + LINES_SHOWN < len(lines):
                numbered.append(f"[cut; read on with start_line {start + LINES_SHOWN}]")
            parts.append(header + "\n" + "\n".join(numbered))
        return {"content": [{"type": "text", "text": "\n\n".join(parts)}]}

    async def repo_search_code(self, args: dict) -> dict:
        repo = self.repo
        token = self.agents.your_repositories.token()
        if token is None:
            return {"content": [{"type": "text", "text": NOT_SIGNED_IN}], "is_error": True}
        try:
            response = await asyncio.to_thread(
                BALANCER.request,
                "GET",
                "https://api.github.com/search/code",
                accept="application/vnd.github.text-match+json",
                params={"q": f"{args['q']} repo:{repo}", "per_page": 50},
                own_token=token,
            )
        except httpx.HTTPError as error:
            return {"content": [{"type": "text", "text": f"Could not search: {error}"}], "is_error": True}
        if response.status_code != 200:
            return {"content": [{"type": "text", "text": f"GitHub answered {response.status_code}: {response.text[:300]}"}], "is_error": True}

        result = response.json()
        files = []
        for item in result["items"]:
            matches = [match["fragment"][:400] for match in item.get("text_matches", [])]
            files.append({"path": item["path"], "matches": matches})
        return {"content": [{"type": "text", "text": json.dumps({"total_count": result["total_count"], "files": files})}]}

    async def repo_issues(self, args: dict) -> dict:
        repo = self.repo
        search = (args.get("search") or "").strip()
        state = args.get("state") or "open"
        token = self.agents.your_repositories.token()
        if token is None:
            return {"content": [{"type": "text", "text": NOT_SIGNED_IN}], "is_error": True}
        report = {}
        try:
            labels = await asyncio.to_thread(self.agents.your_repositories.labels, repo)
            report["labels"] = [label["name"] for label in labels]
            if search:
                response = await asyncio.to_thread(
                    BALANCER.request,
                    "GET",
                    "https://api.github.com/search/issues",
                    params={"q": f"repo:{repo} is:issue {search}", "per_page": 50},
                    own_token=token,
                )
                if response.status_code != 200:
                    return {"content": [{"type": "text", "text": f"GitHub answered {response.status_code}: {response.text[:300]}"}], "is_error": True}
                report["found"] = response.json()["total_count"]
                report["issues"] = []
                for item in response.json()["items"]:
                    report["issues"].append({
                        "number": item["number"],
                        "title": item["title"],
                        "state": item["state"],
                        "labels": [label["name"] for label in item["labels"]],
                        "comments": item["comments"],
                        "author": item["user"]["login"] if item["user"] else "ghost",
                        "opened": item["created_at"][:10],
                        "updated": item["updated_at"][:10],
                    })
            else:
                data = await asyncio.to_thread(self.agents.your_repositories.issues, repo, state)
                report["open"] = data["open"]
                report["closed"] = data["closed"]
                report["issues"] = []
                for issue in data["items"]:
                    report["issues"].append({
                        "number": issue["number"],
                        "title": issue["title"],
                        "state": issue["state"],
                        "labels": [label["name"] for label in issue["labels"]],
                        "assignees": issue["assignees"],
                        "comments": issue["comments"],
                        "author": issue["author"],
                        "opened": issue["created_at"][:10],
                        "updated": issue["updated_at"][:10],
                    })
        except (ValueError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not read the issues: {error}"}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    async def repo_pulls(self, args: dict) -> dict:
        repo = self.repo
        state = args.get("state") or "open"
        try:
            data = await asyncio.to_thread(self.agents.your_repositories.pulls, repo, state)
        except (ValueError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not read the pull requests: {error}"}], "is_error": True}
        report = {"open": data["open"], "closed": data["closed"], "pulls": []}
        for pull in data["items"]:
            report["pulls"].append({
                "number": pull["number"],
                "title": pull["title"],
                "state": pull["state"],
                "draft": pull["draft"],
                "author": pull["author"],
                "branch": pull["branch"],
                "checks": pull["checks"],
                "review": pull["review"],
                "labels": [label["name"] for label in pull["labels"]],
                "comments": pull["comments"],
                "opened": pull["created_at"][:10],
                "updated": pull["updated_at"][:10],
            })
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    async def repo_thread(self, args: dict) -> dict:
        repo = self.repo
        number = args["number"]
        token = self.agents.your_repositories.token()
        if token is None:
            return {"content": [{"type": "text", "text": NOT_SIGNED_IN}], "is_error": True}
        variables = {"owner": repo.split("/")[0], "name": repo.split("/")[1], "number": number}
        try:
            response = await asyncio.to_thread(
                BALANCER.request,
                "POST",
                "https://api.github.com/graphql",
                json={"query": THREAD_QUERY, "variables": variables},
                timeout=60,
                own_token=token,
            )
        except httpx.HTTPError as error:
            return {"content": [{"type": "text", "text": f"Could not read #{number}: {error}"}], "is_error": True}
        if response.status_code != 200:
            return {"content": [{"type": "text", "text": f"GitHub answered {response.status_code}: {response.text[:300]}"}], "is_error": True}
        answer = response.json()
        if answer.get("errors"):
            return {"content": [{"type": "text", "text": f"Could not read #{number}: {answer['errors'][0]['message']}"}], "is_error": True}
        data = answer["data"]["repository"]["issueOrPullRequest"]
        if data is None:
            return {"content": [{"type": "text", "text": f"There is no issue or PR #{number}."}], "is_error": True}

        body = data["body"] or ""
        if len(body) > BODY_CHARS:
            body = body[:BODY_CHARS] + "\n[cut]"
        result = {
            "kind": "pr" if data["__typename"] == "PullRequest" else "issue",
            "title": data["title"],
            "state": data["state"],
            "opened": data["createdAt"][:10],
            "author": data["author"]["login"] if data["author"] else "ghost",
            "labels": [label["name"] for label in data["labels"]["nodes"]],
            "body": body,
            "comments": [],
        }
        if data["__typename"] == "Issue":
            result["assignees"] = [person["login"] for person in data["assignees"]["nodes"]]
        if data["__typename"] == "PullRequest":
            result["merged"] = data["merged"]

        for comment in data["comments"]["nodes"]:
            text = comment["body"]
            if len(text) > COMMENT_CHARS:
                text = text[:COMMENT_CHARS] + "\n[cut]"
            author = comment["author"]["login"] if comment["author"] else "ghost"
            result["comments"].append({"at": comment["createdAt"][:16], "author": author, "text": text})
        if data["comments"]["totalCount"] > len(data["comments"]["nodes"]):
            result["comments_not_shown"] = data["comments"]["totalCount"] - len(data["comments"]["nodes"])

        if data["__typename"] == "PullRequest":
            result["reviews"] = []
            for review in data["reviews"]["nodes"]:
                text = review["body"] or ""
                if len(text) > COMMENT_CHARS:
                    text = text[:COMMENT_CHARS] + "\n[cut]"
                author = review["author"]["login"] if review["author"] else "ghost"
                lines = []
                for line in review["comments"]["nodes"]:
                    line_text = line["body"]
                    if len(line_text) > LINE_COMMENT_CHARS:
                        line_text = line_text[:LINE_COMMENT_CHARS] + "\n[cut]"
                    lines.append({"file": line["path"], "text": line_text})
                result["reviews"].append({"at": review["createdAt"][:16], "author": author, "verdict": review["state"], "text": text, "on_lines": lines})
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    async def draft_issue(self, args: dict) -> dict:
        repo = self.repo
        title = (args.get("title") or "").strip()
        body = (args.get("body") or "").strip()
        labels = args.get("labels") or []
        if not title:
            return {"content": [{"type": "text", "text": "Give the issue a title."}], "is_error": True}
        if len(title) > TITLE_CHARS:
            return {"content": [{"type": "text", "text": f"The title is {len(title)} characters; GitHub takes {TITLE_CHARS} at most. Make it shorter."}], "is_error": True}
        if not body:
            return {"content": [{"type": "text", "text": "Write what the issue is about in body."}], "is_error": True}
        found = EMOJI.findall(title + body)
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        if labels:
            repo_labels = await asyncio.to_thread(self.agents.your_repositories.labels, repo)
            names = [label["name"] for label in repo_labels]
            unknown = [label for label in labels if label not in names]
            if unknown:
                text = f"Not labels of {repo}: {', '.join(unknown)}. Its labels: {', '.join(names) or 'none'}. Use those, or leave labels out."
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        draft = await asyncio.to_thread(self.agents.issue_drafts.create, self.agent_id, repo, title, body, labels)

        # Auto mode: the user wants the issues made without them, so it is opened on GitHub now, as them.
        project = self.agents.projects.get(repo)
        if project is not None and project["on"] and project["mode"] == "auto":
            fields = {"title": title, "body": body, "labels": labels}
            try:
                result = await asyncio.to_thread(self.agents.your_repositories.act, repo, "new_issue", None, "issue", fields)
            except (ValueError, httpx.HTTPError) as error:
                text = f"Drafted {draft['id']}, but it couldn't be opened on GitHub ({error}): it waits in your chat for the user's Create issue."
                return {"content": [{"type": "text", "text": text}]}
            number = int(result["url"].rstrip("/").split("/")[-1])
            await asyncio.to_thread(self.agents.issue_drafts.decide, draft["id"], "created", result["url"], number)
            text = f"Created {draft['id']} on GitHub as {repo}#{number} ({result['url']}), since the project is in Auto mode. A worker takes it next."
            return {"content": [{"type": "text", "text": text}]}

        text = (
            f"Drafted {draft['id']}. It shows in your chat with the user as a card: Create issue opens it on GitHub as them, "
            "Discard drops it. You hear which with your next message; don't draft it again meanwhile."
        )
        return {"content": [{"type": "text", "text": text}]}
