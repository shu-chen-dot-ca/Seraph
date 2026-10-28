"""Explore: find new repos while the user watches, for them to approve into the Repos list or remove.

The user starts a run on the Explore page and stops it when they like. It also ends by itself after
finding `count` repos or after `minutes`, whichever comes first (either may be left out), or when every
search is used up. Each repo that qualifies joins the found list the moment it is found, so the list fills
while the run goes on. The user decides on each one (or many at once): approve adds it to Repos, remove
takes it off the found list (nothing is blocked: a later run may find it again). What they haven't decided on
stays in the found list, also through later runs and backend restarts (DATA_DIR/explore_found.json), and later
runs don't find it again. Explore never changes a repo that is already listed.

Where it looks: the profile (DATA_DIR/explore_profile.json) is what the user writes, "about" (who they are,
what they like), and their types of repo, each a name and a few words on what it is (the default, the user's own
profile of 2026-10-27: Linux desktop, AI & harness, LLM tooling and Dev tools). The types are the tags that
classify repos: Explore puts each repo it finds under one, and agents give one to the repos they add (work_tools.py repos_add). In the code a type is a
lane: when the profile is saved, Claude plans each one's GitHub repo searches (set_profile), and the finds are split
evenly between them. The run keeps the lanes near their shares: the next candidate comes from the lane furthest below
its share. Every search gets SEARCH_SUFFIX (not archived, pushed in the last 30 days) and runs most recently updated
first, a page of 100 at a time: not most stars first, and no famous repos looked at first, so Explore doesn't start
from fame. The default star range is a few hundred to 15k.

What it skips before any heavy work: repos it already looked at in this run, repos in Repos or Tracked, and
repos already in the found list. Then `workers` candidates at a time (token_balancer.py paces GitHub for all of them):
1. its numbers (repo_signals.py: a few GitHub calls, no Claude yet);
2. skipped if it is archived or a fork, nothing was committed in 30 days, no outside contributor's PR was merged
   in 90 days, most outside PRs are closed unmerged (under MIN_MERGE_RATE), or newcomers' first PRs are turned away
   or left waiting (repo_signals.py's newcomers tag): a PR of yours would likely go nowhere there. A slow first reply
   alone (over a week) doesn't skip a repo;
3. at the same time, Claude reads its AI policy and its review atmosphere (repo_signals.complete), and its
   README against the profile (claude_judge.py): is it a project people contribute code to (not a link list,
   tutorial or course), which of the user's types it is, how well it fits (one of FIT_LEVELS, fixed so repos
   rank the same way every time; kept as its number), one line for its note;
4. found, with its type (its "lane"), fit, note and tags, and its signals kept for when it is approved. Its AI
   policy, newcomers, activity and atmosphere show as tags; they keep a repo out only when the run's filters say so.

Filters (FILTERS, picked on the page for each run) are every tag a repo can get, the same as the Repos and Tracked
pages: its fit, AI policy, newcomers, review tone, first reply speed, trend, and the other ones (free beginner issues,
one maintainer or none, 5 or more unanswered PRs). A key is "section:value", a section being one row of the page's
Filters pop-up. Each picked one is "include" or "exclude". In a section with included tags, a repo needs one of them
(the rest of the section is skipped); in a section with none, anything is fine. An excluded tag always skips a repo.
The numbers' sections are checked in step 2. The AI policy and the reviews need Claude: when one of their tags is
picked (CLAUDE_SECTIONS), they are read before the README, and only a repo that passes gets its README judged (most
repos don't, and the README judgment is the costly part). The fit is known only after the README judgment.

    found = [{"name", "lane", "description", "stars", "default_branch", "html_url", "fit", "note",
              "ai_policy", "newcomers", "tone", "atmosphere", "prs_month", "issues_month", "commits_month",
              "trend", "found_at", "signals"}, ...]     newest last; summary() leaves "signals" out and adds
                                                         a few of its numbers: merged, newcomer_stats, reply,
                                                         window_days, maintainers, unanswered

One run at a time. It lives in memory: the counts, the ones being checked now, why others were skipped and
the errors. The live feed's explore topic carries it with the found list and the profile. version goes up on every
change, so the page follows along.

A run goes on through a reload (the backend restarts whenever the code changes): at shutdown save_for_restart() keeps
it in DATA_DIR/explore_run.json, with where its searches are and what it looked at (the checks in progress go back to
be checked again), and at start resume() goes on with it. Only when the same `uv run serve` started both (SERVE_ID):
when the user closed the backend, the run shows as stopped ("The backend was closed"). What it
found always stays. The minutes limit counts from when the run started, so the time a reload takes counts too.

When the network is gone (GitHub unreachable: UNREACHABLE), nothing is lost: a search is sent again, and a repo goes
back to be checked again, every NETWORK_PAUSE seconds until the network is back. A request cut off after it reached
GitHub (other httpx.TransportError, like a read timeout) is tried again the same way up to NETWORK_TRIES times in all,
then counts as an error (the page's Skipped line; the errors are kept in the run but not shown). Everything here runs on the backend's event loop, so the found list needs no lock.
"""

import asyncio
import copy
import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from dotenv import load_dotenv

from github_searcher.claude_judge import JudgeError, judge
from github_searcher.search import get_readme, get_repository, search_repositories

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# The default profile, its types' searches written by hand so the first run needs no planning.
# Who started this backend: with reload, the `uv run serve` process that watches the code (backend/serve.py). It stays
# through every reload and is new each time the user starts the backend, so its pid and start time (a pid can be used
# again later) tell a reload from the user closing the backend. The start time is field 22 of /proc/<pid>/stat.
SERVE_STAT = Path(f"/proc/{os.getppid()}/stat").read_text()
SERVE_ID = f"{os.getppid()}:{SERVE_STAT.rsplit(')', 1)[1].split()[19]}"
DEFAULT_PROFILE = {
    "about": "",
    "lanes": [
        {
            "id": "linux-desktop",
            "label": "Linux desktop",
            "about": (
                "Linux desktop apps and system tools: GNOME and KDE apps, Fedora tooling, Flatpak apps, system utilities. Rust,"
                " Python or C++, where a fix can be seen and checked on a desktop."
            ),
            "share": 25,
            "queries": [
                "topic:gtk4 stars:300..15000",
                "topic:gnome stars:300..15000 good-first-issues:>0",
                "topic:libadwaita stars:300..15000",
                "topic:kde stars:300..15000",
                "topic:flatpak stars:300..15000",
                "topic:linux-desktop stars:300..15000",
                "topic:wayland language:Rust stars:300..15000",
                "topic:fedora stars:300..15000",
            ],
        },
        {
            "id": "ai",
            "label": "AI & harness",
            "about": (
                "Agent frameworks and harnesses, MCP servers and SDKs, guardrails, evals, human-in-the-loop and review tools. "
                "Python or TypeScript, runs locally without paid API keys (or with mocks), and a fix shows in a command's "
                "output, a UI or a test."
            ),
            "share": 25,
            "queries": [
                "topic:mcp stars:300..15000",
                "topic:model-context-protocol stars:300..15000",
                "topic:mcp-server stars:300..15000 good-first-issues:>0",
                "topic:ai-agents stars:300..15000 good-first-issues:>2",
                "topic:agent-framework stars:300..15000",
                "topic:guardrails stars:300..15000",
                "topic:llm-evaluation stars:300..15000",
                "topic:human-in-the-loop stars:300..15000",
            ],
        },
        {
            "id": "llm-tooling",
            "label": "LLM tooling",
            "about": (
                "Applied AI and LLM tooling: LLM clients and SDKs, local model front ends, chat UIs, prompt and "
                "structured-output tools, CLIs around LLMs. Python or TypeScript, runs without a GPU or paid API (mockable), "
                "and a fix shows in a UI, a command's output or a test."
            ),
            "share": 25,
            "queries": [
                "topic:llm language:Python stars:300..15000 good-first-issues:>2",
                "topic:llm language:TypeScript stars:300..15000 good-first-issues:>2",
                "topic:chatgpt stars:300..15000 help-wanted-issues:>2",
                "topic:structured-output stars:300..15000",
                "topic:llm-cli stars:300..15000",
                "topic:openai language:TypeScript stars:300..15000",
                "topic:ollama stars:300..15000",
                "topic:prompt-engineering stars:300..15000 language:Python",
            ],
        },
        {
            "id": "dev-tools",
            "label": "Dev tools",
            "about": (
                "Well-known developer tools: CLIs, linters, formatters, test runners, build tools, terminal apps and editor "
                "extensions, in Python, TypeScript or Rust. Bugs are easy to reproduce from a terminal."
            ),
            "share": 25,
            "queries": [
                "topic:cli language:Rust stars:300..15000 good-first-issues:>2",
                "topic:cli language:Python stars:300..15000 good-first-issues:>2",
                "topic:linter stars:300..15000",
                "topic:formatter stars:300..15000",
                "topic:terminal language:Rust stars:300..15000",
                "topic:developer-tools language:TypeScript stars:300..15000 good-first-issues:>0",
                "topic:vscode-extension stars:300..15000 help-wanted-issues:>0",
                "topic:testing language:Python stars:300..15000 good-first-issues:>0",
            ],
        },
    ],
}
SEARCH_SUFFIX = "archived:false pushed:>{since}"
# GitHub gives at most 10 pages of 100 for one search.
MAX_PAGES = 10
MAX_WORKERS = 16
README_CHARS = 4000
ERRORS_KEPT = 20
# The network gone ("Network is unreachable", can't connect): a search or a repo is tried again after a pause, until
# the network is back. A request cut off after it reached GitHub (a timeout while reading) is tried again up to
# NETWORK_TRIES times in all, since it may be the repo's own (one too big to answer in time).
NETWORK_TRIES = 5
NETWORK_PAUSE = 30
UNREACHABLE = (httpx.ConnectError, httpx.ConnectTimeout)
# How well a repo fits the profile: Claude picks a level, and the repo keeps its number (the Repos page shows the
# level again: the frontend's FIT_LEVELS has the same steps).
FIT_LEVELS = {"strong": 1.0, "good": 0.75, "some": 0.5, "weak": 0.25}
MAX_TYPES = 6
# Outside PRs merged, of those merged or closed: under this, most are closed unmerged and Explore skips the repo.
MIN_MERGE_RATE = 0.3
# The tags a run can filter on, "section:value", each with its label on the page (also why a repo is skipped on the
# page's Skipped line). The same thresholds as the tags' colors on the page: replies in 2 days are green, over a week
# amber; one maintainer or none is amber, and so are 5 unanswered PRs or more.
FILTERS = {
    "fit:strong": "Strong fit",
    "fit:good": "Good fit",
    "fit:some": "Some fit",
    "fit:weak": "Weak fit",
    "policy:welcome": "AI welcome",
    "policy:disclose": "AI: disclose",
    "policy:no_ai": "No AI",
    "policy:unclear": "AI: unclear",
    "policy:none": "No AI policy",
    "newcomers:welcomes": "Welcomes newcomers",
    "newcomers:ok": "Newcomers OK",
    "newcomers:few": "Few newcomers",
    "tone:warm": "Warm reviews",
    "tone:neutral": "Neutral reviews",
    "tone:strict": "Strict reviews",
    "tone:curt": "Curt reviews",
    "tone:unknown": "Little review feedback",
    "reply:fast": "Replies in 2 days",
    "reply:week": "Replies in a week",
    "reply:slow": "Replies over a week",
    "trend:up": "↑ Busier",
    "trend:flat": "Steady",
    "trend:down": "↓ Quieter",
    "other:beginner_issues": "Free beginner issues",
    "other:one_maintainer": "1 maintainer",
    "other:unanswered": "5+ unanswered PRs",
}
# The sections that need Claude's reading of the AI policy or the reviews.
CLAUDE_SECTIONS = ["policy", "tone"]
# What Claude answers when it plans the searches of the profile's types: each type by its name.
PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "types": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["name", "queries"],
            },
        },
    },
    "required": ["types"],
}


class Explore:
    def __init__(self, repos, tracked, repo_signals):
        self.repos = repos
        self.tracked = tracked
        self.repo_signals = repo_signals
        self.path = DATA_DIR / "explore_profile.json"
        self.version = 0
        self.profile = copy.deepcopy(DEFAULT_PROFILE)
        if self.path.exists():
            self.profile = json.loads(self.path.read_text())
        # A profile saved before "about": its interests become it.
        if "about" not in self.profile:
            self.profile = {"about": self.profile.get("interests", ""), "lanes": self.profile["lanes"]}
        # The run's own copy, so changing the profile meanwhile doesn't change a run in progress.
        self.run_profile = copy.deepcopy(self.profile)
        # The current or last run (None before the first), what the page shows.
        self.run = None
        self.task = None
        self.stopping = False
        # Per lane: the candidates found by its searches and not looked at yet, and where its searches are.
        self.cursors = {}
        # Every repo the run looked at, lower case, so one found by two searches is checked once.
        self.seen = set()
        # How many times the network failed while checking a repo, by name.
        self.network_tries = {}
        # A running run, kept here at shutdown so the next start goes on with it (save_for_restart, resume).
        self.run_path = DATA_DIR / "explore_run.json"
        # Found repos waiting for the user's decision, kept across runs and restarts.
        self.found_path = DATA_DIR / "explore_found.json"
        self.found = []
        if self.found_path.exists():
            self.found = json.loads(self.found_path.read_text())

    def changed(self) -> None:
        self.version += 1

    def summary(self) -> dict:
        # The found list without each repo's signals: those are only for approving, and big. A few numbers from them
        # stay: outside PRs merged, how newcomers' first PRs went (their newcomers part, small: counts and merge rate),
        # how fast a maintainer first replies, how many days its 100 newest PRs cover (newcomer_stats' prs are the new
        # contributors in those days), who merged PRs, and outside PRs nobody answered (None when not counted yet).
        found = []
        for entry in self.found:
            shown = {key: value for key, value in entry.items() if key != "signals"}
            signals = entry.get("signals") or {}
            shown["merged"] = signals.get("outside_merge_rate")
            shown["newcomer_stats"] = signals.get("newcomers")
            shown["reply"] = signals.get("median_days_to_first_reply")
            shown["window_days"] = signals.get("pr_window_days")
            shown["maintainers"] = signals.get("active_mergers_30d")
            shown["unanswered"] = signals.get("stale_outside_prs")
            found.append(shown)
        return {"profile": copy.deepcopy(self.profile), "run": copy.deepcopy(self.run), "found": copy.deepcopy(found)}

    def save_found(self) -> None:
        self.found_path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.found_path.with_name(self.found_path.name + ".tmp")
        temporary.write_text(json.dumps(self.found))
        temporary.replace(self.found_path)
        self.changed()

    async def approve(self, names: list[str]) -> list[str]:
        """Move found repos into the Repos list, as one undo step, with their signals. Returns the names added
        (a repo an agent added to Repos meanwhile just leaves the found list)."""
        chosen = [entry for entry in self.found if entry["name"] in names]
        if not chosen:
            return []
        self.found = [entry for entry in self.found if entry["name"] not in names]
        self.save_found()
        items = []
        for entry in chosen:
            items.append(
                {
                    "full_name": entry["name"],
                    "description": entry["description"],
                    "stars": entry["stars"],
                    "default_branch": entry["default_branch"],
                    "html_url": entry["html_url"],
                    "note": entry["note"],
                    "added_by": "explore",
                    "added_at": datetime.now(UTC).isoformat(),
                    "lane": entry["lane"],
                    "fit": entry["fit"],
                }
            )
        added = await asyncio.to_thread(self.repos.add, items)
        for entry in chosen:
            if entry["name"] in added:
                await asyncio.to_thread(self.repo_signals.put, entry["name"], entry["signals"])
        return added

    def remove(self, names: list[str]) -> list[str]:
        """Take repos off the found list (a later run may find them again). Returns the names that were in the list."""
        removed = [entry["name"] for entry in self.found if entry["name"] in names]
        if not removed:
            return []
        self.found = [entry for entry in self.found if entry["name"] not in names]
        self.save_found()
        return removed

    async def set_profile(self, about: str, types: list[dict]) -> None:
        """Replace the profile: about, and the types ({"label", "about"} each). Claude plans each type's
        searches first, so this takes a little while. ValueError when something is missing or Claude gives no
        usable plan; the run in progress keeps the old profile."""
        about = about.strip()
        if about == "":
            raise ValueError("Write something about you.")
        if not types or len(types) > MAX_TYPES:
            raise ValueError(f"Have 1 to {MAX_TYPES} types of repo.")
        lanes = []
        for each in types:
            label = each["label"].strip()
            if label == "" or each["about"].strip() == "":
                raise ValueError("Each type needs a name and a few words on what it is.")
            if label.lower() in [lane["label"].lower() for lane in lanes]:
                raise ValueError(f"There are two types named {label}.")
            # A type that keeps its name keeps its id, so the repos tagged with it keep their tag.
            lane_id = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "type"
            for old_lane in self.profile["lanes"]:
                if old_lane["label"].lower() == label.lower():
                    lane_id = old_lane["id"]
            while lane_id in [lane["id"] for lane in lanes]:
                lane_id += "-2"
            lanes.append({"id": lane_id, "label": label, "about": each["about"].strip(), "share": 0, "queries": []})
        # An even split; the first types get what doesn't divide.
        for index, lane in enumerate(lanes):
            lane["share"] = 100 // len(lanes) + (1 if index < 100 % len(lanes) else 0)

        type_lines = "\n".join(f"- {lane['label']}: {lane['about']}" for lane in lanes)
        prompt = (
            "A developer looks for open-source projects to contribute to. Plan the GitHub searches that find them.\n\n"
            f"About them:\n{about}\n\n"
            f"The types of project they want, by name:\n{type_lines}\n\n"
            "For each type, by its name:\n"
            "- queries: 3 to 8 GitHub repository searches (the q of GET /search/repositories), most promising first, "
            'like "topic:mcp stars:300..15000" or "stars:300..15000 good-first-issues:>2 language:Python". Use '
            "qualifiers (topic:, language:, stars:, good-first-issues:, help-wanted-issues:, in:description); more than "
            "a few words of plain text finds little. Each returns up to 1000 repos, most recently updated first. Keep "
            "to the star range they give; with none, a few hundred to 15k stars: mid-size projects where an outside "
            'PR gets noticed, not the famous ones. "archived:false pushed:>(30 days ago)" is added to each, so leave '
            "those out."
        )
        try:
            plan = await judge(prompt, PLAN_SCHEMA, "medium")
        except JudgeError as error:
            raise ValueError(f"Claude could not plan the searches: {error}")
        for planned in plan["types"]:
            for lane in lanes:
                if lane["label"].lower() == planned["name"].strip().lower():
                    lane["queries"] = [query.strip() for query in planned["queries"] if query.strip() != ""][:8]
        if all(not lane["queries"] for lane in lanes):
            raise ValueError("Claude's plan has nothing to search. Say a bit more about each type.")
        self.profile = {"about": about, "lanes": lanes}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.profile, indent=2))
        temporary.replace(self.path)
        self.changed()

    def start(self, count: int | None, minutes: int | None, workers: int, filters: dict[str, str]) -> None:
        """Start a run on the running event loop. ValueError when one is running or the limits are off."""
        if self.run is not None and self.run["status"] == "running":
            raise ValueError("Explore is already running")
        if count is not None and (count < 1 or count > 999):
            raise ValueError("Find 1 to 999 repos")
        if minutes is not None and (minutes < 1 or minutes > 600):
            raise ValueError("Run 1 to 600 minutes")
        if workers < 1 or workers > MAX_WORKERS:
            raise ValueError(f"1 to {MAX_WORKERS} workers")
        for each in filters:
            if each not in FILTERS:
                raise ValueError(f"Unknown filter: {each}")
            if filters[each] not in ["include", "exclude"]:
                raise ValueError(f"A filter is include or exclude, not {filters[each]}")

        lanes = {}
        self.cursors = {}
        self.run_profile = copy.deepcopy(self.profile)
        for lane in self.run_profile["lanes"]:
            lanes[lane["id"]] = {"label": lane["label"], "share": lane["share"], "found": 0, "in_flight": 0, "exhausted": lane["share"] == 0}
            self.cursors[lane["id"]] = {"pending": [], "query": 0, "page": 1}
        self.seen = set()
        self.network_tries = {}
        self.stopping = False
        self.run = {
            "status": "running",
            "started_at": datetime.now(UTC).isoformat(),
            "ended_at": None,
            "end_reason": "",
            "count": count,
            "minutes": minutes,
            "workers": workers,
            "filters": filters,
            "found": 0,
            "looked_at": 0,
            "lanes": lanes,
            "checking": [],
            "skipped": {},
            "errors": [],
        }
        self.changed()
        self.task = asyncio.create_task(self.work())

    def stop(self) -> None:
        """Stop the run: nothing new starts, and the checks in progress are dropped within a second."""
        if self.run is None or self.run["status"] != "running":
            return
        self.stopping = True

    def save_for_restart(self) -> None:
        """At shutdown: keep a running run in DATA_DIR/explore_run.json for resume(), then end it here."""
        if self.run is None or self.run["status"] != "running":
            return
        run = copy.deepcopy(self.run)
        cursors = copy.deepcopy(self.cursors)
        seen = set(self.seen)
        # The checks in progress are dropped: back to the front of their lane, to be checked again.
        for each in run["checking"]:
            cursors[each["lane"]]["pending"].insert(0, {"name": each["name"]})
            seen.discard(each["name"].lower())
            run["looked_at"] -= 1
            run["lanes"][each["lane"]]["exhausted"] = False
        run["checking"] = []
        for state in run["lanes"].values():
            state["in_flight"] = 0
        saved = {
            "serve_id": SERVE_ID,
            "saved_at": datetime.now(UTC).isoformat(),
            "run": run,
            "run_profile": self.run_profile,
            "cursors": cursors,
            "seen": sorted(seen),
        }
        self.run_path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.run_path.with_name(self.run_path.name + ".tmp")
        temporary.write_text(json.dumps(saved))
        temporary.replace(self.run_path)
        # Its checks stop now, so none finishes after it was saved.
        self.task.cancel()

    def resume(self) -> None:
        """At start, on the event loop: go on with the run save_for_restart() kept, when only the code reloaded (the
        same SERVE_ID). After the user closed the backend it only shows, as stopped."""
        if not self.run_path.exists():
            return
        saved = json.loads(self.run_path.read_text())
        self.run_path.unlink()
        self.run = saved["run"]
        if saved["serve_id"] != SERVE_ID:
            self.run["status"] = "stopped"
            self.run["end_reason"] = "The backend was closed"
            self.run["ended_at"] = saved["saved_at"]
            self.changed()
            return
        self.run_profile = saved["run_profile"]
        self.cursors = saved["cursors"]
        self.seen = set(saved["seen"])
        self.stopping = False
        self.changed()
        self.task = asyncio.create_task(self.work())

    async def work(self) -> None:
        run = self.run
        tasks = {}
        # From when the run started, so a run that went on after a reload keeps its end.
        deadline = None
        if run["minutes"] is not None:
            deadline = datetime.fromisoformat(run["started_at"]) + timedelta(minutes=run["minutes"])
        try:
            while True:
                if self.stopping:
                    run["end_reason"] = "Stopped"
                    break
                if deadline is not None and datetime.now(UTC) > deadline:
                    run["end_reason"] = f"{run['minutes']} minutes are up"
                    break
                if run["count"] is not None and run["found"] >= run["count"]:
                    run["end_reason"] = f"Found {run['count']}"
                    break

                # Keep `workers` checks going. The next candidate comes from the lane furthest below its share.
                while len(tasks) < run["workers"] and not self.stopping:
                    if run["count"] is not None and run["found"] >= run["count"]:
                        break
                    lane_id = None
                    lowest = None
                    for each, state in run["lanes"].items():
                        if state["exhausted"]:
                            continue
                        ratio = (state["found"] + state["in_flight"]) / state["share"]
                        if lowest is None or ratio < lowest:
                            lane_id = each
                            lowest = ratio
                    if lane_id is None:
                        break
                    name = await self.next_candidate(lane_id)
                    if name is None:
                        run["lanes"][lane_id]["exhausted"] = True
                        self.changed()
                        continue
                    run["lanes"][lane_id]["in_flight"] += 1
                    tasks[asyncio.create_task(self.check(lane_id, name))] = lane_id

                if not tasks:
                    if all(state["exhausted"] for state in run["lanes"].values()):
                        run["end_reason"] = "Every search is used up"
                        break
                    await asyncio.sleep(1)
                    continue
                done, _ = await asyncio.wait(list(tasks), timeout=1, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    run["lanes"][tasks.pop(task)]["in_flight"] -= 1
            run["status"] = "stopped" if self.stopping else "done"
        except Exception as error:
            run["status"] = "failed"
            run["end_reason"] = f"Failed: {error}"
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for state in run["lanes"].values():
                state["in_flight"] = 0
            run["checking"] = []
            run["ended_at"] = datetime.now(UTC).isoformat()
            if run["status"] == "running":
                # Cancelled from outside (the backend shutting down).
                run["status"] = "stopped"
                run["end_reason"] = "The backend stopped"
            self.changed()

    async def next_candidate(self, lane_id: str) -> str | None:
        """The next repo of a lane worth checking, or None when its searches are used up."""
        run = self.run
        cursor = self.cursors[lane_id]
        lane = [each for each in self.run_profile["lanes"] if each["id"] == lane_id][0]
        network_tries = 0
        while True:
            if cursor["pending"]:
                candidate = cursor["pending"].pop(0)
                name = candidate["name"]
                if name.lower() in self.seen:
                    continue
                self.seen.add(name.lower())
                run["looked_at"] += 1
                reason = ""
                if candidate.get("archived"):
                    reason = "Archived"
                elif candidate.get("fork"):
                    reason = "A fork"
                elif name.lower() in [item["full_name"].lower() for item in self.repos.items()]:
                    reason = "Already in Repos"
                elif name.lower() in [item["full_name"].lower() for item in self.tracked.items()]:
                    reason = "Tracked"
                elif name.lower() in [entry["name"].lower() for entry in self.found]:
                    reason = "Found before, waiting for you"
                if reason:
                    run["skipped"][reason] = run["skipped"].get(reason, 0) + 1
                    self.changed()
                    continue
                return name

            queries = lane.get("queries", [])
            if cursor["query"] >= len(queries):
                return None
            since = (datetime.now(UTC) - timedelta(days=30)).strftime("%Y-%m-%d")
            q = f"{queries[cursor['query']]} {SEARCH_SUFFIX.format(since=since)}"
            try:
                result = await asyncio.to_thread(search_repositories, q, cursor["page"])
            except Exception as error:
                # The network gone: the same search again after a pause (a second at a time, so a stop isn't kept
                # waiting).
                network_tries += 1
                if isinstance(error, UNREACHABLE) or (isinstance(error, httpx.TransportError) and network_tries < NETWORK_TRIES):
                    for _ in range(NETWORK_PAUSE):
                        if self.stopping:
                            return None
                        await asyncio.sleep(1)
                    continue
                network_tries = 0
                # A bad search (a typo in the profile) or GitHub failing: on to the next search.
                run["errors"] = (run["errors"] + [{"name": f"search: {q}", "error": str(error)[:300], "at": datetime.now(UTC).isoformat()}])[-ERRORS_KEPT:]
                cursor["query"] += 1
                cursor["page"] = 1
                self.changed()
                continue
            network_tries = 0
            for item in result["items"]:
                cursor["pending"].append({"name": item["full_name"], "archived": item["archived"], "fork": item["fork"]})
            if len(result["items"]) < 100 or cursor["page"] >= MAX_PAGES:
                cursor["query"] += 1
                cursor["page"] = 1
            else:
                cursor["page"] += 1

    async def check(self, lane_id: str, name: str) -> None:
        """Look at one candidate closely and put it in the found list when it qualifies."""
        run = self.run
        profile = self.run_profile
        lane = [each for each in profile["lanes"] if each["id"] == lane_id][0]
        run["checking"].append({"name": name, "lane": lane_id, "since": datetime.now(UTC).isoformat()})
        self.changed()
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        try:
            signals = await self.repo_signals.fetch(name, judged=False)
            filters = run["filters"]
            reply = signals["median_days_to_first_reply"]
            reason = ""
            if signals["archived"]:
                reason = "Archived"
            elif signals["fork"]:
                reason = "A fork"
            elif signals["commits_30d"] == 0:
                reason = "No commits in 30 days"
            elif signals["outside_merged_90d"] == 0:
                reason = "No outside PR merged in 90 days"
            elif signals["outside_merge_rate"] is not None and signals["outside_merge_rate"] < MIN_MERGE_RATE:
                reason = "Most outside PRs closed unmerged"
            elif signals["newcomers"]["tag"] == "turned_away":
                reason = "Turns newcomers away"
            elif signals["newcomers"]["tag"] == "left_waiting":
                reason = "Leaves newcomers waiting"

            # The repo's tags from its numbers.
            tags = ["newcomers:" + signals["newcomers"]["tag"], "trend:" + signals["activity"]["trend"]]
            if reply is not None and reply <= 2:
                tags.append("reply:fast")
            elif reply is not None and reply <= 7:
                tags.append("reply:week")
            elif reply is not None:
                tags.append("reply:slow")
            if signals["unclaimed_beginner_issues"] > 0:
                tags.append("other:beginner_issues")
            if signals["active_mergers_30d"] <= 1:
                tags.append("other:one_maintainer")
            if signals["stale_outside_prs"] >= 5:
                tags.append("other:unanswered")
            # In each section: one of its included tags, when it has any. Never an excluded tag.
            for section in ["newcomers", "trend", "reply", "other"]:
                wanted = [key for key in filters if filters[key] == "include" and key.split(":")[0] == section]
                if not reason and wanted and not any(key in tags for key in wanted):
                    reason = "Not " + " or ".join(FILTERS[key] for key in wanted)
            for key in tags:
                if not reason and filters.get(key) == "exclude":
                    reason = FILTERS[key]
            if reason:
                run["skipped"][reason] = run["skipped"].get(reason, 0) + 1
                return

            # The AI policy and the reviews first, when one of their tags is picked, so only a repo that passes gets its
            # README judged.
            judged = False
            if any(key.split(":")[0] in CLAUDE_SECTIONS for key in filters):
                signals = await self.repo_signals.complete(name, signals)
                judged = True
                tags = ["policy:" + signals["ai_policy"]["tag"]]
                if signals["atmosphere"]:
                    tags.append("tone:" + signals["atmosphere"]["tone"])
                for section in ["policy", "tone"]:
                    wanted = [key for key in filters if filters[key] == "include" and key.split(":")[0] == section]
                    if not reason and wanted and not any(key in tags for key in wanted):
                        reason = "Not " + " or ".join(FILTERS[key] for key in wanted)
                for key in tags:
                    if not reason and filters.get(key) == "exclude":
                        reason = FILTERS[key]
                if reason:
                    run["skipped"][reason] = run["skipped"].get(reason, 0) + 1
                    return

            try:
                readme = await asyncio.to_thread(get_readme, owner, repo)
            except httpx.HTTPStatusError as error:
                if error.response.status_code != 404:
                    raise
                readme = "(no README)"
            topics = ", ".join(signals["topics"]) or "none"
            type_lines = "\n".join(f"- {each['label']}: {each['about']}" for each in profile["lanes"])
            prompt = (
                "A developer is looking for open-source projects to contribute to. About them:\n"
                f"{profile['about']}\n\n"
                f"The types of project they want, by name:\n{type_lines}\n\n"
                f"This project came up in the searches for {lane['label']}.\n\n"
                f"Project: {name}, {signals['stars']} stars, language {signals['language'] or 'unknown'}, topics {topics}.\n"
                f"Description: {signals['description'] or 'none'}\n\n"
                f"README (the start of it):\n{readme[:README_CHARS]}\n\n"
                "is_project: true when people contribute code to it (a library, app, framework or tool); false for lists of "
                "links (awesome lists), tutorials, courses, books, interview prep, personal dotfiles or configs, and "
                "collections of data or prompts.\n"
                "type: the name of the type it is (the closest one, also when it came up in another type's searches).\n"
                "fit: how well it matches what they like and that type: strong (exactly what they want), good (clearly in "
                "their interests), some (related, but not what they're after), weak (hardly matches).\n"
                "note: one short line (at most 120 characters) for the developer: what the project is and why it fits or "
                "doesn't. Plain words, no hype."
            )
            schema = {
                "type": "object",
                "properties": {
                    "is_project": {"type": "boolean"},
                    "type": {"type": "string", "enum": [each["label"] for each in profile["lanes"]]},
                    "fit": {"type": "string", "enum": list(FIT_LEVELS)},
                    "note": {"type": "string"},
                },
                "required": ["is_project", "type", "fit", "note"],
            }
            # The fit, and the repo's AI policy and review atmosphere (unless a filter read them already), all at once.
            if judged:
                verdict = await judge(prompt, schema, "medium")
            else:
                verdict, signals = await asyncio.gather(judge(prompt, schema, "medium"), self.repo_signals.complete(name, signals))
            if not verdict["is_project"]:
                run["skipped"]["Not a code project"] = run["skipped"].get("Not a code project", 0) + 1
                return
            fit_tag = "fit:" + verdict["fit"]
            wanted = [key for key in filters if filters[key] == "include" and key.split(":")[0] == "fit"]
            if wanted and fit_tag not in wanted:
                reason = "Not " + " or ".join(FILTERS[key] for key in wanted)
            elif filters.get(fit_tag) == "exclude":
                reason = FILTERS[fit_tag]
            if reason:
                run["skipped"][reason] = run["skipped"].get(reason, 0) + 1
                return
            # Checks that finish after the run found enough are dropped, so it never finds more than asked.
            if self.stopping or (run["count"] is not None and run["found"] >= run["count"]):
                return

            info = await asyncio.to_thread(get_repository, owner, repo)
            fit = FIT_LEVELS[verdict["fit"]]
            # An agent may have added it to Repos meanwhile, or another search found it under its new name.
            if info["full_name"].lower() in [item["full_name"].lower() for item in self.repos.items()]:
                run["skipped"]["Already in Repos"] = run["skipped"].get("Already in Repos", 0) + 1
                return
            if info["full_name"].lower() in [entry["name"].lower() for entry in self.found]:
                run["skipped"]["Found before, waiting for you"] = run["skipped"].get("Found before, waiting for you", 0) + 1
                return
            # Tagged with, and counted for, the type Claude put it under.
            type_id = lane_id
            for each in profile["lanes"]:
                if each["label"] == verdict["type"]:
                    type_id = each["id"]
            run["found"] += 1
            run["lanes"][type_id]["found"] += 1
            self.found.append(
                {
                    "name": info["full_name"],
                    "lane": type_id,
                    "description": info["description"] or "",
                    "stars": info["stargazers_count"],
                    "default_branch": info["default_branch"],
                    "html_url": info["html_url"],
                    "fit": fit,
                    "ai_policy": signals["ai_policy"]["tag"],
                    "newcomers": signals["newcomers"]["tag"],
                    "tone": signals["atmosphere"]["tone"] if signals["atmosphere"] else None,
                    "atmosphere": signals["atmosphere"]["summary"] if signals["atmosphere"] else "",
                    "prs_month": signals["activity"]["prs_opened_month"],
                    "issues_month": signals["activity"]["issues_opened_month"],
                    "commits_month": signals["activity"]["commits_month"],
                    "trend": signals["activity"]["trend"],
                    "note": verdict["note"][:200],
                    "found_at": datetime.now(UTC).isoformat(),
                    "signals": signals,
                }
            )
            self.save_found()
        except asyncio.CancelledError:
            raise
        except httpx.TransportError as error:
            # The network gone: after a pause, back to the front of its lane to be checked again. The pause keeps this
            # worker waiting, so they don't run through the candidates while the network is down.
            self.network_tries[name] = self.network_tries.get(name, 0) + 1
            if isinstance(error, UNREACHABLE) or self.network_tries[name] < NETWORK_TRIES:
                await asyncio.sleep(NETWORK_PAUSE)
                self.cursors[lane_id]["pending"].insert(0, {"name": name})
                self.seen.discard(name.lower())
                run["looked_at"] -= 1
                run["lanes"][lane_id]["exhausted"] = False
            else:
                run["skipped"]["Error"] = run["skipped"].get("Error", 0) + 1
                run["errors"] = (run["errors"] + [{"name": name, "error": str(error)[:300], "at": datetime.now(UTC).isoformat()}])[-ERRORS_KEPT:]
        except Exception as error:
            run["skipped"]["Error"] = run["skipped"].get("Error", 0) + 1
            run["errors"] = (run["errors"] + [{"name": name, "error": str(error)[:300], "at": datetime.now(UTC).isoformat()}])[-ERRORS_KEPT:]
        finally:
            run["checking"] = [each for each in run["checking"] if each["name"] != name]
            self.changed()
