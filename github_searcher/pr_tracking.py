"""Your PRs and issues on GitHub, how each one stands, and which agent follows each one, for the GitHub tab
(frontend/src/GitHub.tsx).

Which ones: every PR the Inbox's Approve sent (a draft's "sent", github_account.py), and, with your GitHub account
connected, four searches on other people's projects, the 50 most recently updated of each: PRs you opened (author:<you>),
PRs you only commented on (commenter:<you> -author:<you>), issues you opened and issues you only commented on. So the
ones you sent by hand are there too. Read with the search tokens (token_balancer.py), never your own.

It keeps, in DATA_DIR/pr_tracking.json, by "owner/name#number", each PR in "prs":

    {"id", "repo", "number", "title", "url", "author",
     "state": "open" | "merged" | "closed", "draft": bool (GitHub's draft PR),
     "opened_at", "updated_at", "closed_at": str | None, "merged_by": str | None,
     "labels": [name, ...],
     "checks": "waiting" | "running" | "passed" | "failed" | "none",
     "waiting_runs": int,
     "review": "approved" | "changes_requested" | "commented" | "none",
     "reviewers": [{"login", "state", "at", "role"}, ...] (each reviewer's latest review),
     "comments": int, "last_comment": {"login", "role", "at", "text"} | None,
     "issues": [{"number", "title", "url", "state": "open" | "closed", "reason", "assignees"}, ...],
     "relation": "author" | "commented",
     "head": {"repo": "you/name", "branch", "sha"} | None, "base": the branch it goes into,
     "mergeable": "yes" | "conflicts" | "unknown",
     "last_activity": {"login", "at", "what": "comment" | "review"} | None, "your_last_at": str | None,
     "bot_activity": {"login", "at", "what"} | None,
     "signals": {"state", "draft", "title", "head", "checks", "mergeable", "labels", "bot_at"},
     "draft_id": "draft_..." | None, "job": "job_..." | None,
     "agent": "<agent id>" | None, "agent_mode": "drafts" | "off",
     "checked_at", "error": str | None}

and each issue in "issues":

    {"id", "repo", "number", "title", "url", "author", "state": "open" | "closed",
     "reason": "completed" | "not_planned" | "duplicate" | None (closed only),
     "opened_at", "updated_at", "closed_at", "labels", "assignees": [login, ...],
     "comments", "last_comment", "relation", "last_activity", "your_last_at", "agent", "agent_mode",
     "checked_at", "error"}

checks is the newest commit's checks: waiting when any of the project's GitHub Actions runs on it waits for a
maintainer to approve it (GitHub does that for a first-time contributor: nothing runs until someone clicks
Approve, and the checks list shows nothing), else running, passed or failed, or none when the project has no
checks. review weighs each reviewer's latest review: approved (and nobody asks for changes), changes_requested,
commented, or none. issues are the issues the PR says it fixes. role is GitHub's word for the person (MEMBER,
COLLABORATOR, OWNER, CONTRIBUTOR, NONE, or BOT). relation: author (you opened it) or commented (you only commented).
head is the PR's branch and newest commit, None once the branch is deleted. mergeable says whether it conflicts with
base (unknown while GitHub works it out, e.g. right after a push). last_activity is the newest comment or review there
by someone other than you, your_last_at your newest; bots never count there (GitHub's Bot accounts, or logins ending in
[bot]): bot_activity is a bot's newest instead. signals is what its agent hears a change of. draft_id and job link a
PR the app sent to its draft.

Agents: each PR or issue has two modes. drafts: its agent drafts a reply or a fix when someone else writes there or
(your PR) its checks fail, and you approve each in the Inbox; off: no drafts. Nothing goes to GitHub without your
approval. "agent_settings" keeps, by id, {"mode": "drafts" | "off" | None, "agent", "answered_at", "failed_sha",
"told"}: mode and agent are what you picked (set_agent, the thread pop-up's Agent setting; None: you never did; the
app picks one for a PR of yours that has none, backend/github_api.py), answered_at the last activity an agent was
already given, failed_sha the newest commit whose failed checks it was given, and told the signals it was last told
of (the first read's, or the ones when its agent was picked: it hears what changes after). agent and agent_mode on
each record are what holds: your pick, else drafts with the agent of the first draft that went there (a PR Approve
sent, or a comment the app posted on it), else off.

needs_reply() lists the open threads in drafts mode with an agent where someone else wrote after you and after
answered_at, or (your PR) the checks failed on a newest commit no agent was given yet, or anything else changed on
your PR since told: merged, closed or reopened, made a draft or ready for review, a new title, a new commit nobody
drafted here (you or a maintainer pushed), its checks passed or wait for a maintainer, it conflicts with its base
branch now (or no longer), labels added or removed, a bot wrote. What its agent did there itself with an approved
action (closed, reopened, made a draft or ready, Update branch's merge) isn't news. backend/github_api.py gives each to
its agent as a follow_up job, then calls mark_answered(). A closed or merged thread only has its end to hear about, once.

refresh() reads them all again, one GraphQL query each (and one Actions call per PR); a merged or closed one whose
updated_at in the search didn't change isn't read again. The backend calls it every few minutes, soon after something
was sent or you commented, and on Check now (backend/github_api.py). One that fails to read keeps its last status,
with the error. error at the top is why a search failed. version goes up on every change.
"""

import copy
import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.search import get_action_runs, get_issue_status, get_pr_status, search_issues

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# How much of the latest comment is kept.
COMMENT_CHARS = 300
ROLLUP = {"SUCCESS": "passed", "FAILURE": "failed", "ERROR": "failed", "PENDING": "running", "EXPECTED": "running"}
AGENT_MODES = ["drafts", "off"]


class PRTracking:
    def __init__(self, inbox, github_account):
        self.inbox = inbox
        self.github_account = github_account
        self.path = DATA_DIR / "pr_tracking.json"
        self.lock = threading.Lock()
        # One refresh at a time: Check now and the background one.
        self.refresh_lock = threading.Lock()
        self.refreshing = False
        # Something changed on GitHub here (you commented): backend/github_api.py reads them all again soon.
        self.wanted = False
        self.version = 0
        self.data = {"prs": {}, "issues": {}, "agent_settings": {}, "checked_at": None, "error": None}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
        # Files from before issues and agent settings.
        self.data.setdefault("issues", {})
        self.data.setdefault("agent_settings", {})
        # PRs read before these were kept have them from their next read on.
        for pr in self.data["prs"].values():
            pr.setdefault("relation", "author")
            pr.setdefault("head", None)
            pr.setdefault("last_activity", None)
            pr.setdefault("your_last_at", None)
            pr.setdefault("agent_mode", "drafts" if pr["agent"] is not None else "off")
            pr.setdefault("base", None)
            pr.setdefault("mergeable", "unknown")
            pr.setdefault("bot_activity", None)
            pr.setdefault("signals", None)

    def save(self) -> None:
        """Write to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.data))
        temporary.replace(self.path)

    def summary(self) -> dict:
        """For the live feed: every PR and every issue, the newest change first."""
        with self.lock:
            items = sorted(self.data["prs"].values(), key=lambda pr: pr["updated_at"], reverse=True)
            issues = sorted(self.data["issues"].values(), key=lambda issue: issue["updated_at"], reverse=True)
            return {
                "items": copy.deepcopy(items),
                "issues": copy.deepcopy(issues),
                "checked_at": self.data["checked_at"],
                "error": self.data["error"],
                "refreshing": self.refreshing,
            }

    def set_agent(self, thread_id: str, mode: str, agent_id: str | None) -> dict:
        """Your pick for one PR or issue: "drafts" with agent_id, or "off" (no agent then). Returns {"mode", "agent"}."""
        if mode not in AGENT_MODES:
            raise ValueError(f"Unknown mode {mode!r}, use drafts or off")
        agent = agent_id
        if mode == "off":
            agent = None
        with self.lock:
            empty = {"mode": None, "agent": None, "answered_at": None, "failed_sha": None, "told": None}
            setting = self.data["agent_settings"].setdefault(thread_id, empty)
            setting["mode"] = mode
            setting["agent"] = agent
            if thread_id in self.data["prs"]:
                self.data["prs"][thread_id]["agent"] = agent
                self.data["prs"][thread_id]["agent_mode"] = mode
                # Its agent hears what changes from now on, and about a conflict it has already.
                setting["told"] = copy.deepcopy(self.data["prs"][thread_id].get("signals"))
                if setting["told"] is not None:
                    setting["told"]["mergeable"] = "unknown"
            if thread_id in self.data["issues"]:
                self.data["issues"][thread_id]["agent"] = agent
                self.data["issues"][thread_id]["agent_mode"] = mode
            self.save()
        return {"mode": mode, "agent": agent}

    def needs_reply(self) -> list[dict]:
        """The open threads whose agent should follow up now: drafts mode with an agent, and someone else wrote after
        you and after what an agent was given already, or (your PR) its checks failed on a newest commit no agent was
        given yet, or anything else changed on your PR since its agent was last told (the module docstring). Each:
        {"id", "kind": "pr" | "issue", "relation": "author" | "commented", "state", "title", "url", "agent", "reason",
        "at": activity time | None, "failed_sha": sha | None, "head": {"repo", "branch", "sha"} | None, "base",
        "signals": what to keep as told | None}."""
        threads = []
        with self.lock:
            for pr in self.data["prs"].values():
                threads.append(("pr", copy.deepcopy(pr)))
            for issue in self.data["issues"].values():
                threads.append(("issue", copy.deepcopy(issue)))
            settings = copy.deepcopy(self.data["agent_settings"])

        # What the app itself sent to each PR: a commit of its own there, a title its agent changed, or what its agent
        # did there (closed, reopened, made a draft or ready, the merge of Update branch) is no news to it.
        sent_commits = []
        sent_titles = {}
        sent_actions = {}
        for draft in self.inbox.list():
            sent = draft["sent"]
            if sent is None:
                continue
            if sent["kind"] == "pr":
                sent_commits.append(sent["commit"])
            if sent["kind"] == "edit":
                sent_titles.setdefault(f"{sent['repo']}#{sent['number']}", []).append(sent["title"])
            if sent["kind"] == "action":
                sent_actions.setdefault(f"{sent['repo']}#{sent['number']}", []).append(sent["action"])
                if sent["commit"] is not None:
                    sent_commits.append(sent["commit"])

        entries = []
        for kind, record in threads:
            if record["agent_mode"] != "drafts" or record["agent"] is None:
                continue
            setting = settings.get(record["id"], {})
            told = setting.get("told")
            signals = record.get("signals")
            # Your PR's other changes since its agent was last told.
            changes = []
            if kind == "pr" and record["relation"] == "author" and told is not None and signals is not None:
                if signals["state"] != told["state"] and signals["state"] == "merged":
                    changes.append(f"it was merged by @{record['merged_by']}")
                done = sent_actions.get(record["id"], [])
                if signals["state"] != told["state"] and signals["state"] == "closed" and "close" not in done:
                    changes.append("it was closed without being merged")
                if signals["state"] != told["state"] and signals["state"] == "open" and "reopen" not in done:
                    changes.append("it was reopened")
                if signals["draft"] != told["draft"] and signals["draft"] and "convert_to_draft" not in done:
                    changes.append("it was turned into a draft")
                if signals["draft"] != told["draft"] and not signals["draft"] and "ready_for_review" not in done:
                    changes.append("it was marked ready for review")
                if signals["title"] != told["title"] and signals["title"] not in sent_titles.get(record["id"], []):
                    changes.append(f"its title was changed to \"{signals['title']}\"")
                if signals["head"] != told["head"] and signals["head"] is not None and signals["head"] not in sent_commits:
                    changes.append(f"its branch has a new commit, {signals['head'][:10]}, that no draft here made (the user or a maintainer pushed it)")
                # The checks of a new newest commit are news too, even when the last ones had passed as well.
                checks_changed = signals["checks"] != told["checks"] or signals["head"] != told["head"]
                if checks_changed and signals["checks"] == "passed":
                    changes.append("its checks passed")
                if checks_changed and signals["checks"] == "waiting":
                    changes.append("its checks wait for a maintainer to approve them")
                if signals["mergeable"] == "conflicts" and told["mergeable"] != "conflicts":
                    changes.append(f"it conflicts with {record['base']} now")
                if signals["mergeable"] == "yes" and told["mergeable"] == "conflicts":
                    changes.append(f"it no longer conflicts with {record['base']}")
                added = [label for label in signals["labels"] if label not in told["labels"]]
                removed = [label for label in told["labels"] if label not in signals["labels"]]
                if added:
                    changes.append("it got the label " + ", ".join(added))
                if removed:
                    changes.append("it lost the label " + ", ".join(removed))
                if signals["bot_at"] != told["bot_at"] and record["bot_activity"] is not None:
                    changes.append(f"@{record['bot_activity']['login']} {record['bot_activity']['what']}")
            # A closed or merged thread only has its end to hear about, once.
            if record["state"] != "open" and not changes:
                continue
            answered_at = setting.get("answered_at")
            activity = record["last_activity"]
            reasons = []

            # Someone else wrote last, and no agent was given it yet.
            at = None
            if activity is not None and (record["your_last_at"] is None or activity["at"] > record["your_last_at"]):
                at = activity["at"]
            if at is not None and answered_at is not None and at <= answered_at:
                at = None
            if at is not None and activity["what"] == "comment":
                reasons.append(f"@{activity['login']} commented")
            if at is not None and activity["what"] == "review":
                # That reviewer's latest review is this one.
                states = {reviewer["login"]: reviewer["state"] for reviewer in record.get("reviewers", [])}
                what = f"@{activity['login']} reviewed it"
                if states.get(activity["login"]) == "changes_requested":
                    what += " (changes requested)"
                if states.get(activity["login"]) == "approved":
                    what += " (approved)"
                reasons.append(what)

            # Your PR's checks failed on its newest commit, and no agent was given that commit yet.
            failed_sha = None
            if kind == "pr" and record["relation"] == "author" and record["state"] == "open" and record["checks"] == "failed" and record["head"] is not None:
                failed_sha = record["head"]["sha"]
            if failed_sha is not None and failed_sha == setting.get("failed_sha"):
                failed_sha = None
            if failed_sha is not None:
                reasons.append("its checks failed")

            reasons.extend(changes)
            if not reasons:
                continue
            entries.append({
                "id": record["id"],
                "kind": kind,
                "relation": record["relation"],
                "state": record["state"],
                "title": record["title"],
                "url": record["url"],
                "agent": record["agent"],
                "reason": " and ".join(reasons),
                "at": at,
                "failed_sha": failed_sha,
                "head": record.get("head"),
                "base": record.get("base"),
                "signals": signals,
            })
        return entries

    def mark_answered(self, thread_id: str, at: str | None, failed_sha: str | None, signals: dict | None = None) -> None:
        """An agent was given the thread's activity up to at, the failed checks of the commit failed_sha, and the PR as
        signals has it (None: not given that part)."""
        with self.lock:
            empty = {"mode": None, "agent": None, "answered_at": None, "failed_sha": None, "told": None}
            setting = self.data["agent_settings"].setdefault(thread_id, empty)
            if at is not None:
                setting["answered_at"] = at
            if failed_sha is not None:
                setting["failed_sha"] = failed_sha
            if signals is not None:
                told = copy.deepcopy(signals)
                # Unknown is GitHub still working it out: what it was told about a conflict holds until it knows.
                if told["mergeable"] == "unknown" and setting.get("told") is not None:
                    told["mergeable"] = setting["told"]["mergeable"]
                setting["told"] = told
            self.save()

    def refresh(self) -> None:
        """Read every PR and issue to follow from GitHub again. Runs in a thread; a second call waits for the first."""
        with self.refresh_lock:
            with self.lock:
                self.refreshing = True
                self.version += 1
            try:
                self.read_all()
            finally:
                with self.lock:
                    self.refreshing = False
                    self.version += 1

    def read_all(self) -> None:
        # The PRs the app sent, with their drafts, and the agents of the comments it posted. inbox.list() is newest
        # first, so the first draft that went to a thread is the one that stays.
        follow_prs = {}
        follow_issues = {}
        commented_by = {}
        for draft in self.inbox.list():
            sent = draft["sent"]
            if sent is None:
                continue
            thread_id = f"{sent['repo']}#{sent['number']}"
            if sent["kind"] == "pr":
                follow_prs[thread_id] = {"relation": "author", "updated": None, "draft_id": draft["id"], "job": draft["job"], "agent": draft["agent"]}
            if sent["kind"] == "comment":
                commented_by[thread_id] = draft["agent"]

        # Yours on other people's projects, also the ones sent by hand: the ones you opened first, then the ones you
        # only commented on.
        error = None
        you = None
        account = self.github_account.status()
        if account["connected"]:
            you = account["login"]
        searches = []
        if you is not None:
            searches = [
                ("pr", "author", f"is:pr author:{you} -user:{you}"),
                ("pr", "commented", f"is:pr commenter:{you} -author:{you} -user:{you}"),
                ("issue", "author", f"is:issue author:{you} -user:{you}"),
                ("issue", "commented", f"is:issue commenter:{you} -author:{you} -user:{you}"),
            ]
        for kind, relation, query in searches:
            try:
                result = search_issues(query, sort="updated")
            except Exception as problem:
                error = f"Could not search GitHub for your PRs and issues: {problem}"
                continue
            follow = follow_prs
            if kind == "issue":
                follow = follow_issues
            for item in result["items"]:
                repo = item["repository_url"].removeprefix("https://api.github.com/repos/")
                thread_id = f"{repo}#{item['number']}"
                if thread_id in follow:
                    follow[thread_id]["updated"] = item["updated_at"]
                    continue
                follow[thread_id] = {"relation": relation, "updated": item["updated_at"], "draft_id": None, "job": None, "agent": commented_by.get(thread_id)}

        for pr_id, link in follow_prs.items():
            repo = pr_id.split("#")[0]
            owner = repo.split("/")[0]
            name = repo.split("/")[1]
            number = int(pr_id.split("#")[1])
            now = datetime.now(UTC).isoformat()

            # Who follows it: the agent you picked for it, else the one whose draft went there.
            agent = link["agent"]
            agent_mode = "off"
            if agent is not None:
                agent_mode = "drafts"
            with self.lock:
                setting = self.data["agent_settings"].get(pr_id)
                if setting is not None and setting["mode"] is not None:
                    agent = setting["agent"]
                    agent_mode = setting["mode"]
                known = {"relation": link["relation"], "draft_id": link["draft_id"], "job": link["job"], "agent": agent, "agent_mode": agent_mode}
                # A merged or closed PR that didn't change since it was last read isn't read again.
                old = self.data["prs"].get(pr_id)
                unchanged = old is not None and old["state"] != "open" and old["error"] is None and old["updated_at"] == link["updated"]
                if unchanged:
                    old.update(known)
            if unchanged:
                continue

            try:
                pull = get_pr_status(owner, name, number)
                if pull is None:
                    raise ValueError("GitHub has no such PR anymore.")
                runs = []
                if pull["commits"]["nodes"]:
                    runs = get_action_runs(owner, name, pull["commits"]["nodes"][0]["commit"]["oid"])
            except Exception as problem:
                with self.lock:
                    if pr_id in self.data["prs"]:
                        self.data["prs"][pr_id].update(known)
                        self.data["prs"][pr_id]["error"] = str(problem)
                        self.data["prs"][pr_id]["checked_at"] = now
                        self.save()
                continue

            # The newest commit's checks; runs waiting for a maintainer's approval show nowhere else.
            checks = "none"
            rollup = None
            if pull["commits"]["nodes"]:
                rollup = pull["commits"]["nodes"][0]["commit"]["statusCheckRollup"]
            if rollup is not None:
                checks = ROLLUP.get(rollup["state"], "running")
            waiting_runs = len([run for run in runs if run["conclusion"] == "action_required"])
            if waiting_runs > 0:
                checks = "waiting"

            # Each reviewer's latest review, not the PR's author's own.
            author = pull["author"]["login"] if pull["author"] else "ghost"
            latest = {}
            for review in pull["reviews"]["nodes"]:
                if review["author"] is None or review["state"] == "PENDING":
                    continue
                login = review["author"]["login"]
                if login == author:
                    continue
                role = review["authorAssociation"]
                if review["author"]["__typename"] == "Bot":
                    role = "BOT"
                latest[login] = {"login": login, "state": review["state"].lower(), "at": review["submittedAt"], "role": role}
            states = [reviewer["state"] for reviewer in latest.values()]
            review = "none"
            if "commented" in states:
                review = "commented"
            if "changes_requested" in states:
                review = "changes_requested"
            elif pull["reviewDecision"] == "APPROVED" or "approved" in states:
                review = "approved"

            # The comments come oldest first: the newest is the last.
            last_comment = None
            if pull["comments"]["nodes"]:
                comment = pull["comments"]["nodes"][-1]
                login = comment["author"]["login"] if comment["author"] else "ghost"
                role = comment["authorAssociation"]
                if comment["author"] is not None and comment["author"]["__typename"] == "Bot":
                    role = "BOT"
                text = " ".join(comment["body"].split())
                if len(text) > COMMENT_CHARS:
                    text = text[:COMMENT_CHARS - 1] + "…"
                last_comment = {"login": login, "role": role, "at": comment["createdAt"], "text": text}

            # The newest comment or review by someone other than you, and your newest. Bots never count. Without
            # your account connected, only the PRs the app sent are here: you are their author.
            me = you
            if me is None:
                me = author
            last_activity = None
            your_last_at = None
            # A bot's newest (a review bot's findings, a CI note): a change its agent hears about, kept apart.
            bot_activity = None
            for comment in pull["comments"]["nodes"]:
                if comment["author"] is None:
                    continue
                login = comment["author"]["login"]
                at = comment["createdAt"]
                bot = comment["author"]["__typename"] == "Bot" or login.endswith("[bot]")
                if bot and (bot_activity is None or at > bot_activity["at"]):
                    bot_activity = {"login": login, "at": at, "what": "commented"}
                if bot:
                    continue
                if login == me and (your_last_at is None or at > your_last_at):
                    your_last_at = at
                if login != me and (last_activity is None or at > last_activity["at"]):
                    last_activity = {"login": login, "at": at, "what": "comment"}
            for each in pull["reviews"]["nodes"]:
                if each["author"] is None or each["state"] == "PENDING":
                    continue
                login = each["author"]["login"]
                at = each["submittedAt"]
                bot = each["author"]["__typename"] == "Bot" or login.endswith("[bot]")
                if bot and (bot_activity is None or at > bot_activity["at"]):
                    bot_activity = {"login": login, "at": at, "what": "reviewed it"}
                if bot:
                    continue
                if login == me and (your_last_at is None or at > your_last_at):
                    your_last_at = at
                if login != me and (last_activity is None or at > last_activity["at"]):
                    last_activity = {"login": login, "at": at, "what": "review"}

            # Its branch, for an agent's fix to go on top of. Gone once the branch is deleted.
            head = None
            if pull["headRepository"] is not None and pull["headRef"] is not None:
                head = {"repo": pull["headRepository"]["nameWithOwner"], "branch": pull["headRefName"], "sha": pull["headRefOid"]}
            mergeable = "unknown"
            if pull["mergeable"] == "MERGEABLE":
                mergeable = "yes"
            if pull["mergeable"] == "CONFLICTING":
                mergeable = "conflicts"
            labels = [label["name"] for label in pull["labels"]["nodes"]]

            # What its agent hears a change of (needs_reply).
            signals = {
                "state": pull["state"].lower(),
                "draft": pull["isDraft"],
                "title": pull["title"],
                "head": head["sha"] if head is not None else None,
                "checks": checks,
                "mergeable": mergeable,
                "labels": sorted(labels),
                "bot_at": bot_activity["at"] if bot_activity is not None else None,
            }

            issues = []
            for issue in pull["closingIssuesReferences"]["nodes"]:
                reason = None
                if issue["stateReason"] is not None:
                    reason = issue["stateReason"].lower()
                issues.append({
                    "number": issue["number"],
                    "title": issue["title"],
                    "url": issue["url"],
                    "state": issue["state"].lower(),
                    "reason": reason,
                    "assignees": [person["login"] for person in issue["assignees"]["nodes"]],
                })

            record = {
                "id": pr_id,
                "repo": repo,
                "number": number,
                "title": pull["title"],
                "url": pull["url"],
                "author": author,
                "state": pull["state"].lower(),
                "draft": pull["isDraft"],
                "opened_at": pull["createdAt"],
                "updated_at": pull["updatedAt"],
                "closed_at": pull["closedAt"],
                "merged_by": pull["mergedBy"]["login"] if pull["mergedBy"] else None,
                "labels": labels,
                "checks": checks,
                "waiting_runs": waiting_runs,
                "review": review,
                "reviewers": list(latest.values()),
                "comments": pull["comments"]["totalCount"],
                "last_comment": last_comment,
                "issues": issues,
                "relation": link["relation"],
                "head": head,
                "base": pull["baseRefName"],
                "mergeable": mergeable,
                "last_activity": last_activity,
                "your_last_at": your_last_at,
                "bot_activity": bot_activity,
                "signals": signals,
                "draft_id": link["draft_id"],
                "job": link["job"],
                "agent": agent,
                "agent_mode": agent_mode,
                "checked_at": now,
                "error": None,
            }
            with self.lock:
                self.data["prs"][pr_id] = record
                # The first read is where its agent starts from: it only hears what changes after. A conflict it has
                # already is still news: it has to be settled before the PR can be merged.
                empty = {"mode": None, "agent": None, "answered_at": None, "failed_sha": None, "told": None}
                setting = self.data["agent_settings"].setdefault(pr_id, empty)
                if setting.get("told") is None:
                    setting["told"] = copy.deepcopy(signals)
                    setting["told"]["mergeable"] = "unknown"
                self.save()

        for issue_id, link in follow_issues.items():
            repo = issue_id.split("#")[0]
            owner = repo.split("/")[0]
            name = repo.split("/")[1]
            number = int(issue_id.split("#")[1])
            now = datetime.now(UTC).isoformat()

            # Who follows it: the agent you picked for it, else the one whose comment the app posted there.
            agent = link["agent"]
            agent_mode = "off"
            if agent is not None:
                agent_mode = "drafts"
            with self.lock:
                setting = self.data["agent_settings"].get(issue_id)
                if setting is not None and setting["mode"] is not None:
                    agent = setting["agent"]
                    agent_mode = setting["mode"]
                known = {"relation": link["relation"], "agent": agent, "agent_mode": agent_mode}
                # A closed issue that didn't change since it was last read isn't read again.
                old = self.data["issues"].get(issue_id)
                unchanged = old is not None and old["state"] != "open" and old["error"] is None and old["updated_at"] == link["updated"]
                if unchanged:
                    old.update(known)
            if unchanged:
                continue

            try:
                issue = get_issue_status(owner, name, number)
                if issue is None:
                    raise ValueError("GitHub has no such issue anymore.")
            except Exception as problem:
                with self.lock:
                    if issue_id in self.data["issues"]:
                        self.data["issues"][issue_id].update(known)
                        self.data["issues"][issue_id]["error"] = str(problem)
                        self.data["issues"][issue_id]["checked_at"] = now
                        self.save()
                continue

            # The comments come oldest first: the newest is the last.
            last_comment = None
            if issue["comments"]["nodes"]:
                comment = issue["comments"]["nodes"][-1]
                login = comment["author"]["login"] if comment["author"] else "ghost"
                role = comment["authorAssociation"]
                if comment["author"] is not None and comment["author"]["__typename"] == "Bot":
                    role = "BOT"
                text = " ".join(comment["body"].split())
                if len(text) > COMMENT_CHARS:
                    text = text[:COMMENT_CHARS - 1] + "…"
                last_comment = {"login": login, "role": role, "at": comment["createdAt"], "text": text}

            # The newest comment by someone other than you, and your newest. Bots never count.
            last_activity = None
            your_last_at = None
            for comment in issue["comments"]["nodes"]:
                if comment["author"] is None or comment["author"]["__typename"] == "Bot" or comment["author"]["login"].endswith("[bot]"):
                    continue
                login = comment["author"]["login"]
                at = comment["createdAt"]
                if login == you and (your_last_at is None or at > your_last_at):
                    your_last_at = at
                if login != you and (last_activity is None or at > last_activity["at"]):
                    last_activity = {"login": login, "at": at, "what": "comment"}

            # Why it was closed: completed, not_planned or duplicate. GitHub also says reopened on a reopened one.
            reason = None
            if issue["state"] == "CLOSED" and issue["stateReason"] is not None:
                reason = issue["stateReason"].lower()

            record = {
                "id": issue_id,
                "repo": repo,
                "number": number,
                "title": issue["title"],
                "url": issue["url"],
                "author": issue["author"]["login"] if issue["author"] else "ghost",
                "state": issue["state"].lower(),
                "reason": reason,
                "opened_at": issue["createdAt"],
                "updated_at": issue["updatedAt"],
                "closed_at": issue["closedAt"],
                "labels": [label["name"] for label in issue["labels"]["nodes"]],
                "assignees": [person["login"] for person in issue["assignees"]["nodes"]],
                "comments": issue["comments"]["totalCount"],
                "last_comment": last_comment,
                "relation": link["relation"],
                "last_activity": last_activity,
                "your_last_at": your_last_at,
                "agent": agent,
                "agent_mode": agent_mode,
                "checked_at": now,
                "error": None,
            }
            with self.lock:
                self.data["issues"][issue_id] = record
                self.save()

        with self.lock:
            # Only the ones still followed: one the searches no longer find goes too, unless a search failed.
            for pr_id in list(self.data["prs"]):
                if pr_id not in follow_prs and error is None:
                    del self.data["prs"][pr_id]
            for issue_id in list(self.data["issues"]):
                if issue_id not in follow_issues and error is None:
                    del self.data["issues"][issue_id]
            self.data["checked_at"] = datetime.now(UTC).isoformat()
            self.data["error"] = error
            self.save()
