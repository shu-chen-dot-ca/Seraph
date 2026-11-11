"""The tags the app puts on issues, the same on the Tracked and Issues pages: free or assigned, whether a pull
request from us would get merged (or out of scope), what kind, about how many lines the fix changes.

GitHub's own labels are spelled differently in every repo ("good first issue", "good-first-issue", "help wanted",
"effort/small", "kind/bug", ...) and are mostly noise to the user, so the pages don't show them. Claude reads
each issue instead and gives it tags we define. One JSON file, DATA_DIR/issue_tags.json, by issue id:

    {"owner/name#n": {"status": "free" | "assigned" | "waiting" | "fixed",
                      "merge": "likely" | "fixed" | "out of scope" | "claimed" | "maintainers only" | "waiting" |
                               "no outside prs" | "large feature" | "big change" | "can't validate",
                      "checks": {"belongs", "linux", "apolitical", "not_game", "open", "modest", "validatable": bool} | None,
                      "kind": "bug" | "feature" | "docs" | "question" | None, "lines": int | None,
                      "name": str | None, "name_version": int, "rules_version": int, "complexity": "easy" | "medium" | "hard" | None, "scope_clear": bool | None,
                      "reason", "updated_at", "judged_at"}, ...}

status weighs everything about who may take it: assignees, open pull requests that would close it, the labels
(good first issue, help wanted and the like invite outside contributors), what the issue template says about the
author fixing it themselves ("Are you willing to submit a PR?"), the author saying they will send the PR (also once a
maintainer confirms), claims in the comments, and whether the maintainers want it done. A fix posted in the issue or
a comment, even with no pull request (a branch in someone's fork, a patch, the whole change or its test, "my account
can't open PRs, a maintainer can open one from it"), counts as someone on it: we don't build on or race another
person's fix. So does a problem found in code that only someone else's open pull request or unmerged feature branch has
(a QA finding on it, its environment that branch): the fix belongs in that pull request, and main has nothing to fix
(open-mercato#8416 and its siblings, all on #8268). free: the user can take it up now. assigned: someone else is on it. The user's own claims, assignment
and pull requests (and our agents', made as the user) never count: status is about other people, so the user's own work
in progress stays free. rules_version is RULES_VERSION when it was read: when these rules change it goes up, and every
issue is read again once.
waiting: nobody is, but it isn't ready (it needs a decision, a design, more information; a feature request no
maintainer has said yes to, by a comment or a label like help wanted, is waiting too; so is one that builds on a pull
request still open, a follow-up from its review, one that builds on another issue still open (tabularis#1410 reuses
what #1409's open pull request adds), and one whose triage note leaves questions for the maintainers). A label
that says it still waits for the maintainers' triage or approval (TRIAGE: "status: needs triage", "needs approval",
"untriaged") makes it waiting whatever Claude says. fixed: a merged pull request
or a commit on the default branch already does what it asks, and it only needs closing (GitHub leaves an issue open
when the PR said "Addresses #n" instead of "Fixes #n"; the commits that mention it show that, see search.py).

merge is whether a pull request from us would get merged: not how hard the code is (our agent writes hard code), but
what stood in the way of the ones that went badly. It is decided by fixed rules, not by Claude's feel: from Claude's
yes / no answers to CHECKS (checks), the status, the repo's numbers (repo_signals.py) and how many of the user's pull
requests the repo merged. The first that holds:
    fixed             status fixed: already done, it only needs closing
    out of scope      it touches politics (in the issue or in what the repo is for: we only do non-political work,
                      nothing politically sensitive or activist, nothing against another country's laws, such as
                      China's), it is about a game (we don't work on games: no game, game engine, mod, game server or
                      plugin, emulator or ROM manager, or tool for playing games), it isn't a pull request to this repo
                      for its own users (a plugin or add-on for a third-party product's users, a separate repository
                      the project wants), or it can't be seen on
                      Linux (it is about how something looks or behaves on Windows, macOS, a phone or other hardware,
                      even when its files can be edited on Linux: we have no way to validate it)
    claimed           someone is on it (status assigned)
    maintainers only  the maintainers keep it for themselves
    waiting           it isn't ready to pick up (status waiting)
    no outside prs    the repo doesn't merge outsiders' pull requests: its AI policy says no AI, most newcomers' first
                      PRs are closed or left waiting, of MIN_SAMPLE or more outside PRs that ended in 90 days none
                      was merged, or the newcomer verdict (repo_signals.py) is closed: its contributing guide says so,
                      or its people write the code (mastra: pull requests disabled for outside contributors)
    large feature     a new subsystem, integration, driver or the like the maintainers would have to keep up
    big change        over BIG_LINES lines while the user has no merged pull request in the repo yet
    can't validate    our agent can't prove the fix works in its VM (long builds and tests are fine)
    likely            none of these
Agents only pick likely ones. Nobody can assign one that is fixed, out of scope or can't validate, nor one with no
merge yet (backend/issues_api.py): a job we can't prove ends with nothing to show. merge is worked out again every time an issue is read, so a claim, a change in the
repo's numbers or the user's first merged PR there shows at the next read. reason is Claude's plain sentence on the
status, then "Merge: <label>, <why>." An issue with an assignee on GitHub is claimed without asking Claude; its checks
and kind stay None. So is one with someone else's open pull request that says it closes it (GitHub's closing reference),
updated in the last TAKEN_PR_DAYS days: its maintainers don't want a second fix. An older one may be abandoned: Claude
weighs that.

Issues go in batches, not one Claude run each: up to BATCH issues of one repo take one GitHub call, and as many
of them as fit in CHARS_PER_RUN take one Claude run, the repo said once; AT_ONCE batches run at the same time.
Claude reads the comments before deciding: all of them up to 30, else the first 5 and the last 30, each cut to
COMMENT_CHARS (a bot's to BOT_CHARS) by keeping its start and its end, where a conclusion often is ("Not implementing
until a maintainer accepts the direction"). It also sees every pull request tied to the issue, open, closed or merged:
the ones that say they close it, and the ones that only mention it or were linked by hand, each with its last
comment (often why it was closed), and the pull requests and issues its description mentions (search.py MENTION), with
their state (an issue's with the open pull requests that would close it). Without those, a claim followed by a pull request that was then rejected
looked like a claim with no pull request at all. Bodies are cut to BODY_CHARS, but the template's part about the author
fixing it themselves (WILLING finds it) is always kept. updated_at is the issue's last change on GitHub when it
was tagged: when that changes, the backend tags it again, and a free one every hour anyway (backend/issues_api.py).
The checks are kept once given: they and the kind stay from one read to the next while the issue hasn't changed on
GitHub (Claude is told, and the old ones are kept even if it answers otherwise), so the background's reads don't flip
the merge; only the status is judged afresh every time. A forced read (force: the pages' Refresh and Tag again) keeps
nothing: Claude answers everything afresh, with no word of the old answers. When the issue changed, Claude sees the old answers and keeps
them unless what is new shows otherwise. lines is Claude's rough guess of the fix's size: the lines its pull request
adds and removes together, tests included (0 when there is nothing to change); it is kept like the checks, and is
None when the issue is assigned on GitHub. Tags from before merge (with a level: easy, medium or hard) are read again
once, by the backend on its own, and so are tags from before a check was added: their answers to checks still in
CHECKS are kept like any others, a new check takes Claude's new answer.
name is the issue's short name for the Dashboard's Issues board, one line: what our agent has to do, as a short
command starting with a verb ("Fix SQL query logic", "Add compact table view"), in general software words any engineer
understands without knowing the project: no names of the project's own features, components or products; no "Bug:" or
"Feat:" in front. NAME_EXAMPLES show Claude the style. Once given it stays (a forced read names it again), so a card keeps its name. name_version is
NAME_VERSION when it was given: when the naming rules change NAME_VERSION goes up, and every name from before is made
again, once. None when the issue is assigned on GitHub (the board shows the GitHub title then).
complexity (easy, medium or hard: how hard the fix is for a capable programmer new to the project) and scope_clear
(whether what to change and what done looks like are clear) are for the board's cards too. Both stay while the issue
hasn't changed on GitHub (a forced read asks again), and are None when it is assigned on GitHub; tags from before
them are read again once for them.
Cost isn't a concern here: Claude reads at high effort, CHARS_PER_RUN of issues a run. judged_at is when it was last
read.

Kept apart from the lists on purpose, like issue_facts.py: undo/redo of a list shouldn't undo tags, and an issue
that comes back with an undo keeps its tags. version goes up on every change.
"""

import asyncio
import copy
import json
import os
import re
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.claude_judge import judge
from github_searcher.repo_signals import MIN_SAMPLE
from github_searcher.search import MENTION, get_issues_for_tags

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Where our agent fixes an issue (sandbox/): the prompt says so, since the checks are about this setup.
SANDBOX = (
    "Our agent (Claude Code) fixes the issue inside a sandbox VM: a Linux desktop (Ubuntu, Debian or Fedora) with a "
    "shell, mouse and keyboard, a browser, Docker and internet, 2 to 16 CPUs, up to 32 GB of RAM, and an NVIDIA GPU when "
    "one is handed in. It clones the repo, reproduces the problem, writes the fix, runs the project's tests before and "
    "after, and takes screenshots or command output as proof."
)
# The yes / no questions merge is decided from (with the status, the repo's numbers and the user's merged pull
# requests there): (key, question).
CHECKS = [
    (
        "belongs",
        "Does the work belong in this repo as a pull request, for the project's own users? No when it is a plugin, "
        "extension, integration, theme or add-on meant for the users of a third-party product, or when the project wants "
        "it as a new, separate repository (a plugin, driver or port it keeps outside its main code).",
    ),
    (
        "linux",
        "Can the problem and the fix be seen on Linux, in our VM? No when it is about how something looks or behaves on "
        "Windows, macOS, a phone or hardware other than one NVIDIA GPU (a Windows taskbar or installer icon, a macOS menu, "
        "a phone layout, a Windows-only path or setting), even when the files it changes can be edited or looked at on "
        "Linux: seeing the file isn't seeing the effect.",
    ),
    (
        "apolitical",
        "Is it free of politics, in the issue and in what the repo is for? We only do non-political work: nothing "
        "political, politically sensitive or activist, and nothing that goes against another country's laws, such as "
        "China's.",
    ),
    (
        "not_game",
        "Is it free of games, in the issue and in what the repo is for? We don't work on games: no game, game engine, "
        "game mod, game server or plugin for one, emulator or ROM manager, or tool made for playing games (like a "
        "launcher or a compatibility layer for running games).",
    ),
    (
        "open",
        "Is it open to an outside contributor: no sign the maintainers keep it for themselves? No when a maintainer said "
        "they or the core team will do it, it is a roadmap item one of them owns, it is labeled for maintainers or "
        "internal work, or the maintainers said they don't want outside pull requests for it. Someone who acts for the "
        "project (triages, labels or assigns its issues, answers for it) counts as a maintainer even when their role shows "
        "CONTRIBUTOR or NONE: an organization's members often keep that hidden. So 'this will be handled by the internal "
        "team' from them is a no, unless a maintainer opened it to others later.",
    ),
    (
        "modest",
        "Is it a fix or a modest change, not a large new feature? No when it adds a new subsystem, integration, driver, "
        "backend, file format or major screen that the maintainers would have to keep up after it lands.",
    ),
    (
        "validatable",
        "Can our agent prove the fix works in its VM: build the project, see the problem (a failing test, an error or "
        "wrong output, a wrong screen) or the missing behavior, then show it fixed with a test or a plain look? Long builds "
        "and long test suites are fine. No when it needs a paid service, an account or an API key, or several machines, "
        "or when nothing it can run or look at would show that it works.",
    ),
]
# Lines over which a change is big for someone with no merged pull request in the repo yet.
BIG_LINES = 200
# Someone else's open pull request that says it closes an issue, updated in this many days, means someone is on it.
TAKEN_PR_DAYS = 30
# How each merge value reads, in the reason (the pages have the same labels).
MERGE_LABEL = {
    "likely": "Likely",
    "fixed": "Fixed",
    "out of scope": "Out of scope",
    "claimed": "Claimed",
    "maintainers only": "Maintainers only",
    "waiting": "Waiting",
    "no outside prs": "No outside PRs",
    "large feature": "Large feature",
    "big change": "Big change",
    "can't validate": "Can't validate",
}
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
# The short name: at most this long, and how it should read: general words, nothing only the project's people know.
NAME_CHARS = 60
NAME_EXAMPLES = [
    "Fix SQL query logic",
    "Fix retry on server overload",
    "Fix crash on JSON array input",
    "Fix project detection in setup",
    "Fix audio label timing",
    "Add compact table view",
    "Add text editing for binary fields",
    "Add settings via HTTP headers",
    "Add OAuth sign-in to web UI",
    "Update install docs",
]
# Goes up when the naming rules change: every name from before is made again, once.
NAME_VERSION = 3
# Goes up when the status rules change: every issue is read again, once (3: an author who says they will send the PR, or
# a fix posted in the issue's description, is someone on it; mcp-memory-service#1910. 4: waiting for triage or approval
# is waiting, and a closed newcomer verdict is no outside prs; mastra#28528. 5: the pull requests its description mentions,
# a long comment's end, a follow-up to an open pull request and a triage note's open questions are waiting;
# runanywhere-sdks#1191, oh-my-pi#17037. 6: a problem in code only an open pull request has is someone on it, an issue
# that builds on another open issue is waiting, and the internal team taking it is maintainers only, whatever the
# speaker's role shows; open-mercato#8416, tabularis#1410, kestra#14059).
RULES_VERSION = 6
EFFORT = "high"
# A line where an issue template asks whether the author will fix it themselves: "Are you willing to submit a PR?",
# "Would you like to work on this?", "I'm interested in implementing this", ... The line and the next few (the answer) are kept.
WILLING = re.compile(
    r"willing|submit a (pr|pull request|fix)|open a (pr|pull request)|work on (this|it)|implement(ing)? (this|it)|contribut\w* a (fix|pr)",
    re.IGNORECASE,
)
# The <!-- hints --> issue templates (and bots' comments) are full of: they say nothing about the issue.
TEMPLATE_HINT = re.compile(r"<!--.*?-->", re.DOTALL)
# A label that says an issue still waits for the maintainers' triage or approval ("status: needs triage", "needs-approval",
# "untriaged"): mastra's bot asks for no PR until it is removed (mastra#28528).
TRIAGE = re.compile(r"\b(needs?|awaiting|pending)[\s:_-]*(triage|approval)\b|\buntriaged\b|\btriage[\s:_-]*needed\b", re.IGNORECASE)
SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "number": {"type": "integer"},
                    "status": {"type": "string", "enum": ["free", "assigned", "waiting", "fixed"]},
                    "kind": {"type": "string", "enum": ["bug", "feature", "docs", "question"]},
                    "lines": {"type": "integer"},
                    "name": {"type": "string"},
                    "complexity": {"type": "string", "enum": ["easy", "medium", "hard"]},
                    "scope_clear": {"type": "boolean"},
                    "reason": {"type": "string"},
                    "belongs": {"type": "boolean"},
                    "linux": {"type": "boolean"},
                    "apolitical": {"type": "boolean"},
                    "not_game": {"type": "boolean"},
                    "open": {"type": "boolean"},
                    "modest": {"type": "boolean"},
                    "validatable": {"type": "boolean"},
                },
                "required": ["number", "status", "kind", "lines", "name", "complexity", "scope_clear", "reason", "belongs", "linux", "apolitical", "not_game", "open", "modest", "validatable"],
            },
        }
    },
    "required": ["issues"],
}


class IssueTags:
    def __init__(self, repo_signals, github_account):
        # merge reads the repo's numbers, and how many pull requests of the user's (by their login) the repo merged.
        self.repo_signals = repo_signals
        self.github_account = github_account
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

    async def tag(self, ids: list[str], force: bool = False) -> list[str]:
        """Tag these issues ("owner/name#n", any repos) and keep the tags. Returns the ids tagged. With force nothing
        from before is kept: every answer is Claude's new one.

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
            results = await asyncio.gather(*[self.tag_batch(name, numbers, force) for name, numbers in group], return_exceptions=True)
            for result in results:
                if not isinstance(result, Exception):
                    tagged.extend(result)
        return tagged

    async def tag_batch(self, full_name: str, numbers: list[int], force: bool = False) -> list[str]:
        """Tag some issues of one repo ("owner/name", at most BATCH numbers) and keep the tags. Returns the ids tagged.

        Raises httpx.HTTPError or ValueError when GitHub fails, JudgeError when Claude gives no usable answer
        (the Claude runs done before it are kept).
        """
        owner = full_name.split("/")[0]
        repo = full_name.split("/")[1]
        login = self.github_account.status().get("login")
        data = await asyncio.to_thread(get_issues_for_tags, owner, repo, numbers, login)
        now = datetime.now(UTC).isoformat()
        # The user's merged pull requests here: none known without a GitHub account.
        merged = data["yourMerged"] or 0
        # Why the repo doesn't merge outsiders' pull requests, "" when it does or its numbers aren't in yet.
        closed = ""
        signals = self.repo_signals.get(full_name)
        if signals is not None:
            if signals["ai_policy"]["tag"] == "no_ai":
                closed = "the project doesn't accept AI-made contributions"
            elif signals["newcomers"]["tag"] in ("turned_away", "left_waiting"):
                closed = "most newcomers' first pull requests are closed or left waiting"
            elif signals["outside_merged_90d"] == 0 and signals["outside_closed_90d"] >= MIN_SAMPLE:
                closed = "none of the outside pull requests that ended in the last 90 days was merged"
            elif (signals.get("newcomer_verdict") or {}).get("verdict") == "closed":
                closed = "the project isn't open to outside contributors' pull requests"
        found = {}
        texts = []
        updated = {}
        # {number: (checks, kind, lines)}: read before and unchanged since, so those stay.
        kept = {}
        # {number: label}: a label that says it still waits for the maintainers' triage or approval.
        triage = {}
        for number in numbers:
            issue = data.get(f"i{number}")
            if issue is None:
                continue
            issue_id = f"{full_name}#{number}"
            # Someone else has it on GitHub: no need to ask. Assigned only to the user is theirs: Claude reads it.
            assignees = [user["login"] for user in issue["assignees"]["nodes"]]
            others = [name for name in assignees if login is None or name.lower() != login.lower()]
            reason = ""
            if others:
                reason = f"Assigned on GitHub to {', '.join(others)}."
            # Or someone else's open pull request says it closes it, and isn't abandoned: no second fix.
            recent = (datetime.now(UTC) - timedelta(days=TAKEN_PR_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
            for pull in issue["closedByPullRequestsReferences"]["nodes"]:
                pull_author = pull["author"]["login"] if pull["author"] else "ghost"
                if reason or pull["state"] != "OPEN" or pull["updatedAt"] < recent:
                    continue
                if login is None or pull_author.lower() != login.lower():
                    reason = f"Open pull request #{pull['number']} by {pull_author} says it closes it."
            if reason:
                found[issue_id] = {
                    "status": "assigned",
                    "merge": "claimed",
                    "checks": None,
                    "kind": None,
                    "lines": None,
                    "name": None,
                    "name_version": NAME_VERSION,
                    "rules_version": RULES_VERSION,
                    "complexity": None,
                    "scope_clear": None,
                    "reason": reason,
                    "updated_at": issue["updatedAt"],
                    "judged_at": now,
                }
                continue
            updated[number] = issue["updatedAt"]

            author = issue["author"]["login"] if issue["author"] else "ghost"
            labels = ", ".join(label["name"] for label in issue["labels"]["nodes"]) or "none"
            for label in issue["labels"]["nodes"]:
                if TRIAGE.search(label["name"]):
                    triage[number] = label["name"]
            body = TEMPLATE_HINT.sub("", issue["body"] or "").strip()
            body = re.sub(r"\n\s*\n+", "\n\n", body)
            text = f"=== #{number}: {issue['title']} ===\nOpened {issue['createdAt'][:10]} by {author} ({issue['authorAssociation']}). Labels: {labels}.\n"
            if issue["state"] != "OPEN":
                text += "It is closed.\n"

            # Every pull request tied to it, once each: the ones that say they close it, then the ones that mention it,
            # were linked to it by hand, or have a commit that mentions it (a squash merge's "(#822)"). By repo and
            # number: a PR in another repo can mention it too. A commit with no pull request (pushed straight to a
            # branch) is listed on its own.
            pulls = {}
            commits = []
            for pull in issue["closedByPullRequestsReferences"]["nodes"]:
                pulls[(pull["repository"]["nameWithOwner"], pull["number"])] = (pull, "says it closes it")
            for event in issue["timelineItems"]["nodes"]:
                if event["__typename"] == "ReferencedEvent":
                    if event["commit"] is None:
                        continue
                    if not event["commit"]["associatedPullRequests"]["nodes"]:
                        commits.append(event)
                        continue
                    pull = event["commit"]["associatedPullRequests"]["nodes"][0]
                    how = f"has a commit that mentions it (\"{event['commit']['messageHeadline']}\")"
                else:
                    pull = event.get("source") or event.get("subject")
                    if pull is None or pull["__typename"] != "PullRequest":
                        continue
                    how = "mentions it"
                    if event["__typename"] == "ConnectedEvent":
                        how = "was linked to it"
                if (pull["repository"]["nameWithOwner"], pull["number"]) not in pulls:
                    pulls[(pull["repository"]["nameWithOwner"], pull["number"])] = (pull, how)
            if not pulls and not commits:
                text += "No pull request or commit is tied to it.\n"
            for event in commits:
                where = ""
                if event["commitRepository"]["nameWithOwner"] != full_name:
                    where = f" in {event['commitRepository']['nameWithOwner']}"
                text += f"Commit {event['commit']['abbreviatedOid']}{where} mentions it, {event['createdAt'][:10]}: \"{event['commit']['messageHeadline']}\"\n"
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
            # The pull requests and issues its description mentions (#723) and not listed above: one still open that it
            # builds on (a follow-up from its review, a change to code only that pull request adds, the work of another
            # issue that isn't done yet) makes it waiting.
            said = []
            # mention, not found: found is the tags of the ones assigned on GitHub, kept below.
            for mention in MENTION.findall(issue["body"] or ""):
                pull = data["mentioned"].get(int(mention))
                if pull is None or int(mention) in said or int(mention) == number or (full_name, int(mention)) in pulls:
                    continue
                said.append(int(mention))
                if pull["__typename"] == "Issue":
                    state = "still open"
                    if pull["state"] == "CLOSED":
                        state = "closed"
                    for closing in pull["closedByPullRequestsReferences"]["nodes"]:
                        closing_author = closing["author"]["login"] if closing["author"] else "ghost"
                        if closing["state"] == "OPEN":
                            state += f", and pull request #{closing['number']} by {closing_author} that would close it is still open, not merged"
                    text += f"Its description mentions issue #{mention} (\"{pull['title']}\"): {state}.\n"
                    continue
                state = "still open, not merged"
                if pull["state"] == "MERGED":
                    state = "merged"
                elif pull["state"] == "CLOSED":
                    state = "closed without merging"
                text += f"Its description mentions pull request #{mention} (\"{pull['title']}\"): {state}.\n"
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
                words = TEMPLATE_HINT.sub("", comment["body"]).strip()
                # Too long: its start and its end, where a conclusion often is (oh-my-pi#17037's triage note ended
                # with "Not implementing until a maintainer accepts the direction").
                if len(words) > limit:
                    words = words[:limit * 2 // 3] + " […] " + words[-(limit // 3):]
                text += f"\n--- {commenter} ({comment['authorAssociation']}), {comment['createdAt'][:10]}:\n{words}"

            # Read before by the rules: its checks and kind stay while nothing changed on GitHub, so the merge doesn't
            # flip between reads. Only the checks still in CHECKS: the ones from before merge are gone. Not when forced.
            with self.lock:
                before = self.tags.get(issue_id)
            if before is not None and before.get("checks") and not force:
                old = {}
                for key, question in CHECKS:
                    if key in before["checks"]:
                        old[key] = before["checks"][key]
                answers = ", ".join(f"{key} {'yes' if value else 'no'}" for key, value in old.items())
                answers += f"; kind {before['kind']}"
                if before.get("lines") is not None:
                    answers += f"; lines {before['lines']}"
                if before["updated_at"] == issue["updatedAt"]:
                    kept[number] = (old, before["kind"], before.get("lines"))
                    text += f"\n\nRead before: {answers}. Nothing changed since: give the same answers."
                else:
                    text += f"\n\nRead before: {answers}. It changed since: keep those answers unless what is new shows otherwise."
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
        # Whose work doesn't count as someone else being on it.
        yours = ""
        if login is not None:
            yours = (
                f"We work for the GitHub user {login}. Their own claims, assignment and pull requests (and ours, made as them) "
                "never count as someone being on it: status is about other people only, so an issue only they are on is free.\n"
            )
        for run in runs:
            prompt = (
                f"Below are {len(run)} issues of the GitHub project {data['nameWithOwner']} ({data['stargazerCount']} stars, "
                f"written in {language}): {data['description'] or 'no description'}\n\n"
                "Tag each one for a capable programmer who is new to the project and is looking for an issue to fix. "
                "Read each issue's comments to the end before deciding: they often change the answer.\n\n"
                "status: who may take it. " + yours + "Weigh everything together: the labels ('good first issue', 'help wanted' and the like "
                "invite outside contributors, but they are a hint, not the answer); who opened it; what the issue template says "
                "about the author fixing it themselves (a checked 'I am willing to submit a PR' or a 'Yes' there means the author "
                "means to do it); what the comments say (someone asking to take it or saying they are on it, a maintainer handing "
                "it out or turning people down, a pull request mentioned, a maintainer saying it isn't wanted); and the "
                "pull requests tied to it, listed under the issue with their state and last comment.\n"
                "- assigned: someone else is on it: the author said they will fix it or send the pull request themselves (also when "
                "they wait for a maintainer to confirm first, or say they will /claim it then), a commenter claimed it and was not "
                "turned down, a maintainer gave it to someone, or one of its pull requests is open and alive. A claim in the comments holds for "
                "about two months even with no pull request yet, unless that person gave up or a maintainer opened it to others; "
                "an open pull request untouched for months doesn't count.\n"
                "  A fix posted in the issue's description or in a comment counts too, even with no pull request of theirs tied "
                "to the issue: a branch or commit in someone's fork, a patch, the whole change or its test pasted ('my account is "
                "blocked', 'happy for a maintainer to open a PR from it'). Someone did the work, and a newcomer shouldn't build on it or race it: assigned, like a "
                "claim, unless a maintainer turned that fix down.\n"
                "  So does a problem found in code that only someone else's open pull request or unmerged feature branch has: "
                "a review or QA finding on that pull request, an issue whose environment or version is that branch or pull "
                "request, or one that pull request's comments name as its to-do. The fix belongs in that pull request, by its "
                "author, and the default branch has nothing to fix: assigned, until that pull request is merged.\n"
                "  A pull request closed without merging ends its author's claim: read its last comment for why (for example "
                "closed under the project's AI policy, or the approach was turned down) and say so in the reason when it matters. "
                "Never say that no pull request came when the issue lists one.\n"
                "- free: nobody is on it and a newcomer could start now: it is a real, accepted problem or a wanted change, the "
                "outcome wanted is clear, and nothing waits on the maintainers.\n"
                "  A feature request (new behavior or an improvement) is wanted only when a maintainer showed it: one of them "
                "(OWNER, MEMBER or COLLABORATOR) opened it, said yes to it in a comment, or labeled it as invited or accepted "
                "(help wanted, good first issue, accepted, planned and the like). A label the issue template puts on by itself "
                "('feature request', 'enhancement') doesn't count, and neither do other users asking for it or thumbs up. A bug "
                "that clearly happens needs no such yes.\n"
                "- waiting: nobody is on it, but it isn't ready to pick up: it needs a maintainer's decision or a design, more "
                "information or a reproduction, or the maintainers keep it for themselves. So is one that still waits for "
                "the maintainers' triage or approval (a label like 'status: needs triage', a bot or maintainer saying not to "
                "open a pull request until then), even when a maintainer opened it. So is one that builds on a pull request "
                "that is still open (a follow-up from that pull request's review, or a change to code only it adds; the ones "
                "its description mentions are listed under it with their state): it waits until that one is merged. So is one "
                "that builds on another issue that is still open (it says it reuses, extends or follows the work of that "
                "issue, listed under it with the pull requests that would close it): it waits until that work is merged. And one "
                "where a maintainer, a collaborator or the project's triage bot left questions for the maintainers or said to "
                "wait for their go-ahead before anyone implements it, until a maintainer answered. A feature request no "
                "maintainer has said yes to is waiting, however clear it is and however long it has sat.\n"
                "- fixed: it is open, but a merged pull request or a commit on the default branch already does what it asks, "
                "and it only needs closing. GitHub leaves an issue open when the pull request said \"Addresses #n\" or "
                "\"Part of #n\" instead of \"Fixes #n\", so read the merged pull requests and commits listed under it and "
                "judge by what they did: when one did only part of what it asks, it isn't fixed.\n\n"
                f"The checks, for whether a pull request from us would get merged. {SANDBOX} Answer each one yes (true) or no "
                "(false) on its own, from what the issue and its comments say; when it is unclear, answer no.\n"
                + "".join(f"- {key}: {question}\n" for key, question in CHECKS)
                + "\n"
                "kind: bug, feature (new behavior or an improvement), docs, or question (a support question, nothing to fix).\n\n"
                "lines: a rough guess of how many lines the fix's pull request changes: the lines added and removed together, "
                "as GitHub counts them, its tests included. 0 when there is nothing to change.\n\n"
                "name: the issue's short name on a board card, one line: what has to be done to close it, as a short command "
                "that starts with a verb (Fix, Add, Update, Remove, Speed up, ...), in a few plain words, at most 6. No 'Bug:' or "
                "'Feat:' in front, no issue number, no file or function names, no quotes, no period. Use general software words "
                "any engineer understands without knowing this project: say what kind of thing it is (crash, button, table view, "
                "API, config, CLI command, login, retry, docs, ...), never the project's own names for its features, components, "
                "modes or products, nor the names of the services it talks to. Like these:\n"
                + "".join(f"- {example}\n" for example in NAME_EXAMPLES)
                + "\n"
                "complexity: how hard the fix is for a capable programmer new to the project. easy: a small, local change "
                "with an obvious approach. medium: several places to change, or some digging to find the cause. hard: a deep "
                "cause, a tricky design, or a lot to learn about the project first.\n\n"
                "scope_clear: is it clear what to change and what done looks like (expected behavior, steps to reproduce for "
                "a bug, the wanted outcome for a feature)? No when it is vague, open-ended, or still being argued about.\n\n"
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
                for key, question in CHECKS:
                    checks[key] = item[key]
                kind = item["kind"]
                lines = max(item["lines"], 0)
                # The short name: one line, no period at the end, cut to NAME_CHARS. Once given it stays, unless forced.
                name = " ".join(item["name"].split()).rstrip(".")
                if len(name) > NAME_CHARS:
                    name = name[:NAME_CHARS - 1].rstrip() + "…"
                before = self.tags.get(f"{full_name}#{item['number']}")
                if before is not None and before.get("name") and before.get("name_version") == NAME_VERSION and not force:
                    name = before["name"]
                # Complexity and whether the scope is clear stay while the issue hasn't changed, unless forced.
                complexity = item["complexity"]
                scope_clear = item["scope_clear"]
                unchanged = before is not None and not force and before["updated_at"] == updated[item["number"]]
                if unchanged and before.get("complexity"):
                    complexity = before["complexity"]
                if unchanged and before.get("scope_clear") is not None:
                    scope_clear = before["scope_clear"]
                if item["number"] in kept:
                    # The answers from before stay; a check added since (not among them) takes the new answer, and so
                    # do lines when there were none.
                    checks.update(kept[item["number"]][0])
                    kind = kept[item["number"]][1]
                    if kept[item["number"]][2] is not None:
                        lines = kept[item["number"]][2]
                # A label that says it still waits for the maintainers' triage or approval: waiting, whoever opened it.
                if item["status"] == "free" and item["number"] in triage:
                    item["status"] = "waiting"
                    reason = f"It still waits for the maintainers' triage or approval (its label {triage[item['number']]})."
                # The merge by the rules (see the top of this file): the first that holds.
                merge = "likely"
                why = "nothing stands in the way"
                if item["status"] == "fixed":
                    merge = "fixed"
                    why = "a merged pull request or commit already does what it asks; it only needs closing"
                elif not checks["apolitical"]:
                    merge = "out of scope"
                    why = "it touches politics, which we stay out of"
                elif not checks["not_game"]:
                    merge = "out of scope"
                    why = "it is about a game, which we don't work on"
                elif not checks["belongs"]:
                    merge = "out of scope"
                    why = "it isn't a pull request to this repo for its own users"
                elif not checks["linux"]:
                    merge = "out of scope"
                    why = "it can only be seen on Windows, macOS, a phone or other hardware, so we can't validate it in our Linux VM"
                elif item["status"] == "assigned":
                    merge = "claimed"
                    why = "someone else is on it"
                elif not checks["open"]:
                    merge = "maintainers only"
                    why = "the maintainers keep it for themselves"
                elif item["status"] == "waiting":
                    merge = "waiting"
                    why = "it isn't ready to pick up"
                elif closed != "":
                    merge = "no outside prs"
                    why = closed
                elif not checks["modest"]:
                    merge = "large feature"
                    why = "a large new feature the maintainers would have to keep up"
                elif lines > BIG_LINES and merged == 0:
                    merge = "big change"
                    why = f"about {lines} lines, and you have no merged pull request in this repo yet"
                elif not checks["validatable"]:
                    merge = "can't validate"
                    why = "our agent can't prove the fix works in its VM"
                reason += f" Merge: {MERGE_LABEL[merge]}, {why}."
                answered[f"{full_name}#{item['number']}"] = {
                    "status": item["status"],
                    "merge": merge,
                    "checks": checks,
                    "kind": kind,
                    "lines": lines,
                    "name": name,
                    "name_version": NAME_VERSION,
                    "rules_version": RULES_VERSION,
                    "complexity": complexity,
                    "scope_clear": scope_clear,
                    "reason": reason,
                    "updated_at": updated[item["number"]],
                    "judged_at": datetime.now(UTC).isoformat(),
                }
            with self.lock:
                self.tags.update(answered)
                self.save()
            found.update(answered)
        return list(found)
