"""How each repo treats outside contributors and newcomers, how busy it is, how its reviews feel, and what it
says about AI: the numbers and tags behind the Repos page.

One JSON file, DATA_DIR/repo_signals.json, by repo (owner/name):

    {"owner/name": Signals, ...}

    Signals = {"fetched_at", "stars", "description", "topics", "language", "archived", "fork", "pushed_at",
               "pr_window_days",
               "outside_prs_90d", "outside_merged_90d", "outside_closed_90d", "outside_merge_rate",
               "median_days_to_first_reply", "median_days_to_merge", "stale_outside_prs",
               "active_mergers_30d", "active_contributors", "commits_30d",
               "beginner_issues": [{"number", "title", "created_at", "labels", "assignees", "cross_references"}, ...],
               "unclaimed_beginner_issues",
               "newcomers": {"prs", "merged", "closed", "merge_rate", "median_days_to_first_reply", "returned",
                             "authors_checked", "tag"},
               "activity": {"prs_opened_month", "prs_merged_month", "issues_opened_month", "issues_closed_month",
                            "commits_month", "prs_opened_30d", "prs_merged_30d", "issues_opened_30d",
                            "issues_closed_30d", "trend", "last_release", "last_release_at",
                            "issue_reply_rate", "issues_checked"},
               "community": {"contributing", "code_of_conduct", "discussions", "channels"},
               "atmosphere": {"tone", "summary", "asks_for", "prs", "judged_at"} | None,
               "ai_policy": {"tag", "quote", "file", "basis"}}

Outside contributors are PR authors who aren't owners, members or collaborators, and not bots.
- Of their PRs that ended in the last 90 days (among the repo's 100 most recently updated finished PRs, fewer
  for huge repos): outside_merge_rate is merged / (merged + closed without merging), None with fewer than
  MIN_SAMPLE of those; median_days_to_merge is from opening to merge. Finished PRs, not new ones: in a repo
  with 3,000 PRs a month the newest are mostly still open, which would make any rate look bad. A PR closed
  by a commit counts as merged: some projects (pytorch) land changes with a bot and then close the PR.
- Of their PRs opened in the last 90 days (among the repo's 100 newest PRs; pr_window_days says how many days
  those reach back when they cover less than 90): outside_prs_90d, and median_days_to_first_reply, until the
  first review or comment by a maintainer (a merge without one counts as the reply). Only maintainers count: a
  bot's review (an AI reviewer, a CLA check) or another outsider's comment isn't a reply.
stale_outside_prs: their open PRs over 30 days old that no maintainer has answered (among the 100 oldest
open PRs). active_mergers_30d: how many people merged a PR in the last 30 days (bots not counted); the page calls
them its maintainers. active_contributors: how many people opened a PR in that window, anyone but bots.
beginner_issues: open issues under a good-first / beginner / easy / help-wanted label, newest first. Unclaimed
ones have no assignee and no cross reference (a PR or issue that mentions them).

newcomers: outside authors in that window who never opened a PR there before it (GitHub's own "first-time
contributor" mark changes once a PR is merged, so each author is looked up instead; the NEWCOMER_AUTHORS most
recent ones). Their first PRs: how many, merged, closed unmerged, the merge rate and the median days to a first
reply; returned is how many opened a second PR. tag:
    welcomes      most first PRs merged (MIN_SAMPLE or more finished) and a first reply within 3 days
    turned_away   most first PRs closed unmerged (a merge rate under 30%)
    left_waiting  most first PRs over LEFT_DAYS days old are still open: neither merged nor closed
    few           fewer than MIN_NEWCOMERS newcomers: too few to tell (neutral, not a bad sign)
    ok            anything else, also a slow first reply (over a week) when their PRs do get merged

activity: monthly averages over the last 90 days (GitHub's own counts), the last 30 days as they are, and trend
("up" / "down" / "flat") when those 30 days are a quarter above or below the average. issue_reply_rate: of
issues outsiders opened 7 to 90 days ago (of the 100 newest), the share a maintainer answered within a week.

community: a CONTRIBUTING file, a code of conduct, GitHub Discussions on, and chat links in the README.

atmosphere: Claude (claude_judge.py) reads what maintainers wrote on recent finished outside PRs and names how
feedback feels: warm, neutral, strict or curt ("unknown" when there is too little to read), with one sentence and
what reviewers often ask for, from the fixed list ASKS (so repos compare and rank the same way every time). Read
again at most every ATMOSPHERE_DAYS days, or sooner when asks_for is from before ASKS. None until first judged.

ai_policy comes from the files where projects say it (POLICY_FILES). Code finds the lines that mention AI, and
Claude reads them and names the stance:
    welcome   AI-assisted contributions are fine
    disclose  allowed, under conditions (say so, review it yourself, ...)
    no_ai     AI-generated contributions are not accepted
    unclear   AI is mentioned, but what's allowed isn't said
    none      nothing about AI in those files (no Claude call)
basis is those lines, hashed: Claude is only asked again when they change. A failed ask is "unclear" with an
empty basis, so the next fetch asks again.

fetch() gets the numbers from GitHub; complete() adds Claude's two judgments (policy and atmosphere). fetch() does
both unless told not to: Explore checks the numbers first and only pays for the judgments of repos it keeps.

Kept apart from the Repos list on purpose, like issue_facts.py: the list's undo/redo should only undo what agents
and the user did. The backend fetches signals for new repos, and for each again once a day (backend/repos_api.py).
version goes up by one on every change, like the other stores.
"""

import asyncio
import copy
import hashlib
import json
import os
import re
import statistics
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.claude_judge import judge
from github_searcher.search import count_earlier_prs, get_readme, get_repo_activity, get_repo_pulls, get_repo_signals, get_review_feedback

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
    ("agentsFile", "AGENTS.md"),
]
CONTRIBUTING_FILES = ["contributing", "contributingRst", "githubContributing", "docsContributing"]
POLICY_TAGS = ["welcome", "disclose", "no_ai", "unclear"]
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
# At most this many lines about AI from all files together, each cut at LINE_CHARS.
QUOTE_LINES = 25
LINE_CHARS = 300
# A rate from fewer finished PRs (or checked issues) than this says little.
MIN_SAMPLE = 3
MIN_ISSUES = 5
MIN_NEWCOMERS = 3
# A newcomer's first PR still open after this many days counts as left waiting.
LEFT_DAYS = 30
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
            for key in ["_policy_text", "_policy_files", "_policy_basis", "_feedback_text", "_feedback_notes", "_feedback_prs"]:
                kept.pop(key, None)
            self.signals[name] = kept
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

        # Outside contributors' PRs in that window, kept per PR for the newcomers below.
        window_prs = []
        replies = []
        for pull in nodes:
            author = pull["author"]
            if pull["authorAssociation"] not in OUTSIDE or author is None or author["__typename"] != "User":
                continue
            if author["login"].lower().endswith("bot"):
                continue
            opened = datetime.fromisoformat(pull["createdAt"])
            if opened < window_start:
                continue
            # The first reply from a maintainer, a person: not a bot, not the author, not another outsider.
            first = None
            for item in pull["reviews"]["nodes"] + pull["comments"]["nodes"]:
                other = item["author"]
                if other is None or other["__typename"] != "User":
                    continue
                if other["login"] == author["login"] or other["login"].lower().endswith("bot"):
                    continue
                if item["authorAssociation"] not in MAINTAINERS:
                    continue
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
            window_prs.append({"login": author["login"], "opened": opened, "merged": landed, "closed": closed, "reply": reply})

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
            if author["login"].lower().endswith("bot") or pull["closedAt"] is None:
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
        feedback_data = None
        if need_feedback and not isinstance(results[3], Exception):
            feedback_data = results[3]

        newcomer_logins = [login for login in logins if earlier.get(login) == 0]
        first_prs = []
        returned = 0
        for login in newcomer_logins:
            theirs = sorted([pull for pull in window_prs if pull["login"] == login], key=lambda pull: pull["opened"])
            first_prs.append(theirs[0])
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
            if datetime.fromisoformat(pull["createdAt"]) > now - timedelta(days=30):
                continue
            replied = False
            for item in pull["reviews"]["nodes"] + pull["comments"]["nodes"]:
                other = item["author"]
                if other is None or other["__typename"] != "User":
                    continue
                if other["login"].lower().endswith("bot") or item["authorAssociation"] not in MAINTAINERS:
                    continue
                if other["login"] != author["login"]:
                    replied = True
            if not replied:
                stale += 1

        commits = 0
        target = (data["defaultBranchRef"] or {}).get("target") or {}
        if target.get("history"):
            commits = target["history"]["totalCount"]

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
                if author["login"].lower().endswith("bot") or prs_used >= FEEDBACK_PRS:
                    continue
                notes = []
                for comment in pull["comments"]["nodes"]:
                    other = comment["author"]
                    if other is None or other["__typename"] != "User" or other["login"] == author["login"]:
                        continue
                    if comment["authorAssociation"] in MAINTAINERS and comment["body"].strip():
                        notes.append(" ".join(comment["body"].split())[:NOTE_CHARS])
                for review in pull["reviews"]["nodes"]:
                    other = review["author"]
                    if other is None or other["__typename"] != "User" or other["login"] == author["login"]:
                        continue
                    if review["authorAssociation"] not in MAINTAINERS:
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

        # The lines about AI. An AI policy file is read whole (its first part), AGENTS.md too: it exists for AI tools.
        excerpts = []
        files = []
        lines_left = QUOTE_LINES
        for key, path in POLICY_FILES:
            blob = data[key]
            if blob is None or not blob.get("text"):
                continue
            text = blob["text"]
            if key in ["aiPolicy", "agentsFile"]:
                excerpts.append(f"=== {path} (the start of it)\n{text[:2500]}")
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
        policy_text = "\n\n".join(excerpts)

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
            "stale_outside_prs": stale,
            "active_mergers_30d": len(mergers),
            "active_contributors": len(contributors),
            "commits_30d": commits,
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
            "activity": activity,
            "community": community,
            # Kept as they were until complete() reads them again.
            "atmosphere": previous.get("atmosphere") if previous is not None else None,
            "ai_policy": previous["ai_policy"] if previous is not None else None,
            # For complete(); put() drops what is left of them.
            "_policy_text": policy_text,
            "_policy_files": files,
            "_policy_basis": hashlib.sha256(policy_text.encode()).hexdigest()[:16] if policy_text else "",
            "_feedback_text": "\n".join(feedback_lines)[:FEEDBACK_CHARS] if feedback_data is not None else None,
            "_feedback_notes": notes_count,
            "_feedback_prs": prs_used,
        }
        if judged:
            signals = await self.complete(name, signals)
        return signals

    async def complete(self, name: str, signals: dict) -> dict:
        """Add Claude's two judgments to what fetch() found: the AI policy and the review atmosphere, both at once.

        Each is only asked when it has to be (the policy text changed; the atmosphere is a week old).
        """
        signals = dict(signals)
        policy_text = signals.pop("_policy_text", "")
        files = signals.pop("_policy_files", [])
        basis = signals.pop("_policy_basis", "")
        feedback = signals.pop("_feedback_text", None)
        notes = signals.pop("_feedback_notes", 0)
        prs = signals.pop("_feedback_prs", 0)
        now = datetime.now(UTC).isoformat()

        asks = []
        policy = signals["ai_policy"]
        if policy_text == "":
            policy = {"tag": "none", "quote": "", "file": "", "basis": ""}
        elif policy is None or policy["basis"] != basis:
            prompt = (
                f"These are the passages about AI from the contribution files of the GitHub project {name}.\n"
                "What is the project's stance on contributions made with AI tools (AI-generated or AI-assisted code, PRs, "
                "issues or comments)?\n"
                "- welcome: allowed with no special conditions, or encouraged. An AGENTS.md with instructions for AI coding "
                "tools usually means this, unless other text limits it.\n"
                "- disclose: allowed under conditions, e.g. contributors must say they used AI, or must review and understand "
                "every line themselves.\n"
                "- no_ai: AI-generated contributions are not accepted (banned, closed on sight, humans only).\n"
                "- unclear: AI is mentioned, but these passages don't say what is allowed (e.g. they are about the project's "
                "own AI features).\n"
                "quote: the one sentence that decides it, copied exactly, at most 200 characters; empty for unclear. "
                "file: the file it is from.\n\n"
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
                policy = {"tag": "unclear", "quote": "", "file": "", "basis": ""}
            elif which == "policy":
                policy = {"tag": result["tag"], "quote": result["quote"][:LINE_CHARS], "file": result["file"], "basis": basis}
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
        return signals
