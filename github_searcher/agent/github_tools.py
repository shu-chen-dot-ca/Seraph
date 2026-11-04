"""GitHub tools for an agent: READMEs, PR and issue activity, threads, issue search and code.

Used by the search chat agent and by the VM agents. Each successful call adds one
activity line to the agent's history (the same list).
"""

import asyncio
import base64
import json

import httpx
from claude_agent_sdk import tool

from github_searcher.search import get_contents, get_readme, get_repository, get_thread, get_tree, search_code, search_issues
from github_searcher.token_balancer import BALANCER


class GithubTools:
    def __init__(self, history: list, repo_signals):
        self.history = history
        # check_activity works its numbers out the way the Repos page does (github_searcher/repo_signals.py).
        self.repo_signals = repo_signals

    def list(self) -> list:
        return [
            tool("read_readme", "Read the README of repos, by full name (owner/name). Each README is cut at 4,000 characters. Use it whenever the README would help you judge or answer, whether or not you plan to add the repo.", {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]})(self.read_readme),
            tool("check_activity", "Check how repos treat outside contributors, by full name (owner/name), the same numbers the Repos page shows: of outside contributors' PRs in the last 90 days, the merge rate (merged / merged + closed unmerged) and median days to a first reply and to merge; their open PRs over 30 days old nobody answered (stale); how many people merged PRs and how many commits landed in the last 30 days; open good-first / beginner / help-wanted issues (with assignees and cross references: above 0 usually means taken); the AI policy from CONTRIBUTING, AI_POLICY.md or AGENTS.md (welcome, disclose, no_ai, unclear or none, with the deciding quote); how newcomers' first PRs fare (merged, reply speed, came back); PRs, issues and commits a month and how often maintainers answer new issues; and the review atmosphere (warm, neutral, strict or curt, a summary and what reviewers ask for).", {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]})(self.check_activity),
            tool("read_thread", "Read issues or PRs in full: the description and the comments, with who wrote each and their role. A PR also has its reviews and its conversations on lines of code (each with its id and its comments' ids, and whether it is resolved). Each is given as owner/name#number, e.g. 'feast-dev/feast#1234'.", {"type": "object", "properties": {"threads": {"type": "array", "items": {"type": "string"}}}, "required": ["threads"]})(self.read_thread),
            tool("list_files", "List the files in a repo (owner/name) on its default branch, with sizes. path limits it to one folder, e.g. 'src/'; leave it empty for the whole repo.", {"type": "object", "properties": {"name": {"type": "string"}, "path": {"type": "string"}}, "required": ["name"]})(self.list_files),
            tool("read_files", "Read source files of one repo (owner/name) on its default branch, by path, all in one call. Lines are numbered. Each file is cut at 400 lines; start_line reads further down.", {"type": "object", "properties": {"name": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "start_line": {"type": "integer"}}, "required": ["name", "paths"]})(self.read_files),
            tool("search_code", "Search code on GitHub. q is a code search query, e.g. 'retry repo:feast-dev/feast' or 'def score language:python repo:truera/trulens'. Returns up to 50 matching files with the matching lines. Only the default branch is searched.", {"q": str})(self.search_code),
            tool("search_issues", "Search issues and PRs on GitHub. q is an issue search query, e.g. 'repo:owner/name is:issue is:open label:bug streaming' or 'repo:owner/name is:pr is:merged author:someone'. Returns up to 50 with state, labels, comment count and dates.", {"q": str})(self.search_issues),
        ]

    async def read_readme(self, args: dict) -> dict:
        readmes = {}
        names = [name for name in args["names"] if name.count("/") == 1]
        for name in args["names"]:
            if name not in names:
                readmes[name] = "Not a full name (owner/name)."

        # Fetch all READMEs at the same time instead of one after another.
        results = await asyncio.gather(*[asyncio.to_thread(get_readme, name.split("/")[0], name.split("/")[1]) for name in names], return_exceptions=True)
        for name, text in zip(names, results):
            if isinstance(text, httpx.HTTPStatusError) and text.response.status_code == 404:
                text = "This repo has no README."
            elif isinstance(text, httpx.HTTPStatusError):
                readmes[name] = f"GitHub error: {text.response.text}"
                continue
            elif isinstance(text, Exception):
                readmes[name] = f"Could not read the README: {text}"
                continue
            if len(text) > 4000:
                text = text[:4000] + "\n[cut]"
            readmes[name] = text

        read = [name for name in names if not readmes.get(name, "").startswith(("GitHub error:", "Could not read"))]
        if read:
            self.history.append({"role": "activity", "text": f"Read README of {', '.join(read)}"})
        return {"content": [{"type": "text", "text": json.dumps(readmes)}]}

    async def check_activity(self, args: dict) -> dict:
        report = {}
        names = [name for name in args["names"] if name.count("/") == 1]
        for name in args["names"]:
            if name not in names:
                report[name] = "Not a full name (owner/name)."

        # The same numbers the Repos page shows (repo_signals.py), worked out fresh. A few repos at a time:
        # each is one heavy GraphQL query, and GitHub's secondary limits punish many at once. As many at a time
        # as the tokens can run (token_balancer.py), so the rest don't sit in threads waiting for a turn.
        results = []
        step = BALANCER.slots("graphql")
        for start in range(0, len(names), step):
            batch = names[start:start + step]
            results += await asyncio.gather(*[self.repo_signals.fetch(name) for name in batch], return_exceptions=True)

        for name, data in zip(names, results):
            if isinstance(data, httpx.HTTPStatusError):
                report[name] = f"GitHub error: {data.response.text}"
                continue
            if isinstance(data, Exception):
                report[name] = f"Could not check activity: {data}"
                continue
            # basis is only for knowing when to ask Claude about the policy again.
            data["ai_policy"].pop("basis", None)
            report[name] = data

        checked = [name for name in names if isinstance(report.get(name), dict)]
        if checked:
            self.history.append({"role": "activity", "text": f"Checked activity of {', '.join(checked)}"})
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    async def read_thread(self, args: dict) -> dict:
        report = {}
        threads = []
        for thread in args["threads"]:
            name = thread.split("#")[0]
            number = thread.split("#")[-1]
            if "#" not in thread or name.count("/") != 1 or not number.isdigit():
                report[thread] = "Not owner/name#number."
                continue
            threads.append(thread)

        # A few threads at a time, like check_activity: each is a GraphQL query.
        results = []
        step = BALANCER.slots("graphql")
        for start in range(0, len(threads), step):
            batch = threads[start:start + step]
            results += await asyncio.gather(*[asyncio.to_thread(get_thread, thread.split("/")[0], thread.split("#")[0].split("/")[1], int(thread.split("#")[-1])) for thread in batch], return_exceptions=True)
        for thread, data in zip(threads, results):
            if isinstance(data, httpx.HTTPStatusError):
                report[thread] = f"GitHub error: {data.response.text}"
                continue
            if isinstance(data, Exception):
                report[thread] = f"Could not read the thread: {data}"
                continue
            if data is None:
                report[thread] = "No issue or PR with that number."
                continue

            # Bodies are cut so one long thread doesn't flood the reply.
            body = data["body"] or ""
            if len(body) > 2000:
                body = body[:2000] + "\n[cut]"
            result = {
                "kind": "pr" if data["__typename"] == "PullRequest" else "issue",
                "title": data["title"],
                "state": data["state"],
                "opened": data["createdAt"][:10],
                "author": data["author"]["login"] if data["author"] else "ghost",
                "author_role": data["authorAssociation"],
                "labels": [label["name"] for label in data["labels"]["nodes"]],
                "body": body,
                "comments": [],
            }
            if data["__typename"] == "Issue":
                result["assignees"] = [person["login"] for person in data["assignees"]["nodes"]]
            if data["__typename"] == "PullRequest":
                result["merged"] = data["merged"]
                result["merged_at"] = data["mergedAt"][:10] if data["mergedAt"] else None

            for comment in data["comments"]["nodes"]:
                text = comment["body"]
                if len(text) > 800:
                    text = text[:800] + "\n[cut]"
                author = comment["author"]["login"] if comment["author"] else "ghost"
                role = "BOT" if comment["author"] and comment["author"]["__typename"] != "User" else comment["authorAssociation"]
                result["comments"].append({"at": comment["createdAt"][:16], "author": author, "role": role, "text": text})
            if data["comments"]["totalCount"] > len(data["comments"]["nodes"]):
                result["comments_not_shown"] = data["comments"]["totalCount"] - len(data["comments"]["nodes"])

            if data["__typename"] == "PullRequest":
                result["reviews"] = []
                for review in data["reviews"]["nodes"]:
                    text = review["body"] or ""
                    if len(text) > 800:
                        text = text[:800] + "\n[cut]"
                    author = review["author"]["login"] if review["author"] else "ghost"
                    role = "BOT" if review["author"] and review["author"]["__typename"] != "User" else review["authorAssociation"]
                    result["reviews"].append({"at": review["createdAt"][:16], "author": author, "role": role, "verdict": review["state"], "text": text})

                # The comments on lines of code, by conversation, with their replies. A comment's id is what
                # draft_comment's reply_to answers.
                result["conversations"] = []
                for conversation in data["reviewThreads"]["nodes"]:
                    lines = []
                    for line in conversation["comments"]["nodes"]:
                        line_text = line["body"]
                        if len(line_text) > 500:
                            line_text = line_text[:500] + "\n[cut]"
                        line_author = line["author"]["login"] if line["author"] else "ghost"
                        line_role = "BOT" if line["author"] and line["author"]["__typename"] != "User" else line["authorAssociation"]
                        lines.append({"id": line["databaseId"], "at": line["createdAt"][:16], "author": line_author, "role": line_role, "text": line_text})
                    result["conversations"].append({
                        "id": conversation["id"],
                        "file": conversation["path"],
                        "line": conversation["line"],
                        "resolved": conversation["isResolved"],
                        "outdated": conversation["isOutdated"],
                        "comments": lines,
                    })
                if data["reviewThreads"]["totalCount"] > len(data["reviewThreads"]["nodes"]):
                    result["conversations_not_shown"] = data["reviewThreads"]["totalCount"] - len(data["reviewThreads"]["nodes"])

            report[thread] = result

        read = [thread for thread in threads if isinstance(report.get(thread), dict)]
        if read:
            self.history.append({"role": "activity", "text": f"Read {', '.join(read)}"})
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    async def list_files(self, args: dict) -> dict:
        name = args["name"]
        if name.count("/") != 1:
            return {"content": [{"type": "text", "text": "Not a full name (owner/name)."}], "is_error": True}
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        try:
            info = await asyncio.to_thread(get_repository, owner, repo)
            tree = await asyncio.to_thread(get_tree, owner, repo, info["default_branch"])
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error: {error.response.text}"}], "is_error": True}

        path = (args.get("path") or "").strip("/")
        files = []
        for item in tree["tree"]:
            if item["type"] != "blob":
                continue
            if path and not item["path"].startswith(path + "/"):
                continue
            files.append(f"{item['path']} ({item.get('size', 0):,} B)")

        text = "\n".join(files[:1000])
        if len(files) > 1000:
            text += f"\n[{len(files) - 1000:,} more files not shown; pass a folder as path]"
        if tree.get("truncated"):
            text += "\n[GitHub cut this listing: the repo is very big; pass a folder as path]"
        if not files:
            text = "No files there."
        self.history.append({"role": "activity", "text": f"Listed files of {name}" + (f" in `{path}/`" if path else "")})
        return {"content": [{"type": "text", "text": text}]}

    async def read_files(self, args: dict) -> dict:
        name = args["name"]
        if name.count("/") != 1:
            return {"content": [{"type": "text", "text": "Not a full name (owner/name)."}], "is_error": True}
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        start = max(args.get("start_line") or 1, 1)
        try:
            info = await asyncio.to_thread(get_repository, owner, repo)
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error: {error.response.text}"}], "is_error": True}
        ref = info["default_branch"]

        # Fetch all files at the same time instead of one after another.
        paths = [path.strip("/") for path in args["paths"]]
        results = await asyncio.gather(*[asyncio.to_thread(get_contents, owner, repo, path, ref) for path in paths], return_exceptions=True)
        parts = []
        for path, data in zip(paths, results):
            if isinstance(data, httpx.HTTPStatusError) and data.response.status_code == 404:
                parts.append(f"=== {path}\nNo such file.")
                continue
            if isinstance(data, Exception):
                parts.append(f"=== {path}\nCould not read it: {data}")
                continue
            if isinstance(data, list):
                parts.append(f"=== {path}\nThis is a folder; use list_files.")
                continue
            if data.get("encoding") != "base64":
                parts.append(f"=== {path}\nToo big to read (over 1 MB).")
                continue
            try:
                text = base64.b64decode(data["content"]).decode("utf-8")
            except UnicodeDecodeError:
                parts.append(f"=== {path}\nBinary file, not text.")
                continue

            lines = text.splitlines()
            shown = lines[start - 1:start - 1 + 400]
            numbered = [f"{start + index}: {line[:300]}" for index, line in enumerate(shown)]
            header = f"=== {path} (lines {start}-{start + len(shown) - 1} of {len(lines)})"
            if start - 1 + 400 < len(lines):
                numbered.append(f"[cut; read on with start_line {start + 400}]")
            parts.append(header + "\n" + "\n".join(numbered))

        read = [path for path, part in zip(paths, parts) if " (lines " in part.split("\n")[0]]
        if read:
            self.history.append({"role": "activity", "text": f"Read {', '.join(read)} in {name}"})
        return {"content": [{"type": "text", "text": "\n\n".join(parts)}]}

    async def search_code(self, args: dict) -> dict:
        try:
            result = await asyncio.to_thread(search_code, args["q"])
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error: {error.response.text}"}], "is_error": True}

        files = []
        for item in result["items"]:
            matches = [match["fragment"][:400] for match in item.get("text_matches", [])]
            files.append({"repo": item["repository"]["full_name"], "path": item["path"], "matches": matches})
        self.history.append({"role": "activity", "text": f"Searched code `{args['q']}` → {result['total_count']:,} files"})
        return {"content": [{"type": "text", "text": json.dumps({"total_count": result["total_count"], "files": files})}]}


    async def search_issues(self, args: dict) -> dict:
        try:
            result = await asyncio.to_thread(search_issues, args["q"])
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error: {error.response.text}"}], "is_error": True}

        items = []
        for item in result["items"]:
            items.append(
                {
                    "repo": item["repository_url"].removeprefix("https://api.github.com/repos/"),
                    "number": item["number"],
                    "kind": "pr" if "pull_request" in item else "issue",
                    "title": item["title"],
                    "state": item["state"],
                    "labels": [label["name"] for label in item["labels"]],
                    "comments": item["comments"],
                    "assignees": len(item["assignees"] or []),
                    "author": item["user"]["login"] if item["user"] else "ghost",
                    "author_role": item.get("author_association"),
                    "opened": item["created_at"][:10],
                    "updated": item["updated_at"][:10],
                }
            )
        self.history.append({"role": "activity", "text": f"Searched issues `{args['q']}` → {result['total_count']:,} found"})
        return {"content": [{"type": "text", "text": json.dumps({"total_count": result["total_count"], "items": items})}]}
