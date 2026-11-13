"""How each repo treats outside contributors and newcomers, how busy it is, how its reviews feel, and what it
says about AI: the numbers and tags behind the Repos page.

One JSON file, DATA_DIR/repo_signals.json, by repo (owner/name):

    {"owner/name": Signals, ...}

    Signals = {"fetched_at", "stars", "description", "topics", "language", "archived", "fork", "pushed_at",
               "pr_window_days",
               "outside_prs_90d", "outside_merged_90d", "outside_closed_90d", "outside_merge_rate",
               "median_days_to_first_reply", "median_days_to_merge", "average_days_to_merge_30d", "merge_authors_30d",
               "stale_outside_prs",
               "active_mergers_30d", "active_contributors", "contributors_total", "commits_30d",
               "commits_total", "open_prs_total", "merged_prs_total", "closed_prs_total", "open_issues_total",
               "beginner_issues": [{"number", "title", "created_at", "labels", "assignees", "cross_references"}, ...],
               "unclaimed_beginner_issues",
               "newcomers": {"prs", "merged", "closed", "merge_rate", "median_days_to_first_reply", "returned",
                             "authors_checked", "tag"},
               "activity": {"prs_opened_month", "prs_merged_month", "issues_opened_month", "issues_closed_month",
                            "commits_month", "prs_opened_30d", "prs_merged_30d", "issues_opened_30d",
                            "issues_closed_30d", "trend", "last_release", "last_release_at",
                            "issue_reply_rate", "issues_checked"},
               "community": {"contributing", "code_of_conduct", "discussions", "channels"},
               "readme_english": bool | None,
               "reviewers": {"agent", "both", "human", "tag"},
               "atmosphere": {"tone", "summary", "asks_for", "prs", "judged_at"} | None,
               "ai_policy": {"tag", "quote", "file", "basis", "version"},
               "newcomer_verdict": {"verdict", "reason", "version", "judged_at"} | None}

Outside contributors are PR authors who aren't owners, members or collaborators, and not bots, nor anyone who merged
one of its finished PRs (staff whose membership is private, whom GitHub shows as CONTRIBUTOR); staff's reviews and
comments count as a maintainer's.
- Of their PRs that ended in the last 90 days (among the repo's 100 most recently updated finished PRs, fewer
  for huge repos): outside_merge_rate is merged / (merged + closed without merging), None with fewer than
  MIN_SAMPLE of those; median_days_to_merge is from opening to merge. Finished PRs, not new ones: in a repo
  with 3,000 PRs a month the newest are mostly still open, which would make any rate look bad. A PR closed
  by a commit counts as merged: some projects (pytorch) land changes with a bot and then close the PR.
- Of their PRs opened in the last 90 days (among the repo's 100 newest PRs; pr_window_days says how many days
  those reach back when they cover less than 90): outside_prs_90d, and median_days_to_first_reply, until the
  first review or comment by a maintainer (a merge without one counts as the reply). Only maintainers count: a
  bot's review (an AI reviewer, a CLA check) or another outsider's comment isn't a reply.
- average_days_to_merge_30d: of every PR merged in the last 30 days (up to the 1,000 GitHub's search gives), the
  outside contributors' ones: each contributor's mean days from opening to merge, then the mean of those, so one
  person with many PRs counts once. A PR its own author merged doesn't count: whoever can merge is a maintainer.
  merge_authors_30d is how many contributors that is; the average is None when there are none. A failed read keeps
  the ones before.
- reviewers: who reviews those PRs. Each one that got a review or comment is counted once: agent (only from an AI
  reviewer, a bot like CodeRabbit or Copilot: AI_REVIEWERS), both (an AI reviewer and a maintainer), or human (only
  from maintainers). CI and other bots (tests, coverage, a CLA check) don't count either way, nor do PRs nobody
  reviewed. tag is the one most of them are ("agent", "both" or "human"; "both" on a tie), or "few" with fewer than
  MIN_SAMPLE reviewed PRs.
stale_outside_prs: their open PRs over 30 days old that no maintainer has answered (among the 100 oldest
open PRs). active_mergers_30d: how many people merged a PR in the last 30 days (bots not counted); the page calls
them its maintainers. active_contributors: how many people opened a PR in that window, anyone but bots.
contributors_total: everyone who ever contributed, the number on the repo's GitHub page (None when GitHub won't count
them: a repo with a huge history). commits_total: the commits on the default branch, in all. open_prs_total,
merged_prs_total, closed_prs_total (closed without a merge) and open_issues_total: GitHub's counts, in all.
beginner_issues: open issues under a good-first / beginner / easy / help-wanted label, newest first. Unclaimed
ones have no assignee and no cross reference (a PR or issue that mentions them).

newcomers: outside authors in that window who never opened a PR there before it (GitHub's own "first-time
contributor" mark changes once a PR is merged, so each author is looked up instead; the NEWCOMER_AUTHORS most
recent ones). Their first PRs: how many, merged, closed unmerged, the merge rate and the median days to a first
reply; returned is how many opened a second PR. Only first PRs that are merged, closed, or open longer than NEW_DAYS
days count: a PR opened a few days ago (over a holiday, say) may simply not have been looked at yet. tag:
    welcomes      most first PRs merged (MIN_SAMPLE or more finished) and a first reply within 3 days
    turned_away   most first PRs closed unmerged (a merge rate under 30%)
    left_waiting  most first PRs over LEFT_DAYS days old are still open: neither merged nor closed
    few           fewer than MIN_NEWCOMERS newcomers: too few to tell (neutral, not a bad sign)
    ok            anything else, also a slow first reply (over a week) when their PRs do get merged
Explore skips a repo that turns newcomers away or leaves them waiting.

activity: monthly averages over the last 90 days (GitHub's own counts), the last 30 days as they are, and trend
("up" / "down" / "flat") when those 30 days are a quarter above or below the average. issue_reply_rate: of
issues outsiders opened 7 to 90 days ago (of the 100 newest), the share a maintainer answered within a week.

community: a CONTRIBUTING file, a code of conduct, GitHub Discussions on, and chat links in the README.

readme_english: whether the README's main language is English: at most NON_LATIN_SHARE of its letters (code, links and
HTML left out) are outside the Latin script. An English README that links a Chinese translation, or has a short part in
Chinese, is; a Chinese one is not. None when the README couldn't be read. Explore keeps out a repo whose README isn't.

atmosphere: Claude (claude_judge.py) reads what maintainers wrote on recent finished outside PRs and names how
feedback feels: warm, neutral, strict or curt ("unknown" when there is too little to read), with one sentence and
what reviewers often ask for, from the fixed list ASKS (so repos compare and rank the same way every time). Read
again at most every ATMOSPHERE_DAYS days, or sooner when asks_for is from before ASKS. None until first judged.

ai_policy comes from the files where projects say it (POLICY_FILES), the organization's AI_POLICY.md (in its .github
repo, for all its repos) and the policy or guide pages the lines about AI link to (POLICY_LINKS). Code finds the lines
that mention AI (the files made for AI tools are read whole), and Claude reads them, with the atmosphere's summary of
how reviews of outside PRs go, and names the stance, the strictest rule deciding:
    welcome   AI-assisted contributions are fine, also when they say there is no need to say AI helped (bulwarkmail's
              guide: "You don't need to say that you did"; it was disclose before, and our PRs carried an AI line)
    disclose  allowed, under conditions an AI agent can meet (say so, the user reviews it, ...). A PR template's field
              or checkbox for the AI tools used is one; a line there addressed to AI agents that asks for something
              else isn't (kestra's "AI Authors" section only checks that the template was read)
    no_ai     not for us: AI-generated contributions are banned, or AI may only help a human author (it mustn't write
              most of the code or decide the PR's shape, PR descriptions, issues and comments must be written by a
              human, or agents mustn't open PRs, issues or comments on their own). Our agents write the code and the
              text, so we don't work there at all (backend/issues_api.py)
    unclear   AI is mentioned, but what's allowed isn't said; or its files welcome AI but its maintainers close outside
              PRs that look AI-made (hydro: AGENTS.md, yet #3295 was closed as "an autonomously generated PR")
    none      nothing about AI in those files (no Claude call)
basis is those lines and that summary, hashed: Claude is only asked again when they change, or when the policy is from
before POLICY_VERSION (backend/repos_api.py keep_signals reads every one but no_ai again once). A failed ask is
"unclear" with an empty basis, so the next fetch asks again.

newcomer_verdict: Claude decides whether the repo is open to newcomers ("welcome") or not ("closed"), from its stars
per all-time contributor (under about 100 usually open, over about 1000 usually closed), the start of its contributing
guide (CONTRIBUTING_CHARS) and of its PR template (PR_TEMPLATE_CHARS), how outside PRs and newcomers' first PRs went,
and the atmosphere's summary (maintainers may write that they stopped taking outside PRs): a rule against outside PRs
wins over the numbers, since it may be new. reason is one sentence on what decided it. Asked every time the numbers are
read, after the atmosphere. A failed ask keeps the one before (or None). version is NEWCOMER_VERSION when it was asked:
when it goes up, the backend asks again once for every welcome one (backend/repos_api.py).

fetch() gets the numbers from GitHub; complete() adds Claude's three judgments (policy, atmosphere and newcomer
verdict). fetch() does
both unless told not to: Explore checks the numbers first and only pays for the judgments of repos it keeps.

Kept apart from the Repos list on purpose, like issue_facts.py: the list's undo/redo should only undo what agents
and the user did. The backend fetches signals for new repos once and keeps them; one is read again only when the user
asks (Refresh on the Dashboard's Repository page, backend/repos_api.py).
version goes up by one on every change, like the other stores.
"""

import asyncio
import base64
import copy
import hashlib
import html
import json
import os
import re
import statistics
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from dotenv import load_dotenv

from github_searcher.claude_judge import judge
from github_searcher.search import (
    count_contributors,
    count_earlier_prs,
    get_contents,
    get_merged_prs_since,
    get_readme,
    get_repo_activity,
    get_repo_pulls,
    get_repo_signals,
    get_review_feedback,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# GitHub's author associations of people who aren't owners, members or collaborators, and of those who are.
OUTSIDE = ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]
MAINTAINERS = ["OWNER", "MEMBER", "COLLABORATOR"]
# Label names that mean "a newcomer can take this": "good first issue", "beginner-friendly", "Difficulty: Easy", "help wanted", ...
BEGINNER = re.compile(r"good.?first|first.?timer|beginner|easy|help.?wanted", re.IGNORECASE)
# "AI" only in capitals (not "said"), the rest in any case.
AI_WORDS = re.compile(r"\bAI\b|\bA\.I\.|(?i:\bllms?\b|chatgpt|copilot|\bgenai\b|generative|large language model|machine.generated|\bclaude\b|\bgemini\b|vibe.cod)")
# AI code reviewers' bot logins (GitHub apps): CodeRabbit, Copilot, Gemini Code Assist, Sourcery, Greptile, Cursor's
# Bugbot, Qodo, Ellipsis, Korbit, Bito, CodeAnt, Claude, Codex, Devin, Amazon Q, cubic, Entelligence, LlamaPReview.
AI_REVIEWERS = re.compile(
    r"coderabbit|copilot|gemini-code-assist|sourcery|greptile|^cursor|qodo|codium|ellipsis-dev|korbit|bito-code|codeant|^claude|codex|devin-ai|amazon-q|cubic-dev|entelligence|llamapreview",
    re.IGNORECASE,
)
# Chat links in a README, and what they are called.
CHANNELS = [
    ("Discord", re.compile(r"discord\.gg/|discord\.com/invite/", re.IGNORECASE)),
    ("Slack", re.compile(r"[a-z0-9-]+\.slack\.com|join\.slack\.com|slack\.[a-z0-9.-]+/", re.IGNORECASE)),
    ("Zulip", re.compile(r"zulipchat\.com", re.IGNORECASE)),
    ("Gitter", re.compile(r"gitter\.im/", re.IGNORECASE)),
    ("Matrix", re.compile(r"matrix\.to/", re.IGNORECASE)),
]
# The query's name for each file (search.py SIGNALS_QUERY), and its path.
POLICY_FILES = [
    ("aiPolicy", "AI_POLICY.md"),
    ("contributing", "CONTRIBUTING.md"),
    ("contributingRst", "CONTRIBUTING.rst"),
    ("githubContributing", ".github/CONTRIBUTING.md"),
    ("docsContributing", "docs/CONTRIBUTING.md"),
    ("prTemplate", ".github/PULL_REQUEST_TEMPLATE.md"),
    ("prTemplateLower", ".github/pull_request_template.md"),
    ("agentsFile", "AGENTS.md"),
    ("agentPolicy", "AGENT_POLICY.md"),
]
# The files read whole (their start, POLICY_FILE_CHARS): they exist for AI tools. Long enough for an update at the end
# (harper's AGENT_POLICY.md bans agent-written PR descriptions in its last lines) and a rule deep in a long policy
# (nextcloud's "No Autonomous Agent Submissions").
WHOLE_POLICY_FILES = ["aiPolicy", "agentsFile", "agentPolicy"]
POLICY_FILE_CHARS = 8000
# The policy pages the lines about AI link to (an https address on a line that says policy: clippy adopts "the same
# [LLM usage policy] as rust-lang/rust", which is on the web; or one that points to a guide or rules: bulwarkmail's "The
# guide's [AI-assisted contributions] section explains what we expect", where the page says "You don't need to say that
# you did"): at most POLICY_LINKS, each with at most PAGE_LINES of its lines about AI.
POLICY_LINKS = 3
PAGE_LINES = 20
CONTRIBUTING_FILES = ["contributing", "contributingRst", "githubContributing", "docsContributing"]
PR_TEMPLATE_FILES = ["prTemplate", "prTemplateLower"]
POLICY_TAGS = ["welcome", "disclose", "no_ai", "unclear"]
# Goes up when what the tags mean or what they are read from changes: a policy from before is asked again (2: AI only
# as a human's helper is no_ai. 3: AGENT_POLICY.md, the organization's AI_POLICY.md and the policy pages the lines about
# AI link to are read too; harper, nextcloud, rust-clippy. 4: a guide the lines about AI point to is read too, allowing AI
# with no need to say so is welcome, an AI section of the PR template that asks for no disclosure isn't disclose, and
# maintainers closing PRs that look AI-made make it unclear; bulwarkmail, kestra, hydro).
POLICY_VERSION = 4
TONES = ["warm", "neutral", "strict", "curt"]
# What reviewers ask contributors for, and what each means (for Claude; the frontend has labels for them).
ASKS = {
    "tests": "add or fix tests",
    "changelog": "a changelog or release-note entry",
    "docs": "update the docs",
    "issue_first": "open or discuss an issue before the PR",
    "small_prs": "smaller or split-up PRs",
    "cla": "sign a CLA or DCO",
    "rebase": "rebase, resolve conflicts or clean up commits",
    "style": "follow the code style or fix lint",
    "benchmarks": "benchmarks or performance numbers",
    "description": "a clearer PR description, or a filled-in PR template",
    "screenshots": "screenshots or a demo of the change",
    "design": "agree on the design or approach first",
}
# The start of the contributing guide that the newcomer verdict reads.
CONTRIBUTING_CHARS = 6000
# At most this many lines about AI from all files together, each cut at LINE_CHARS.
QUOTE_LINES = 25
LINE_CHARS = 300
# Goes up when what the newcomer verdict reads changes: a welcome verdict from before is asked again, once (2: the PR
# template and the reviews; DeepSeek-Reasonix's template closes outsiders' PRs).
NEWCOMER_VERSION = 2
# The start of the PR template the newcomer verdict reads.
PR_TEMPLATE_CHARS = 2000
# A rate from fewer finished PRs (or checked issues) than this says little.
MIN_SAMPLE = 3
# The share of a README's letters outside the Latin script over which its main language isn't English.
NON_LATIN_SHARE = 0.2
MIN_ISSUES = 5
MIN_NEWCOMERS = 3
# A newcomer's first PR still open after this many days counts as left waiting.
LEFT_DAYS = 30
# A newcomer's first PR counts once it is merged, closed, or open longer than this many days.
NEW_DAYS = 5
# Outside authors looked up to tell newcomers (one GitHub search each, all in one call).
NEWCOMER_AUTHORS = 30
BEGINNER_ISSUES_KEPT = 30
# The atmosphere: what maintainers wrote on this many recent outside PRs, each note cut at NOTE_CHARS,
# all at most FEEDBACK_CHARS; fewer than MIN_NOTES notes is too little to judge.
FEEDBACK_PRS = 15
NOTE_CHARS = 400
FEEDBACK_CHARS = 14000
MIN_NOTES = 4
ATMOSPHERE_DAYS = 7


class RepoSignals:
    def __init__(self):
        self.path = DATA_DIR / "repo_signals.json"
        self.lock = threading.Lock()
        self.version = 0
        self.signals = {}
        if self.path.exists():
            self.signals = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the signals to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.signals))
        temporary.replace(self.path)

    def all(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.signals)

    def get(self, name: str) -> dict | None:
        with self.lock:
            return copy.deepcopy(self.signals.get(name))

    def put(self, name: str, signals: dict) -> None:
        with self.lock:
            kept = copy.deepcopy(signals)
            # What complete() reads, in case it never ran: not worth keeping.
            for key in ["_policy_text", "_policy_files", "_policy_basis", "_feedback_text", "_feedback_notes", "_feedback_prs", "_contributing_text"]:
                kept.pop(key, None)
            self.signals[name] = kept
            self.save()

    def update(self, name: str, values: dict) -> None:
        """Add to a repo's kept signals (the totals, for ones read before they were counted). Nothing when it has none."""
        with self.lock:
            if name not in self.signals:
                return
            self.signals[name].update(values)
            self.save()

    async def refresh(self, name: str) -> dict:
        """fetch() with Claude's judgments, and keep the answer."""
        signals = await self.fetch(name)
        self.put(name, signals)
        return signals

    def forget(self, keep: list[str]) -> None:
        """Drop the signals of repos that are no longer in the list."""
        with self.lock:
            gone = [name for name in self.signals if name not in keep]
            if not gone:
                return
            for name in gone:
                del self.signals[name]
            self.save()

    async def fetch(self, name: str, judged: bool = True) -> dict:
        """Ask GitHub about one repo (owner/name) and work the signals out, without keeping them.

        judged=False leaves out Claude's judgments: ai_policy and atmosphere stay as they were (or None), and
        complete() adds them later. Raises httpx.HTTPError when GitHub fails, ValueError when it has no such repo.
        """
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        now = datetime.now(UTC)
        since = (now - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        since30 = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        since90 = (now - timedelta(days=90)).strftime("%Y-%m-%d")
        previous = self.get(name)

        # The atmosphere is read again only when it is a week old (or was never read).
        need_feedback = True
        if previous is not None and previous.get("atmosphere"):
            need_feedback = previous["atmosphere"]["judged_at"] < (now - timedelta(days=ATMOSPHERE_DAYS)).isoformat()
            # Read again when asks_for is free text, from before ASKS.
            for item in previous["atmosphere"]["asks_for"]:
                if item not in ASKS:
                    need_feedback = True

        # The repo and its PRs: two calls at the same time (one would take GitHub too long for a big repo).
        data, pulls = await asyncio.gather(asyncio.to_thread(get_repo_signals, owner, repo, since), asyncio.to_thread(get_repo_pulls, owner, repo))
        # GitHub's search only knows a repo by its current name; a renamed or moved repo is found by its old one only here.
        owner = data["nameWithOwner"].split("/")[0]
        repo = data["nameWithOwner"].split("/")[1]

        # How far back the newest PRs reach (100 of them, fewer for huge repos), at most 90 days.
        window_days = 90
        nodes = pulls["recent"]["nodes"]
        if len(nodes) == pulls["pageSize"]:
            oldest = datetime.fromisoformat(nodes[-1]["createdAt"])
            window_days = max(1, min(90, (now - oldest).days))
        window_start = now - timedelta(days=window_days)

        # Everyone (but bots) who opened a PR in that window.
        contributors = set()
        for pull in nodes:
            author = pull["author"]
            if author is None or author["__typename"] != "User" or author["login"].lower().endswith("bot"):
                continue
            if datetime.fromisoformat(pull["createdAt"]) >= window_start:
                contributors.add(author["login"])

        # The project's own people GitHub shows as outsiders: a private member is a CONTRIBUTOR, but merges PRs. Whoever
        # merged one of its finished PRs is staff, not an outsider (surveyjs: 47 of its 48 "outside" PRs were its staff's,
        # so 95% looked merged, and the one real outsider's, ours, #8169, was closed).
        staff = set()
        for pull in pulls["finished"]["nodes"]:
            if pull["mergedBy"] is not None:
                staff.add(pull["mergedBy"]["login"])

        # Outside contributors' PRs in that window, kept per PR for the newcomers below.
        window_prs = []
        replies = []
        for pull in nodes:
            author = pull["author"]
            if pull["authorAssociation"] not in OUTSIDE or author is None or author["__typename"] != "User":
                continue
            if author["login"].lower().endswith("bot") or author["login"] in staff:
                continue
            opened = datetime.fromisoformat(pull["createdAt"])
            if opened < window_start:
                continue
            # The first reply from a maintainer, a person: not a bot, not the author, not another outsider. And who
            # reviewed it: an AI reviewer (a bot), a maintainer, or both.
            first = None
            agent = False
            human = False
            for item in pull["reviews"]["nodes"] + pull["comments"]["nodes"]:
                other = item["author"]
                if other is None:
                    continue
                if other["__typename"] != "User" and AI_REVIEWERS.search(other["login"]):
                    agent = True
                    continue
                if other["__typename"] != "User":
                    continue
                if other["login"] == author["login"] or other["login"].lower().endswith("bot"):
                    continue
                if item["authorAssociation"] not in MAINTAINERS and other["login"] not in staff:
                    continue
                human = True
                at = datetime.fromisoformat(item["createdAt"])
                if first is None or at < first:
                    first = at
            # Closed by a commit: its change landed without GitHub's merge button.
            landed = pull["merged"]
            for event in pull["closing"]["nodes"]:
                if (event.get("closer") or {}).get("__typename") == "Commit":
                    landed = True
            closed = pull["state"] == "CLOSED" and not landed
            if landed:
                merged_at = datetime.fromisoformat(pull["mergedAt"] or pull["closedAt"])
                if first is None or merged_at < first:
                    first = merged_at
            reply = None
            if first is not None:
                reply = (first - opened).total_seconds() / 86400
                replies.append(reply)
            window_prs.append({"login": author["login"], "opened": opened, "merged": landed, "closed": closed, "reply": reply, "agent": agent, "human": human})

        # Who reviews them: only an AI reviewer, both, or only maintainers. PRs nobody reviewed don't count.
        agent_only = len([pull for pull in window_prs if pull["agent"] and not pull["human"]])
        both = len([pull for pull in window_prs if pull["agent"] and pull["human"]])
        human_only = len([pull for pull in window_prs if pull["human"] and not pull["agent"]])
        reviewer_tag = "few"
        if agent_only + both + human_only >= MIN_SAMPLE:
            reviewer_tag = "both"
            if agent_only > both and agent_only > human_only:
                reviewer_tag = "agent"
            elif human_only > both and human_only > agent_only:
                reviewer_tag = "human"

        # Outside contributors' PRs that ended in the last 90 days: merged or closed, and how long a merge took.
        merges = []
        merged_count = 0
        closed_count = 0
        mergers = set()
        for pull in pulls["finished"]["nodes"]:
            # Who merged anything (anyone's PR) in the last 30 days.
            if pull["merged"] and pull["mergedBy"] is not None and datetime.fromisoformat(pull["mergedAt"]) >= now - timedelta(days=30):
                login = pull["mergedBy"]["login"]
                if not login.lower().endswith("bot") and not login.endswith("[bot]"):
                    mergers.add(login)
            author = pull["author"]
            if pull["authorAssociation"] not in OUTSIDE or author is None or author["__typename"] != "User":
                continue
            if author["login"].lower().endswith("bot") or author["login"] in staff or pull["closedAt"] is None:
                continue
            if datetime.fromisoformat(pull["closedAt"]) < now - timedelta(days=90):
                continue
            landed = pull["merged"]
            for event in pull["closing"]["nodes"]:
                if (event.get("closer") or {}).get("__typename") == "Commit":
                    landed = True
            if landed:
                merged_count += 1
                merged_at = datetime.fromisoformat(pull["mergedAt"] or pull["closedAt"])
                merges.append((merged_at - datetime.fromisoformat(pull["createdAt"])).total_seconds() / 86400)
            else:
                closed_count += 1
        merge_rate = None
        if merged_count + closed_count >= MIN_SAMPLE:
            merge_rate = round(merged_count / (merged_count + closed_count), 2)

        # Newcomers: outside authors in the window who never opened a PR there before it. Most recent authors first.
        logins = []
        for pull in window_prs:
            if pull["login"] not in logins:
                logins.append(pull["login"])
        logins = logins[:NEWCOMER_AUTHORS]

        # The calls that don't depend on each other, at the same time. The README and the feedback may fail alone.
        calls = [
            asyncio.to_thread(count_earlier_prs, owner, repo, logins, window_start.strftime("%Y-%m-%d")),
            asyncio.to_thread(get_repo_activity, owner, repo, since30, since90),
            asyncio.to_thread(get_readme, owner, repo),
            asyncio.to_thread(count_contributors, owner, repo),
            asyncio.to_thread(get_merged_prs_since, owner, repo, since30),
        ]
        if need_feedback:
            calls.append(asyncio.to_thread(get_review_feedback, owner, repo))
        results = await asyncio.gather(*calls, return_exceptions=True)
        if isinstance(results[0], Exception):
            raise results[0]
        if isinstance(results[1], Exception):
            raise results[1]
        earlier = results[0]
        activity_data = results[1]
        readme = results[2] if isinstance(results[2], str) else ""
        # The count may fail alone: then it isn't known, like for a huge repo.
        contributors_total = results[3] if not isinstance(results[3], Exception) else None
        merged_since = results[4] if not isinstance(results[4], Exception) else None
        feedback_data = None
        if need_feedback and not isinstance(results[5], Exception):
            feedback_data = results[5]

        # The average merge: each outside contributor's mean days to merge in the last 30 days, then the mean of those.
        author_days = {}
        for pull in merged_since or []:
            author = pull.get("author")
            if pull.get("authorAssociation") not in OUTSIDE or author is None or author["__typename"] != "User":
                continue
            if author["login"].lower().endswith("bot") or author["login"] in staff:
                continue
            # Merged by its own author: a maintainer's PR, whatever GitHub calls them.
            if pull["mergedBy"] is not None and pull["mergedBy"]["login"] == author["login"]:
                continue
            days = (datetime.fromisoformat(pull["mergedAt"]) - datetime.fromisoformat(pull["createdAt"])).total_seconds() / 86400
            author_days.setdefault(author["login"], []).append(days)
        author_means = [statistics.mean(days) for days in author_days.values()]
        average_merge = round(statistics.mean(author_means), 1) if author_means else None
        merge_authors = len(author_means)
        if merged_since is None and previous is not None:
            # The read failed: keep the ones before.
            average_merge = previous.get("average_days_to_merge_30d")
            merge_authors = previous.get("merge_authors_30d", 0)

        newcomer_logins = [login for login in logins if earlier.get(login) == 0]
        first_prs = []
        returned = 0
        for login in newcomer_logins:
            theirs = sorted([pull for pull in window_prs if pull["login"] == login], key=lambda pull: pull["opened"])
            first_pr = theirs[0]
            # Still open and opened in the last NEW_DAYS days: too new to count, nobody may have looked yet (a holiday).
            if not first_pr["merged"] and not first_pr["closed"] and first_pr["opened"] > now - timedelta(days=NEW_DAYS):
                continue
            first_prs.append(first_pr)
            if len(theirs) > 1:
                returned += 1
        newcomer_merged = len([pull for pull in first_prs if pull["merged"]])
        newcomer_closed = len([pull for pull in first_prs if pull["closed"]])
        newcomer_rate = None
        if newcomer_merged + newcomer_closed >= MIN_SAMPLE:
            newcomer_rate = round(newcomer_merged / (newcomer_merged + newcomer_closed), 2)
        newcomer_replies = [pull["reply"] for pull in first_prs if pull["reply"] is not None]
        newcomer_reply = round(statistics.median(newcomer_replies), 1) if newcomer_replies else None
        # Their first PRs old enough to have been decided on, and how many of those are still open.
        old_first = [pull for pull in first_prs if pull["opened"] < now - timedelta(days=LEFT_DAYS)]
        still_open = [pull for pull in old_first if not pull["merged"] and not pull["closed"]]
        newcomer_tag = "ok"
        if len(first_prs) < MIN_NEWCOMERS:
            newcomer_tag = "few"
        elif newcomer_rate is not None and newcomer_rate < 0.3:
            newcomer_tag = "turned_away"
        elif len(old_first) >= MIN_SAMPLE and len(still_open) * 2 > len(old_first):
            newcomer_tag = "left_waiting"
        elif newcomer_rate is not None and newcomer_rate >= 0.5 and newcomer_reply is not None and newcomer_reply <= 3:
            newcomer_tag = "welcomes"

        # Outside PRs over a month old that nobody else has answered.
        stale = 0
        for pull in data["oldestOpen"]["nodes"]:
            author = pull["author"]
            if pull["authorAssociation"] not in OUTSIDE or author is None or author["__typename"] != "User":
                continue
            if datetime.fromisoformat(pull["createdAt"]) > now - timedelta(days=30) or author["login"] in staff:
                continue
            replied = False
            for item in pull["reviews"]["nodes"] + pull["comments"]["nodes"]:
                other = item["author"]
                if other is None or other["__typename"] != "User":
                    continue
                if other["login"].lower().endswith("bot") or (item["authorAssociation"] not in MAINTAINERS and other["login"] not in staff):
                    continue
                if other["login"] != author["login"]:
                    replied = True
            if not replied:
                stale += 1

        commits = 0
        commits_total = 0
        target = (data["defaultBranchRef"] or {}).get("target") or {}
        if target.get("history"):
            commits = target["history"]["totalCount"]
        if target.get("allHistory"):
            commits_total = target["allHistory"]["totalCount"]

        # Each issue once, with every beginner-style label it has.
        found = {}
        for key in ["firstLabels", "beginnerLabels", "easyLabels", "helpLabels"]:
            for label in data[key]["nodes"]:
                if not BEGINNER.search(label["name"]):
                    continue
                for issue in label["issues"]["nodes"]:
                    entry = found.get(issue["number"])
                    if entry is None:
                        entry = {
                            "number": issue["number"],
                            "title": issue["title"],
                            "created_at": issue["createdAt"],
                            "labels": [],
                            "assignees": issue["assignees"]["totalCount"],
                            "cross_references": issue["timelineItems"]["totalCount"],
                        }
                        found[issue["number"]] = entry
                    if label["name"] not in entry["labels"]:
                        entry["labels"].append(label["name"])
        beginner = sorted(found.values(), key=lambda entry: entry["created_at"], reverse=True)
        unclaimed = [entry for entry in beginner if entry["assignees"] == 0 and entry["cross_references"] == 0]

        # Activity: GitHub's counts for 30 and 90 days, and whether maintainers answer new issues within a week.
        counts = {}
        for key in ["prs30", "prs90", "merged30", "merged90", "issues30", "issues90", "closed30", "closed90"]:
            counts[key] = activity_data[key]["issueCount"]
        repository = activity_data["repository"]
        commits90 = 0
        target90 = (repository["defaultBranchRef"] or {}).get("target") or {}
        if target90.get("history"):
            commits90 = target90["history"]["totalCount"]
        recent_30 = counts["prs30"] + counts["issues30"] + commits
        average_30 = (counts["prs90"] + counts["issues90"] + commits90) / 3
        trend = "flat"
        if average_30 > 0 and recent_30 > average_30 * 1.25:
            trend = "up"
        elif average_30 > 0 and recent_30 < average_30 * 0.75:
            trend = "down"
        issues_checked = 0
        issues_answered = 0
        for issue in repository["recentIssues"]["nodes"]:
            author = issue["author"]
            if issue["authorAssociation"] in MAINTAINERS or author is None or author["__typename"] != "User":
                continue
            opened = datetime.fromisoformat(issue["createdAt"])
            if opened > now - timedelta(days=7) or opened < now - timedelta(days=90):
                continue
            issues_checked += 1
            for comment in issue["comments"]["nodes"]:
                other = comment["author"]
                if other is None or other["__typename"] != "User" or other["login"] == author["login"]:
                    continue
                if comment["authorAssociation"] not in MAINTAINERS:
                    continue
                if datetime.fromisoformat(comment["createdAt"]) <= opened + timedelta(days=7):
                    issues_answered += 1
                    break
        release = repository["releases"]["nodes"][0] if repository["releases"]["nodes"] else None
        activity = {
            "prs_opened_month": round(counts["prs90"] / 3),
            "prs_merged_month": round(counts["merged90"] / 3),
            "issues_opened_month": round(counts["issues90"] / 3),
            "issues_closed_month": round(counts["closed90"] / 3),
            "commits_month": round(commits90 / 3),
            "prs_opened_30d": counts["prs30"],
            "prs_merged_30d": counts["merged30"],
            "issues_opened_30d": counts["issues30"],
            "issues_closed_30d": counts["closed30"],
            "trend": trend,
            "last_release": release["tagName"] if release else None,
            "last_release_at": release["createdAt"] if release else None,
            "issue_reply_rate": round(issues_answered / issues_checked, 2) if issues_checked >= MIN_ISSUES else None,
            "issues_checked": issues_checked,
        }

        channels = []
        for channel, pattern in CHANNELS:
            if pattern.search(readme):
                channels.append(channel)
        readme_english = None
        if isinstance(results[2], str):
            text = re.sub(r"```.*?```|`[^`]*`|https?://\S+|<[^>]+>", " ", readme, flags=re.S)
            letters = [char for char in text if char.isalpha()]
            other = [char for char in letters if ord(char) > 0x24F]
            readme_english = len(other) <= NON_LATIN_SHARE * len(letters)
        community = {
            "contributing": any(data[key] is not None for key in CONTRIBUTING_FILES),
            "code_of_conduct": repository["codeOfConduct"] is not None,
            "discussions": repository["hasDiscussionsEnabled"],
            "channels": channels,
        }

        # What maintainers wrote on recent finished outside PRs, for complete() to judge.
        feedback_lines = []
        notes_count = 0
        prs_used = 0
        if feedback_data is not None:
            for pull in feedback_data["pullRequests"]["nodes"]:
                author = pull["author"]
                if pull["authorAssociation"] not in OUTSIDE or author is None or author["__typename"] != "User":
                    continue
                if author["login"].lower().endswith("bot") or author["login"] in staff or prs_used >= FEEDBACK_PRS:
                    continue
                notes = []
                for comment in pull["comments"]["nodes"]:
                    other = comment["author"]
                    if other is None or other["__typename"] != "User" or other["login"] == author["login"]:
                        continue
                    if (comment["authorAssociation"] in MAINTAINERS or other["login"] in staff) and comment["body"].strip():
                        notes.append(" ".join(comment["body"].split())[:NOTE_CHARS])
                for review in pull["reviews"]["nodes"]:
                    other = review["author"]
                    if other is None or other["__typename"] != "User" or other["login"] == author["login"]:
                        continue
                    if review["authorAssociation"] not in MAINTAINERS and other["login"] not in staff:
                        continue
                    for text in [review["body"] or ""] + [line["body"] for line in review["comments"]["nodes"]]:
                        if text.strip():
                            notes.append(f"({review['state'].lower()}) " + " ".join(text.split())[:NOTE_CHARS])
                if not notes:
                    continue
                prs_used += 1
                notes_count += len(notes)
                outcome = "merged" if pull["merged"] else "closed without merging"
                feedback_lines.append(f"PR #{pull['number']} ({outcome}): {pull['title']}")
                for note in notes[:8]:
                    feedback_lines.append(f"  - {note}")

        # The lines about AI. An AI policy file is read whole (its start), AGENTS.md and AGENT_POLICY.md too: they exist
        # for AI tools. The https addresses on lines about AI that say policy, or point to a guide or rules, are the pages
        # it links to.
        excerpts = []
        files = []
        links = []
        lines_left = QUOTE_LINES
        for key, path in POLICY_FILES:
            blob = data[key]
            if blob is None or not blob.get("text"):
                continue
            text = blob["text"]
            for line in text.splitlines():
                if not AI_WORDS.search(line):
                    continue
                if "polic" not in line.lower() and "guide" not in line.lower() and "rules" not in line.lower():
                    continue
                for address in re.findall(r"https://[^\s<>\"'`)\]]+", line):
                    if address not in links:
                        links.append(address)
            if key in WHOLE_POLICY_FILES:
                excerpts.append(f"=== {path} (the start of it)\n{text[:POLICY_FILE_CHARS]}")
                files.append(path)
                continue
            matching = []
            for line in text.splitlines():
                if lines_left <= 0:
                    break
                if AI_WORDS.search(line):
                    matching.append(line.strip()[:LINE_CHARS])
                    lines_left -= 1
            if matching:
                excerpts.append(f"=== {path} (only the lines about AI)\n" + "\n".join(matching))
                files.append(path)
        # The organization's own AI policy, in its .github repo, holds for all its repos (nextcloud's says agents mustn't
        # open pull requests or comment on their own; nextcloud/calendar says nothing of its own).
        try:
            org_policy = await asyncio.to_thread(get_contents, owner, ".github", "AI_POLICY.md")
        except (httpx.HTTPError, ValueError):
            org_policy = None
        if isinstance(org_policy, dict) and org_policy.get("encoding") == "base64":
            text = base64.b64decode(org_policy["content"]).decode("utf-8", errors="replace")
            path = f"{owner}/.github: AI_POLICY.md"
            excerpts.append(f"=== {path} (the organization's policy, for all its repos; the start of it)\n{text[:POLICY_FILE_CHARS]}")
            files.append(path)
        # The policy pages those lines link to: their lines about AI. Only public https pages, never this computer or its
        # network, also not after a redirect. A file on GitHub as its raw text.
        for url in links[:POLICY_LINKS]:
            address = url
            match = re.match(r"https://github\.com/([^/]+)/([^/]+)/blob/(.+)", url)
            if match:
                address = f"https://raw.githubusercontent.com/{match.group(1)}/{match.group(2)}/{match.group(3)}"
            try:
                host = httpx.URL(address).host
                if host == "localhost" or re.fullmatch(r"[0-9.]+|[0-9a-fA-F:]*:[0-9a-fA-F:]*", host):
                    continue
                response = await asyncio.to_thread(httpx.get, address, follow_redirects=True, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            except (httpx.HTTPError, httpx.InvalidURL):
                continue
            host = response.url.host
            if host == "localhost" or re.fullmatch(r"[0-9.]+|[0-9a-fA-F:]*:[0-9a-fA-F:]*", host) or response.url.scheme != "https":
                continue
            if response.status_code != 200 or not response.headers.get("content-type", "").startswith("text/"):
                continue
            text = response.text[:2_000_000]
            if "html" in response.headers.get("content-type", ""):
                text = re.sub(r"(?is)<(script|style|nav|header|footer|svg)\b.*?</\1>", " ", text)
                text = re.sub(r"(?s)<[^>]+>", " ", text)
                text = html.unescape(text)
                text = re.sub(r"[ \t\r\f\v]+", " ", text)
            matching = []
            for line in text.splitlines():
                if AI_WORDS.search(line) and len(matching) < PAGE_LINES:
                    matching.append(line.strip()[:LINE_CHARS])
            if matching:
                excerpts.append(f"=== {url} (a policy page the lines above link to; only its lines about AI)\n" + "\n".join(matching))
                files.append(url)
        policy_text = "\n\n".join(excerpts)

        # The start of the contributing guide, for the newcomer verdict: the first of those files there is. Then the
        # start of the PR template: some say there who may open one ("limited to maintainers and invited contributors").
        contributing_text = ""
        for key, path in POLICY_FILES:
            blob = data[key]
            if key in CONTRIBUTING_FILES and contributing_text == "" and blob is not None and blob.get("text"):
                contributing_text = f"=== {path} (the start of it)\n{blob['text'][:CONTRIBUTING_CHARS]}"
        for key, path in POLICY_FILES:
            blob = data[key]
            if key in PR_TEMPLATE_FILES and blob is not None and blob.get("text"):
                contributing_text += f"\n\n=== {path} (the PR template, the start of it)\n{blob['text'][:PR_TEMPLATE_CHARS]}"
                break

        signals = {
            "fetched_at": now.isoformat(),
            "stars": data["stargazerCount"],
            "description": data["description"] or "",
            "topics": [node["topic"]["name"] for node in data["repositoryTopics"]["nodes"]],
            "language": data["primaryLanguage"]["name"] if data["primaryLanguage"] else None,
            "archived": data["isArchived"],
            "fork": data["isFork"],
            "pushed_at": data["pushedAt"],
            "pr_window_days": window_days,
            "outside_prs_90d": len(window_prs),
            "outside_merged_90d": merged_count,
            "outside_closed_90d": closed_count,
            "outside_merge_rate": merge_rate,
            "median_days_to_first_reply": round(statistics.median(replies), 1) if replies else None,
            "median_days_to_merge": round(statistics.median(merges), 1) if merges else None,
            "average_days_to_merge_30d": average_merge,
            "merge_authors_30d": merge_authors,
            "stale_outside_prs": stale,
            "active_mergers_30d": len(mergers),
            "active_contributors": len(contributors),
            "contributors_total": contributors_total,
            "commits_30d": commits,
            "commits_total": commits_total,
            "open_prs_total": data["openPullRequests"]["totalCount"],
            "merged_prs_total": data["mergedPullRequests"]["totalCount"],
            "closed_prs_total": data["closedPullRequests"]["totalCount"],
            "open_issues_total": data["openIssues"]["totalCount"],
            "beginner_issues": beginner[:BEGINNER_ISSUES_KEPT],
            "unclaimed_beginner_issues": len(unclaimed),
            "newcomers": {
                "prs": len(first_prs),
                "merged": newcomer_merged,
                "closed": newcomer_closed,
                "merge_rate": newcomer_rate,
                "median_days_to_first_reply": newcomer_reply,
                "returned": returned,
                "authors_checked": len(logins),
                "tag": newcomer_tag,
            },
            "reviewers": {"agent": agent_only, "both": both, "human": human_only, "tag": reviewer_tag},
            "activity": activity,
            "community": community,
            "readme_english": readme_english,
            # Kept as they were until complete() reads them again.
            "atmosphere": previous.get("atmosphere") if previous is not None else None,
            "ai_policy": previous["ai_policy"] if previous is not None else None,
            "newcomer_verdict": previous.get("newcomer_verdict") if previous is not None else None,
            # For complete(); put() drops what is left of them.
            "_policy_text": policy_text,
            "_policy_files": files,
            "_policy_basis": hashlib.sha256(policy_text.encode()).hexdigest()[:16] if policy_text else "",
            "_feedback_text": "\n".join(feedback_lines)[:FEEDBACK_CHARS] if feedback_data is not None else None,
            "_feedback_notes": notes_count,
            "_feedback_prs": prs_used,
            "_contributing_text": contributing_text,
        }
        if judged:
            signals = await self.complete(name, signals)
        return signals

    async def complete(self, name: str, signals: dict) -> dict:
        """Add Claude's three judgments to what fetch() found: the AI policy and the review atmosphere at once, then the
        newcomer verdict, which reads the atmosphere too.

        The policy and the atmosphere are only asked when they have to be (the policy text or the atmosphere's summary it
        reads changed; the atmosphere is a week old); the newcomer verdict every time, since it reads the numbers just read.
        """
        signals = dict(signals)
        policy_text = signals.pop("_policy_text", "")
        files = signals.pop("_policy_files", [])
        basis = signals.pop("_policy_basis", "")
        feedback = signals.pop("_feedback_text", None)
        notes = signals.pop("_feedback_notes", 0)
        prs = signals.pop("_feedback_prs", 0)
        contributing = signals.pop("_contributing_text", "")
        now = datetime.now(UTC).isoformat()

        asks = []
        policy = signals["ai_policy"]
        # How reviews of outside PRs go (the atmosphere read before: a new one is read below, at the same time) counts too:
        # hydro's AGENTS.md welcomes AI agents, but its maintainers closed #3295, our kind of fix, as "an autonomously
        # generated PR". It is part of the basis, so a new summary asks again.
        reviews = ""
        if signals["atmosphere"] is not None and signals["atmosphere"]["tone"] != "unknown":
            reviews = signals["atmosphere"]["summary"]
        if basis != "" and reviews != "":
            basis = hashlib.sha256((policy_text + "\n" + reviews).encode()).hexdigest()[:16]
        if policy_text == "":
            policy = {"tag": "none", "quote": "", "file": "", "basis": "", "version": POLICY_VERSION}
        elif policy is None or policy["basis"] != basis or policy.get("version") != POLICY_VERSION:
            prompt = (
                f"These are the passages about AI from the contribution files of the GitHub project {name}, its "
                "organization's AI policy when it has one, and the policy and guide pages they link to.\n"
                "What is the project's stance on contributions made with AI tools (AI-generated or AI-assisted code, PRs, "
                "issues or comments)? Its organization's policy and a policy it adopts by a link are its own too, and the "
                "strictest rule among them decides.\n"
                "- welcome: allowed with no special conditions, or encouraged. An AGENTS.md with instructions for AI coding "
                "tools usually means this, unless other text limits it. So does text that allows AI and says contributors "
                "don't need to say they used it, even when it asks them to understand, run and stand behind what they "
                "submit, as with any code.\n"
                "- disclose: allowed under conditions an AI coding agent that writes the code and the PR can meet, e.g. "
                "contributors must say they used AI (a line in the PR, a label, a field or checkbox in the PR template for "
                "the AI tools used), or must review and understand every line themselves. A line in the PR template "
                "addressed to AI agents that asks them for something other than saying they used AI (proof they read the "
                "template) isn't such a condition.\n"
                "- no_ai: AI-generated contributions are not accepted (banned, closed on sight, humans only), or AI may only "
                "help a human author: AI must not write most of the code, be the main author or decide the PR's structure, "
                "PR descriptions, issues or comments must be written by a human (or AI-created ones are banned), or AI agents "
                "must not open pull requests, issues or comments on their own. Such rules exclude an AI coding agent even when "
                "they also allow AI as a tool with disclosure.\n"
                "- unclear: AI is mentioned, but these passages don't say what is allowed (e.g. they are about the project's "
                "own AI features). Also when they would be welcome or disclose, but how reviews of outside pull requests go "
                "(below, when known) says the maintainers close ones that look AI-made or auto-generated: no_ai still wins "
                "when the passages say so.\n"
                "quote: the one sentence that decides it, copied exactly, at most 200 characters; empty for unclear. "
                "file: the file it is from.\n\n"
                f"How reviews of outside pull requests go lately: {reviews or 'not known'}\n\n"
                f"{policy_text}"
            )
            schema = {
                "type": "object",
                "properties": {
                    "tag": {"type": "string", "enum": POLICY_TAGS},
                    "quote": {"type": "string"},
                    "file": {"type": "string", "enum": files + [""]},
                },
                "required": ["tag", "quote", "file"],
            }
            asks.append(("policy", judge(prompt, schema, "low")))

        atmosphere = signals["atmosphere"]
        if feedback is not None and notes < MIN_NOTES:
            atmosphere = {"tone": "unknown", "summary": "Too little maintainer feedback on recent outside PRs to judge.", "asks_for": [], "prs": prs, "judged_at": now}
        elif feedback is not None:
            prompt = (
                f"Below is what maintainers wrote on recent pull requests from outside contributors to the GitHub project "
                f"{name}: their comments and reviews, with each PR's outcome. How does getting feedback there feel for an "
                "outside contributor?\n"
                "- warm: friendly and encouraging; they thank people, explain, and help them get the PR over the line.\n"
                "- neutral: polite and matter-of-fact, little warmth or friction.\n"
                "- strict: polite but demanding: a high bar (tests, benchmarks, design), several rounds, quick to say no.\n"
                "- curt: short, dismissive or unfriendly; PRs closed without explaining.\n"
                "summary: one plain sentence, at most 160 characters, on what getting a PR reviewed there is like.\n"
                "asks_for: what reviewers often ask contributors for, 0 to 6 of these:\n"
                + "\n".join(f"- {key}: {meaning}" for key, meaning in ASKS.items())
                + "\n\n"
                f"{feedback}"
            )
            schema = {
                "type": "object",
                "properties": {
                    "tone": {"type": "string", "enum": TONES},
                    "summary": {"type": "string"},
                    "asks_for": {"type": "array", "items": {"type": "string", "enum": list(ASKS)}},
                },
                "required": ["tone", "summary", "asks_for"],
            }
            asks.append(("atmosphere", judge(prompt, schema, "low")))

        results = await asyncio.gather(*[ask for _, ask in asks], return_exceptions=True)
        for (which, _), result in zip(asks, results):
            if which == "policy" and isinstance(result, Exception):
                # Claude is down or gave nothing usable: say unclear for now, and ask again next time.
                policy = {"tag": "unclear", "quote": "", "file": "", "basis": "", "version": POLICY_VERSION}
            elif which == "policy":
                policy = {"tag": result["tag"], "quote": result["quote"][:LINE_CHARS], "file": result["file"], "basis": basis, "version": POLICY_VERSION}
            elif which == "atmosphere" and not isinstance(result, Exception):
                asks_for = []
                for item in result["asks_for"]:
                    if item in ASKS and item not in asks_for:
                        asks_for.append(item)
                asks_for = asks_for[:6]
                atmosphere = {"tone": result["tone"], "summary": result["summary"][:240], "asks_for": asks_for, "prs": prs, "judged_at": now}
            # A failed atmosphere keeps the one before (or none); the next fetch asks again.
        signals["ai_policy"] = policy
        signals["atmosphere"] = atmosphere

        # Open to newcomers or not: the numbers, the contributing guide and PR template, and what reviews are like there
        # (the atmosphere, read first: maintainers may write that they stopped taking outside PRs). Claude weighs them.
        stars = signals["stars"]
        total = signals.get("contributors_total")
        newcomers = signals.get("newcomers") or {}
        contributors_line = f"All-time contributors: {total}\nStars per contributor: {round(stars / max(total, 1))}"
        if total is None:
            contributors_line = "All-time contributors: unknown (GitHub wouldn't count them, usually because there are thousands)"
        prompt = (
            f"Is the GitHub project {name} open to newcomers: would a good first pull request from an outside contributor, "
            "someone the maintainers don't know, get looked at and merged?\n"
            "- welcome: yes, outside contributions are wanted and get merged.\n"
            "- closed: not in practice: a company or a small core team writes the code, outside PRs are rarely merged or "
            "not accepted, or the contributing guide says so.\n"
            "Weigh these together:\n"
            "- Stars per all-time contributor: under about 100 usually means an open community; over about 1000 usually "
            "means a closed project with many users and few contributors. In between, the rest decides.\n"
            "- What the contributing guide and the PR template say about outside contributions (not accepted, issues only, "
            "maintainers only, discuss first, ...). When they or the maintainers say outside PRs are no longer taken or are "
            "closed automatically (limited to maintainers and invited contributors), it is closed however many were merged "
            "before: the rule may be new.\n"
            "- How outside PRs and newcomers' first PRs went recently, and what reviews of them are like.\n"
            "reason: one plain sentence, at most 160 characters, on what decided it.\n\n"
            f"Stars: {stars}\n"
            f"{contributors_line}\n"
            f"Outside PRs (by people who aren't maintainers) finished in the last 90 days: {signals['outside_merged_90d']} merged, "
            f"{signals['outside_closed_90d']} closed without merging\n"
            f"Newcomers' first PRs in that time: {newcomers.get('prs', 0)}, of them {newcomers.get('merged', 0)} merged and "
            f"{newcomers.get('closed', 0)} closed without merging; median days to a maintainer's first reply: "
            f"{newcomers.get('median_days_to_first_reply')}\n"
            f"Reviews of outside PRs lately: {atmosphere['summary'] if atmosphere is not None else 'not read'}\n\n"
            f"{contributing if contributing != '' else 'It has no contributing guide.'}"
        )
        schema = {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["welcome", "closed"]},
                "reason": {"type": "string"},
            },
            "required": ["verdict", "reason"],
        }
        try:
            result = await judge(prompt, schema, "low")
            signals["newcomer_verdict"] = {"verdict": result["verdict"], "reason": result["reason"][:240], "version": NEWCOMER_VERSION, "judged_at": now}
        except Exception:
            # Claude is down or gave nothing usable: the one before (or none) stays, and the next fetch asks again.
            pass
        return signals
