import asyncio
import json
import threading
import uuid
from pathlib import Path

import httpx
from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, TextBlock, ThinkingBlock, ToolUseBlock, create_sdk_mcp_server, tool

from github_searcher import search as github
from github_searcher.search import get_branches, get_contents, get_contents_html, get_readme, get_repository, search_repositories

SYSTEM_PROMPT = (Path(__file__).parent / "prompt.md").read_text()

PREFIXES = [
    "",
    "NOT ",
    "in:",
    "stars:",
    "forks:",
    "followers:",
    "size:",
    "topics:",
    "good-first-issues:",
    "help-wanted-issues:",
    "created:",
    "pushed:",
    "language:",
    "topic:",
    "license:",
    "user:",
    "org:",
    "repo:",
    "archived:",
    "fork:",
    "mirror:",
    "template:",
    "is:",
    "has:",
    "-topic:",
    "-language:",
    "-license:",
    "-user:",
    "-org:",
    "-repo:",
    "sort:",
]


class SearchChatAgent:
    def __init__(self, session_id: str | None = None, history: list | None = None, repos: list | None = None):
        self.tokens = 0
        self.cost = 0.0
        self.interrupt = False
        self.entries = []
        self.mode = "Auto"
        self.session_id = session_id
        self.history = history or []
        self.repos = repos or []
        self.seen = {}
        self.query = ""
        self.result = None

        # A new chat session starts with an empty preview cache, filled with its own repos.
        github.CACHE.clear()
        names = [repo["full_name"] for repo in self.repos]
        threading.Thread(target=self.prefetch, args=(names,), daemon=True).start()

        tools = [
            tool("add_filter", "Add one filter row. prefix must be one of the supported prefixes, value is what follows it, e.g. prefix 'stars:' value '>100'.", {"prefix": str, "value": str})(self.add_filter),
            tool("update_filter", "Change the value of one filter row by its id.", {"id": str, "value": str})(self.update_filter),
            tool("remove_filter", "Remove one filter row by its id.", {"id": str})(self.remove_filter),
            tool("show_search", "Run the user's filter query in the app, like pressing Search. The results show up in the user's Search result tab. Returns all repos on the page (up to 100) with metadata.", {})(self.show_search),
            tool("search", "Search GitHub on your own; this doesn't touch the user's filters or results. q is a full GitHub query (keywords and qualifiers). sort is stars, forks, updated or help-wanted-issues, add -asc for ascending; leave it empty for best match. Returns up to 100 repos with metadata.", {"type": "object", "properties": {"q": {"type": "string"}, "sort": {"type": "string"}, "page": {"type": "integer"}}, "required": ["q"]})(self.search),
            tool("read_readme", "Read the README of repos, by full name (owner/name). Each README is cut at 4,000 characters. Use it whenever the README would help you judge or answer, whether or not you plan to add the repo.", {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]})(self.read_readme),
            tool("add_to_session", "Add repos to the session list the user sees, by full name (owner/name).", {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]})(self.add_to_session),
            tool("remove_from_session", "Remove repos from the session list, by full name.", {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]})(self.remove_from_session),
            tool("rank_session", "Reorder the session list: names in best-first order. Repos you leave out keep their order after them.", {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "string"}}}, "required": ["names"]})(self.rank_session),
            tool("get_session", "Get the repos in the session list with their metadata.", {})(self.get_session),
        ]
        self.client = ClaudeSDKClient(
            ClaudeAgentOptions(
                model="claude-opus-5-5",
                system_prompt=SYSTEM_PROMPT,
                tools=[],
                mcp_servers={"filters": create_sdk_mcp_server(name="filters", tools=tools)},
                allowed_tools=["mcp__filters__add_filter", "mcp__filters__update_filter", "mcp__filters__remove_filter", "mcp__filters__show_search", "mcp__filters__search", "mcp__filters__read_readme", "mcp__filters__add_to_session", "mcp__filters__remove_from_session", "mcp__filters__rank_session", "mcp__filters__get_session"],
                permission_mode="dontAsk",
                setting_sources=[],
                strict_mcp_config=True,
                max_turns=50,
                resume=session_id,
            )
        )

    def state(self) -> str:
        return json.dumps({"entries": self.entries})

    async def add_filter(self, args: dict) -> dict:
        if self.mode == "Plan":
            return {"content": [{"type": "text", "text": "Plan mode: you can't change filters."}], "is_error": True}
        if args["prefix"] not in PREFIXES:
            return {"content": [{"type": "text", "text": f"Unknown prefix {args['prefix']!r}. Use one of: {PREFIXES}"}], "is_error": True}
        self.entries.append({"id": uuid.uuid4().hex[:8], "prefix": args["prefix"], "value": args["value"]})
        self.history.append({"role": "activity", "text": f"Added filter `{args['prefix']}{args['value']}`"})
        return {"content": [{"type": "text", "text": self.state()}]}

    async def update_filter(self, args: dict) -> dict:
        if self.mode == "Plan":
            return {"content": [{"type": "text", "text": "Plan mode: you can't change filters."}], "is_error": True}
        for entry in self.entries:
            if entry["id"] == args["id"]:
                entry["value"] = args["value"]
                self.history.append({"role": "activity", "text": f"Changed filter to `{entry['prefix']}{entry['value']}`"})
                return {"content": [{"type": "text", "text": self.state()}]}
        return {"content": [{"type": "text", "text": f"No row with id {args['id']!r}. " + self.state()}], "is_error": True}

    async def remove_filter(self, args: dict) -> dict:
        if self.mode == "Plan":
            return {"content": [{"type": "text", "text": "Plan mode: you can't change filters."}], "is_error": True}
        if not any(entry["id"] == args["id"] for entry in self.entries):
            return {"content": [{"type": "text", "text": f"No row with id {args['id']!r}. " + self.state()}], "is_error": True}
        for entry in self.entries:
            if entry["id"] == args["id"]:
                self.history.append({"role": "activity", "text": f"Removed filter `{entry['prefix']}{entry['value']}`"})
        self.entries = [entry for entry in self.entries if entry["id"] != args["id"]]
        return {"content": [{"type": "text", "text": self.state()}]}

    def summarize(self, items: list) -> list:
        in_session = [repo["full_name"] for repo in self.repos]
        repos = []
        for item in items:
            license = item["license"]["spdx_id"] if item["license"] else None
            repos.append(
                {
                    "name": item["full_name"],
                    "description": item["description"],
                    "stars": item["stargazers_count"],
                    "forks": item["forks_count"],
                    "open_issues": item["open_issues_count"],
                    "language": item["language"],
                    "topics": item["topics"],
                    "license": license,
                    "created_at": item["created_at"],
                    "pushed_at": item["pushed_at"],
                    "archived": item["archived"],
                    "fork": item["fork"],
                    "in_session": item["full_name"] in in_session,
                }
            )
        return repos

    async def show_search(self, args: dict) -> dict:
        if self.mode == "Plan" or self.mode == "Manual":
            return {"content": [{"type": "text", "text": f"{self.mode} mode: you can't search."}], "is_error": True}

        parts = []
        sort = None
        order = "desc"
        for entry in self.entries:
            value = entry["value"].strip()
            if value:
                parts.append(entry["prefix"] + value)
            if entry["prefix"] == "sort:" and value:
                sort = value.removesuffix("-asc")
                order = "asc" if value.endswith("-asc") else "desc"
        query = " ".join(parts)
        if not query:
            return {"content": [{"type": "text", "text": "The filters are empty. Add filter rows first."}], "is_error": True}

        try:
            result = await asyncio.to_thread(search_repositories, query, sort, order, 100, 1)
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error: {error.response.text}"}], "is_error": True}

        self.query = query
        self.result = result
        self.history.append({"role": "activity", "text": f"Searched your filters `{query}` → {result['total_count']:,} results"})
        for item in result["items"]:
            self.seen[item["full_name"]] = item
        summary = {"q": query, "total_count": result["total_count"], "repos": self.summarize(result["items"])}
        return {"content": [{"type": "text", "text": json.dumps(summary)}]}

    async def search(self, args: dict) -> dict:
        if self.mode == "Plan" or self.mode == "Manual":
            return {"content": [{"type": "text", "text": f"{self.mode} mode: you can't search."}], "is_error": True}

        sort = args.get("sort") or None
        order = "desc"
        if sort and sort.endswith("-asc"):
            sort = sort.removesuffix("-asc")
            order = "asc"

        try:
            result = await asyncio.to_thread(search_repositories, args["q"], sort, order, 100, args.get("page", 1))
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error: {error.response.text}"}], "is_error": True}

        self.history.append({"role": "activity", "text": f"Searched `{args['q']}` → {result['total_count']:,} results"})
        for item in result["items"]:
            self.seen[item["full_name"]] = item
        summary = {"q": args["q"], "total_count": result["total_count"], "repos": self.summarize(result["items"])}
        return {"content": [{"type": "text", "text": json.dumps(summary)}]}

    def prefetch(self, names: list) -> None:
        # Load what the preview page opens first, so the user's click is instant.
        # Runs in a background thread; a repo that fails is simply loaded on click.
        for name in names:
            try:
                owner = name.split("/")[0]
                repo = name.split("/")[1]
                info = get_repository(owner, repo)
                ref = info["default_branch"]
                get_branches(owner, repo)
                entries = get_contents(owner, repo, "", ref)
                readmes = [item for item in entries if item["type"] == "file" and item["name"].lower().startswith("readme")]
                readmes.sort(key=lambda item: item["name"].lower())
                if readmes:
                    get_contents_html(owner, repo, readmes[0]["path"], ref)
            except (httpx.HTTPError, IndexError, KeyError, TypeError):
                continue

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

    async def add_to_session(self, args: dict) -> dict:
        if self.mode == "Plan" or self.mode == "Manual":
            return {"content": [{"type": "text", "text": f"{self.mode} mode: you can't change the session list."}], "is_error": True}

        in_session = [repo["full_name"] for repo in self.repos]
        not_found = []
        added = []
        for name in args["names"]:
            if name in in_session:
                continue
            item = self.seen.get(name)
            if item is None and name.count("/") == 1:
                try:
                    item = await asyncio.to_thread(get_repository, name.split("/")[0], name.split("/")[1])
                except httpx.HTTPStatusError:
                    item = None
            if item is None:
                not_found.append(name)
                continue
            self.repos.append(item)
            in_session.append(name)
            added.append(name)

        if added:
            self.history.append({"role": "activity", "text": f"Added {len(added)} to session: {', '.join(added)}"})
            threading.Thread(target=self.prefetch, args=(added,), daemon=True).start()
        text = json.dumps({"session": self.summarize(self.repos), "not_found": not_found})
        return {"content": [{"type": "text", "text": text}]}

    async def remove_from_session(self, args: dict) -> dict:
        if self.mode == "Plan" or self.mode == "Manual":
            return {"content": [{"type": "text", "text": f"{self.mode} mode: you can't change the session list."}], "is_error": True}
        removed = [repo["full_name"] for repo in self.repos if repo["full_name"] in args["names"]]
        if removed:
            self.history.append({"role": "activity", "text": f"Removed {len(removed)} from session: {', '.join(removed)}"})
        self.repos = [repo for repo in self.repos if repo["full_name"] not in args["names"]]
        return {"content": [{"type": "text", "text": json.dumps({"session": self.summarize(self.repos)})}]}

    async def rank_session(self, args: dict) -> dict:
        if self.mode == "Plan" or self.mode == "Manual":
            return {"content": [{"type": "text", "text": f"{self.mode} mode: you can't change the session list."}], "is_error": True}
        ranked = []
        for name in args["names"]:
            for repo in self.repos:
                if repo["full_name"] == name and repo not in ranked:
                    ranked.append(repo)
        rest = [repo for repo in self.repos if repo not in ranked]
        self.repos = ranked + rest
        top = ", ".join(repo["full_name"] for repo in self.repos[:3])
        self.history.append({"role": "activity", "text": f"Ranked session, top: {top}"})
        return {"content": [{"type": "text", "text": json.dumps({"session": self.summarize(self.repos)})}]}

    async def get_session(self, args: dict) -> dict:
        return {"content": [{"type": "text", "text": json.dumps({"session": self.summarize(self.repos)})}]}

    async def start(self):
        await self.client.connect()

    async def stop(self):
        await self.client.disconnect()

    async def watch_interrupt(self):
        while True:
            await asyncio.sleep(0.1)
            if self.interrupt:
                self.interrupt = False
                await self.client.interrupt()

    async def run(self, prompt: str, mode: str) -> str:
        self.interrupt = False
        self.mode = mode
        self.result = None
        watcher = asyncio.create_task(self.watch_interrupt())
        await self.client.query(f"Mode: {mode}\nCurrent filters: {self.state()}\n\n{prompt}")

        reply = ""
        async for message in self.client.receive_response():
            if isinstance(message, ResultMessage):
                usage = message.usage or {}
                self.tokens += usage.get("input_tokens", 0)
                self.tokens += usage.get("cache_creation_input_tokens", 0)
                self.tokens += usage.get("cache_read_input_tokens", 0)
                self.tokens += usage.get("output_tokens", 0)
                self.cost += message.total_cost_usd or 0
                reply = message.result or ""
                self.session_id = message.session_id
            if not isinstance(message, AssistantMessage):
                continue
            for block in message.content:
                if isinstance(block, ThinkingBlock):
                    print(f"[thinking] {block.thinking}")
                if isinstance(block, ToolUseBlock):
                    print(f"[tool] {block.name} {block.input}")
                if isinstance(block, TextBlock):
                    print(block.text)

        watcher.cancel()
        self.history.append({"role": "assistant", "text": reply or "(stopped)"})
        return reply
