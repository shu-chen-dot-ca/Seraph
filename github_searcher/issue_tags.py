"""The tags the app puts on issues, the same on the Tracked and Issues pages: free or assigned, how hard, what kind.

GitHub's own labels are spelled differently in every repo ("good first issue", "good-first-issue", "help wanted",
"effort/small", "kind/bug", ...) and are mostly noise to the user, so the pages don't show them. Claude reads
each issue instead and gives it tags we define. One JSON file, DATA_DIR/issue_tags.json, by issue id:

    {"owner/name#n": {"status": "free" | "assigned" | "waiting", "level": "easy" | "medium" | "hard" | None,
                      "checks": {"clear", "runs_in_vm", "visible", "checkable", "general", "contained": bool} | None,
                      "kind": "bug" | "feature" | "docs" | "question" | None, "reason", "updated_at", "judged_at"}, ...}

status weighs everything about who may take it: assignees, open pull requests that would close it, the labels
(good first issue, help wanted and the like invite outside contributors), what the issue template says about the
author fixing it themselves ("Are you willing to submit a PR?"), claims in the comments, and whether the maintainers
want it done. free: anyone can start on it now. assigned: someone is on it.
waiting: nobody is, but it isn't ready (it needs a decision, a design, more information).

level is how hard the fix is for us: our agent writing it in its sandbox VM, then seeing and proving it works there.
It is decided by fixed rules, not by Claude's feel: Claude answers the yes / no questions in CHECKS (checks), and the
level follows from them. easy: every answer is yes, so the agent can vibe code it, see the effect and prove it in the
VM. hard: it can't be run in our VM, the fix touches code where a change ripples, or two or more answers are no.
medium: one answer is no. reason is Claude's plain sentence on the status, then a line on the level that says which
checks failed. An issue with an assignee on GitHub is assigned without asking Claude; its level, checks and kind stay
None.

Issues go in batches, not one Claude run each: up to BATCH issues of one repo take one GitHub call, and as many
of them as fit in CHARS_PER_RUN take one Claude run, the repo said once; AT_ONCE batches run at the same time.
Claude reads the comments before deciding: all of them up to 30, else the first 5 and the last 30, each cut to
COMMENT_CHARS (a bot's to BOT_CHARS). It also sees every pull request tied to the issue, open, closed or merged:
the ones that say they close it, and the ones that only mention it or were linked by hand, each with its last
comment (often why it was closed). Without those, a claim followed by a pull request that was then rejected
looked like a claim with no pull request at all. Bodies are cut to BODY_CHARS, but the template's part about the author
fixing it themselves (WILLING finds it) is always kept. updated_at is the issue's last change on GitHub when it
was tagged: when that changes, the backend tags it again, and a free one every hour anyway (backend/issues_api.py).
The level is kept once given: the checks and kind stay from one read to the next while the issue hasn't changed on
GitHub (Claude is told, and the old ones are kept even if it answers otherwise), so a refresh doesn't flip easy and
medium; only the status is judged afresh every time. When the issue changed, Claude sees the old answers and keeps
them unless what is new shows otherwise. Tags from before the rules (no checks) are judged afresh once, by the
backend on its own. Cost isn't a
concern here: Claude reads at high effort, CHARS_PER_RUN of issues a run. judged_at is when it was last read.

Kept apart from the lists on purpose, like issue_facts.py: undo/redo of a list shouldn't undo tags, and an issue
that comes back with an undo keeps its tags. version goes up on every change.
"""

import asyncio
import copy
import json
import os
import re
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.claude_judge import judge
from github_searcher.search import get_issues_for_tags

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Where our agent fixes an issue (sandbox/): the prompt says so, since the checks are about this setup.
SANDBOX = (
    "Our agent (Claude Code) fixes the issue inside a sandbox VM: a Linux desktop (Ubuntu, Debian or Fedora) with a "
    "shell, mouse and keyboard, a browser, Docker and internet, 2 to 16 CPUs, up to 16 GB of RAM, and an NVIDIA GPU when "
    "one is handed in. It clones the repo, reproduces the problem, writes the fix, runs the project's tests before and "
    "after, and takes screenshots or command output as proof."
)
# The yes / no questions the level is decided from: (key, question, what it means when the answer is no).
CHECKS = [
    (
        "clear",
        "Is it clear what done looks like: the wanted behavior or change is stated or obvious, with no design choice left "
        "for the maintainers?",
        "what done looks like isn't settled",
    ),
    (
        "runs_in_vm",
        "Can the project be built and the problem be reproduced in our VM? No when it needs macOS, Windows or a phone, "
        "hardware other than one NVIDIA GPU, a paid service, an account or an API key, several machines, or a build that "
        "takes hours.",
        "can't be run in our VM",
    ),
    (
        "visible",
        "Can the problem, and later the fix, be seen plainly in the VM: a failing test, an error or wrong output from a "
        "command, or a wrong screen in an app or a page?",
        "its effect is hard to see",
    ),
    (
        "checkable",
        "Would a short test or one plain look at the result prove it is fixed, with the project's own tests runnable in "
        "the VM?",
        "hard to prove it is fixed",
    ),
    (
        "general",
        "Is general programming knowledge enough: no deep knowledge of this project's internals or of its field (a "
        "protocol, a file format, math, compilers, ...) beyond reading the code around it?",
        "needs knowledge of the project or its field",
    ),
    (
        "contained",
        "Does the fix stay local, away from central or shared code where a change can ripple: public API, data formats, "
        "concurrency, security, performance, numerical accuracy, platform differences?",
        "touches code where a change can ripple",
    ),
]
# Issues of one repo per GitHub call; the text of as many as fit in CHARS_PER_RUN goes in one Claude run.
BATCH = 20
CHARS_PER_RUN = 50_000
# Batches tagged at the same time.
AT_ONCE = 3
BODY_CHARS = 2000
COMMENT_CHARS = 1000
BOT_CHARS = 200
PULL_COMMENT_CHARS = 400
REASON_CHARS = 240
EFFORT = "high"
# A line where an issue template asks whether the author will fix it themselves: "Are you willing to submit a PR?",
# "Would you like to work on this?", "I'm interested in implementing this", ... The line and the next few (the answer) are kept.
WILLING = re.compile(
    r"willing|submit a (pr|pull request|fix)|open a (pr|pull request)|work on (this|it)|implement(ing)? (this|it)|contribut\w* a (fix|pr)",
    re.IGNORECASE,
)
# The <!-- hints --> issue templates are full of: they say nothing about the issue.
TEMPLATE_HINT = re.compile(r"<!--.*?-->", re.DOTALL)
SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "number": {"type": "integer"},
                    "status": {"type": "string", "enum": ["free", "assigned", "waiting"]},
                    "kind": {"type": "string", "enum": ["bug", "feature", "docs", "question"]},
                    "reason": {"type": "string"},
                    "clear": {"type": "boolean"},
                    "runs_in_vm": {"type": "boolean"},
                    "visible": {"type": "boolean"},
                    "checkable": {"type": "boolean"},
                    "general": {"type": "boolean"},
                    "contained": {"type": "boolean"},
                },
                "required": ["number", "status", "kind", "reason", "clear", "runs_in_vm", "visible", "checkable", "general", "contained"],
            },
        }
    },
    "required": ["issues"],
}


class IssueTags:
    def __init__(self):
        self.path = DATA_DIR / "issue_tags.json"
        self.lock = threading.Lock()
        self.version = 0
        self.tags = {}
        if self.path.exists():
            self.tags = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the tags to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.tags))
        temporary.replace(self.path)

    def all(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.tags)

    async def tag(self, ids: list[str]) -> list[str]:
        """Tag these issues ("owner/name#n", any repos) and keep the tags. Returns the ids tagged.

        By repo, BATCH at a time, AT_ONCE batches at the same time; each batch is kept as soon as it is done.
        An issue is left out of the result when its batch failed (GitHub or Claude), it is gone, or Claude skipped it.
        """
        # {"owner/name": [number, ...]}
        by_repo = {}
        for issue_id in ids:
            name = issue_id.split("#")[0]
            if name not in by_repo:
                by_repo[name] = []
            by_repo[name].append(int(issue_id.split("#")[1]))
        batches = []
        for name, numbers in by_repo.items():
            for start in range(0, len(numbers), BATCH):
                batches.append((name, numbers[start:start + BATCH]))

        tagged = []
        for start in range(0, len(batches), AT_ONCE):
            group = batches[start:start + AT_ONCE]
            results = await asyncio.gather(*[self.tag_batch(name, numbers) for name, numbers in group], return_exceptions=True)
            for result in results:
                if not isinstance(result, Exception):
                    tagged.extend(result)
        return tagged

    async def tag_batch(self, full_name: str, numbers: list[int]) -> list[str]:
        """Tag some issues of one repo ("owner/name", at most BATCH numbers) and keep the tags. Returns the ids tagged.

        Raises httpx.HTTPError or ValueError when GitHub fails, JudgeError when Claude gives no usable answer
        (the Claude runs done before it are kept).
        """
        owner = full_name.split("/")[0]
        repo = full_name.split("/")[1]
        data = await asyncio.to_thread(get_issues_for_tags, owner, repo, numbers)
        now = datetime.now(UTC).isoformat()
        found = {}
        texts = []
        updated = {}
        # {number: (checks, kind)}: read before and unchanged since, so those stay (and so the level).
        kept = {}
        for number in numbers:
            issue = data.get(f"i{number}")
            if issue is None:
                continue
            issue_id = f"{full_name}#{number}"
            # Someone has it on GitHub: no need to ask.
            assignees = [user["login"] for user in issue["assignees"]["nodes"]]
            if assignees:
                reason = f"Assigned on GitHub to {', '.join(assignees)}."
                found[issue_id] = {"status": "assigned", "level": None, "checks": None, "kind": None, "reason": reason, "updated_at": issue["updatedAt"], "judged_at": now}
                continue
            updated[number] = issue["updatedAt"]

            author = issue["author"]["login"] if issue["author"] else "ghost"
            labels = ", ".join(label["name"] for label in issue["labels"]["nodes"]) or "none"
            body = TEMPLATE_HINT.sub("", issue["body"] or "").strip()
            body = re.sub(r"\n\s*\n+", "\n\n", body)
            text = f"=== #{number}: {issue['title']} ===\nOpened {issue['createdAt'][:10]} by {author} ({issue['authorAssociation']}). Labels: {labels}.\n"
            if issue["state"] != "OPEN":
                text += "It is closed.\n"

            # Every pull request tied to it, once each: the ones that say they close it, then the ones that mention it
            # or were linked to it by hand. By repo and number: a PR in another repo can mention it too.
            pulls = {}
            for pull in issue["closedByPullRequestsReferences"]["nodes"]:
                pulls[(pull["repository"]["nameWithOwner"], pull["number"])] = (pull, "says it closes it")
            for event in issue["timelineItems"]["nodes"]:
                pull = event.get("source") or event.get("subject")
                if pull is None or pull["__typename"] != "PullRequest":
                    continue
                how = "mentions it"
                if event["__typename"] == "ConnectedEvent":
                    how = "was linked to it"
                if (pull["repository"]["nameWithOwner"], pull["number"]) not in pulls:
                    pulls[(pull["repository"]["nameWithOwner"], pull["number"])] = (pull, how)
            if not pulls:
                text += "No pull request is tied to it.\n"
            for (pull_repo, pull_number), (pull, how) in pulls.items():
                where = f"#{pull_number}"
                if pull_repo != full_name:
                    where = f"{pull_repo}#{pull_number}"
                pull_author = pull["author"]["login"] if pull["author"] else "ghost"
                text += f"Pull request {where} by {pull_author} {how}: opened {pull['createdAt'][:10]}, "
                if pull["state"] == "OPEN":
                    text += f"still open, last updated {pull['updatedAt'][:10]}."
                elif pull["state"] == "MERGED":
                    text += f"merged {(pull['closedAt'] or '')[:10]}."
                else:
                    text += f"closed without merging {(pull['closedAt'] or '')[:10]}."
                for comment in pull["comments"]["nodes"]:
                    commenter = comment["author"]["login"] if comment["author"] else "ghost"
                    words = " ".join(comment["body"].split())
                    text += f" Its last comment, by {commenter} ({comment['authorAssociation']}): {words[:PULL_COMMENT_CHARS]}"
                text += "\n"
            text += "\n" + (body[:BODY_CHARS] if body else "(no description)")
            # The template's part about the author fixing it, when the cut left it out.
            if len(body) > BODY_CHARS:
                text += " […cut]"
                lines = body.splitlines()
                for index, line in enumerate(lines):
                    if WILLING.search(line):
                        text += "\n\nFrom the rest of the template:\n" + "\n".join(lines[index:index + 4])

            # Every comment up to 30; past that the first 5 and the last 30, and how many were left out between them.
            latest = issue["latest"]["nodes"]
            total = issue["latest"]["totalCount"]
            skipped = total - len(latest)
            earliest = issue["earliest"]["nodes"][:skipped]
            if total == 0:
                text += "\n\nNo comments."
            elif skipped == 0:
                text += f"\n\nAll {total} comments:"
            else:
                text += f"\n\n{total} comments, the first {len(earliest)} and the last {len(latest)}:"
            for index, comment in enumerate(earliest + latest):
                if index == len(earliest) and skipped > len(earliest):
                    text += f"\n[… {skipped - len(earliest)} comments left out here …]"
                commenter = "ghost"
                limit = COMMENT_CHARS
                if comment["author"] is not None:
                    commenter = comment["author"]["login"]
                    if comment["author"]["__typename"] == "Bot":
                        commenter += ", a bot"
                        limit = BOT_CHARS
                text += f"\n--- {commenter} ({comment['authorAssociation']}), {comment['createdAt'][:10]}:\n{comment['body'][:limit]}"

            # Read before by the rules: its checks and kind stay while nothing changed on GitHub, so the level doesn't flip
            # between reads. Tags from before the rules (no checks) are judged afresh.
            with self.lock:
                before = self.tags.get(issue_id)
            if before is not None and before.get("checks"):
                answers = ", ".join(f"{key} {'yes' if value else 'no'}" for key, value in before["checks"].items())
                if before["updated_at"] == issue["updatedAt"]:
                    kept[number] = (before["checks"], before["kind"])
                    text += f"\n\nRead before: {answers}; kind {before['kind']}. Nothing changed since: give the same answers."
                else:
                    text += f"\n\nRead before: {answers}; kind {before['kind']}. It changed since: keep those answers unless what is new shows otherwise."
            texts.append(text)

        # As many issues per Claude run as fit in CHARS_PER_RUN.
        runs = []
        run = []
        size = 0
        for text in texts:
            if run and size + len(text) > CHARS_PER_RUN:
                runs.append(run)
                run = []
                size = 0
            run.append(text)
            size += len(text)
        if run:
            runs.append(run)

        # The ones assigned on GitHub are kept at once, each run's answers as soon as they come.
        with self.lock:
            self.tags.update(found)
            self.save()
        language = data["primaryLanguage"]["name"] if data["primaryLanguage"] else "an unknown language"
        for run in runs:
            prompt = (
                f"Below are {len(run)} issues of the GitHub project {data['nameWithOwner']} ({data['stargazerCount']} stars, "
                f"written in {language}): {data['description'] or 'no description'}\n\n"
                "Tag each one for a capable programmer who is new to the project and is looking for an issue to fix. "
                "Read each issue's comments to the end before deciding: they often change the answer.\n\n"
                "status: who may take it. Weigh everything together: the labels ('good first issue', 'help wanted' and the like "
                "invite outside contributors, but they are a hint, not the answer); who opened it; what the issue template says "
                "about the author fixing it themselves (a checked 'I am willing to submit a PR' or a 'Yes' there means the author "
                "means to do it); what the comments say (someone asking to take it or saying they are on it, a maintainer handing "
                "it out or turning people down, a pull request or a fix mentioned, a maintainer saying it isn't wanted); and the "
                "pull requests tied to it, listed under the issue with their state and last comment.\n"
                "- assigned: someone is on it: the author said they will fix it, a commenter claimed it and was not turned down, "
                "a maintainer gave it to someone, or one of its pull requests is open and alive. A claim in the comments holds for "
                "about two months even with no pull request yet, unless that person gave up or a maintainer opened it to others; "
                "an open pull request untouched for months doesn't count.\n"
                "  A pull request closed without merging ends its author's claim: read its last comment for why (for example "
                "closed under the project's AI policy, or the approach was turned down) and say so in the reason when it matters. "
                "A merged one usually means it is fixed and only needs closing: then waiting. Never say that no pull request "
                "came when the issue lists one.\n"
                "- free: nobody is on it and a newcomer could start now: it is a real, accepted problem or a wanted change, the "
                "outcome wanted is clear, and nothing waits on the maintainers.\n"
                "- waiting: nobody is on it, but it isn't ready to pick up: it needs a maintainer's decision or a design, more "
                "information or a reproduction, or the maintainers keep it for themselves.\n\n"
                f"The checks, for how hard it is for us to fix. {SANDBOX} Answer each one yes (true) or no (false) on its own, "
                "from what the issue and its comments say; when it is unclear, answer no.\n"
                + "".join(f"- {key}: {question}\n" for key, question, failed in CHECKS)
                + "\n"
                "kind: bug, feature (new behavior or an improvement), docs, or question (a support question, nothing to fix).\n\n"
                "reason: one short, plain sentence on why it has that status, at most 160 characters (no file or function "
                "names).\n\n"
                "Answer for every issue, by its number.\n\n" + "\n\n".join(run)
            )
            answer = await judge(prompt, SCHEMA, EFFORT)
            answered = {}
            for item in answer["issues"]:
                # Only the issues asked about.
                if item["number"] not in updated:
                    continue
                reason = item["reason"].strip()
                if len(reason) > REASON_CHARS:
                    reason = reason[:REASON_CHARS - 1].rstrip() + "…"
                checks = {}
                for key, question, failed in CHECKS:
                    checks[key] = item[key]
                kind = item["kind"]
                if item["number"] in kept:
                    checks = kept[item["number"]][0]
                    kind = kept[item["number"]][1]
                # The level by the rules: every check yes is easy; not runnable in our VM, a rippling change, or two or
                # more checks no is hard; one is medium.
                failures = [failed for key, question, failed in CHECKS if not checks.get(key)]
                level = "medium"
                if not failures:
                    level = "easy"
                elif not checks.get("runs_in_vm") or not checks.get("contained") or len(failures) >= 2:
                    level = "hard"
                if level == "easy":
                    reason += " Easy: our agent can write it, see it and prove it in the VM."
                else:
                    reason += f" {level.capitalize()}: {'; '.join(failures)}."
                answered[f"{full_name}#{item['number']}"] = {
                    "status": item["status"],
                    "level": level,
                    "checks": checks,
                    "kind": kind,
                    "reason": reason,
                    "updated_at": updated[item["number"]],
                    "judged_at": datetime.now(UTC).isoformat(),
                }
            with self.lock:
                self.tags.update(answered)
                self.save()
            found.update(answered)
        return list(found)
