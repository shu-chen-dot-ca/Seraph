"""The agent's work tools: the Repos and Issues lists, its jobs, drafts for the Inbox and the VM queue.

The GitHub tools (github_tools.py) only read GitHub; these change what the user sees and decides on:
- Lists: the Repos and Issues lists are the user's view of what the agents found. Each change is
  one undo step for the user. Repos and issues are read from GitHub here, on this machine, so the
  agent only names them. The Tracked list is the repos the user wants to keep an eye on; the
  backend checks their open issues now and then (github_searcher/tracked_issues.py), and
  tracked_issues shows what it found, so the agent can pick good ones for the Issues list.
- Jobs: the smallest unit of work (github_searcher/jobs.py). The user makes them by assigning an
  issue; the agent can make its own and keeps their status and notes up to date, and their
  progress (job_progress: the step it is on and a headline in everyday words) for the user to follow.
  The app makes follow_up jobs (agents.py, follow_up): someone else wrote on a PR or issue of the user's that
  the agent follows, or the PR's checks failed. my_jobs shows that PR or issue as the job's thread; the agent
  answers with draft_comment (target: the thread), draft_pr with pr (a new version of the user's own PR), or by
  marking the job done when nothing needs an answer. A question it drafts for the job is about the thread.
- Drafts: nothing goes to GitHub from here. A PR, an issue comment or a question becomes a draft
  in the user's Inbox and its job waits on the user. A PR draft's diff is read from the repo
  folder in the VM, so only the agent holding the VM can make one, with the commit it starts from
  (base_sha: Approve sends exactly that diff on that commit, github_account.py) and the branch's commits since
  (commits: replayed when it is sent, all with the user's name). Every commit must be the agent's own:
  draft_pr refuses a branch with anyone else's commits (a cherry-pick), and nothing credits a co-author.
  It also refuses a diff with what GitNexus writes by itself when it builds its index (its block in AGENTS.md
  and CLAUDE.md, .claude/skills/gitnexus/, .gitnexus/): running a project's required tool never puts its own
  file changes in the PR.
  No draft has emoji in it (EMOJI, the user's rule; a template's emoji are written as words). A PR is
  written from the project's contribution rules and its recently merged PRs: contributing_guide
  gathers the rules wherever they are (CONTRIBUTING in any folder, developer guides in the docs, the
  PR template, AGENTS.md, and the guides the README and CONTRIBUTING link to, on GitHub or on the
  project's website), pr_examples shows its main contributors' latest merged PRs and some outside ones,
  and draft_pr refuses until the agent read both for that repo. The job's before and
  after pictures go in the PR body as ![before](evidence:ev_...): the Inbox shows them in place,
  and sending uploads them to the user's fork (or the user does, sending by hand).
  draft_pr with pr ("owner/name#n") is the next version of the user's own open PR instead: base must be that PR's
  newest commit on GitHub (checked when drafting, and again when sending), the title is the commit message's
  subject and the body the comment posted on the PR with the push (the draft's update_of, inbox.py). The rules
  (contributing_guide), the tests and the checks on the diff and commits apply as for a new PR; the PR template
  and pr_examples don't, and a follow_up job's change needs no before and after pair (its test runs show it works).
- Evidence: what the user looks at to decide on a draft. Real screenshots of the project running on
  the VM's desktop (its window, or a terminal running it), screen recordings (GIF) and command runs
  (a test failing, then passing), each "before" or "after" the agent's change, under a topic that
  pairs them. Never pictures the agent drew: an image made with matplotlib is refused. It is kept on
  the job (jobs.py), and each draft gets a copy. A PR draft needs at least one before and one after (except a
  follow_up job's).
- Tests: run_tests runs the project's tests in the VM on the unchanged code (before), then on the
  change (after), with the same command, live in a terminal window on the VM's desktop for the user.
  Two scopes: focused, the basic checks (the tests that cover the change, when the rules ask for no
  more), and full, the project's official checks (what its rules ask to run before a PR), run however
  long they take (up to TEST_TIMEOUT). It refuses until the agent read the rules (contributing_guide).
  A passing before is needed to go past set_up and an after for a PR draft; an official before of
  another job on the same repo and VM counts too (job_progress carries it over; for a follow_up job at its
  test step), so a project already set up isn't set up again.
- Artifacts: the agent's own folder on this computer (github_searcher/artifacts.py), the Artifacts tab of its page.
  It lists it, looks at its pictures and text (artifact_view: a picture comes back as a picture), keeps
  screenshots of its VM there, and copies files between it and the VM it holds; never anywhere else on this
  computer, and it can't delete anything there. It shows one of its pictures in chat as ![...](artifact:path).
- Its name: while it has the automatic one (agent-N), the agent may name itself once (name_yourself);
  a name the user gave is never changed (agents.py, name_by).
- VMs: the agent sees every VM with what its image has (sandbox/images.py lists each image once) and
  its notes, and picks the one that suits its jobs as its target VM (the user can set it too). It can't make VMs.
  It joins its target VM's queue (sandbox/vm_queue.py) and releases the VM when its jobs there are done.
  The notes (sandbox/vms.py) say what agents and the user set up in a VM since it was made, so the next
  agent knows (e.g. that a project is already cloned and built there, and what was added on top). Only the
  agent holding the VM adds or removes them (vm_note_add, vm_note_remove), never the user's own. They come
  with the message that a VM is the agent's now (here and in agents.py, on_grant).

Each tool returns its result as text; a bad call returns is_error, so Claude sees it failed.
A job that is done or cancelled (often by the user, while the agent was busy) can't change
anymore: no status, notes or drafts, so the user's cancel is never undone. The list stores
write a file on every change, so they are called in a thread, off the backend's event loop.
describe() gives the one line the chat shows for each call, of these tools and of the GitHub tools.

    tools = WorkTools(agents, record).list()
"""

import asyncio
import base64
import hashlib
import html
import json
import posixpath
import re
import secrets
import shlex
import subprocess
import time
from datetime import UTC, datetime, timedelta

import httpx
from claude_agent_sdk import tool

from github_searcher.artifacts import ArtifactsError
from github_searcher.jobs import EVIDENCE_DIR
from github_searcher.search import get_contents, get_merged_prs, get_pr_status, get_readme, get_repository, get_thread, get_tree
from sandbox.agent.computer_use import WATCH, Computer, ComputerError
from sandbox.agent.tools import HIDE_MIN_LENGTH
from sandbox.file_transfer import FileTransferError, to_vm
from sandbox.images import load_inventory
from sandbox.vms import VMsError

# The job statuses an agent may set. "queued" and "waiting_on_user" are set by the app.
AGENT_STATUSES = ["working", "done", "cancelled"]
OPEN_STATUSES = ["queued", "working"]
CLOSED_STATUSES = ["done", "cancelled"]
# A PR draft's diff can't be bigger than this. A real fix is far smaller; a bigger diff
# almost always has build output, a lockfile or a virtualenv in it.
DIFF_LIMIT = 500_000
EVIDENCE_KINDS = ["screenshot", "image", "command"]
EVIDENCE_STAGES = ["before", "after", "other"]
# Evidence screenshots are for the user to read, so sharper than the agent's own (60).
EVIDENCE_QUALITY = 85
# An image file from the VM can't be bigger than this; Claude takes images up to 5 MB.
IMAGE_LIMIT = 5_000_000
# A command's output is kept up to this many bytes, the last ones (where results and errors are).
OUTPUT_LIMIT = 20_000
# The live feed carries only the end of a command's output: this many lines, at most TAIL_CHARS.
TAIL_LINES = 20
TAIL_CHARS = 2000
# A test run may take this long; then it is stopped and counts as failed. Long on purpose: the project's official
# checks are run however long they take.
TEST_TIMEOUT = 12 * 3600
# A fix_issue job can't go past set_up until its tests passed on the unchanged code.
STEPS_AFTER_SETUP = ["reproduce", "fix", "test", "draft"]
# What a test run covers: focused, the basic checks (the tests that cover the change: the default), or full, the
# project's official checks (what its rules ask to run before a PR, e.g. the whole suite and its lint script).
TEST_SCOPES = ["full", "focused"]
# The evidence each test run adds, the same for its before and after, so the Inbox pairs them.
TESTS_TOPICS = {"full": "full test suite", "focused": "tests that cover the change"}
TESTS_CONTEXTS = {
    "full": (
        "The project's official automatic checks, all it asks contributors to run before a pull request, run once on the "
        "code as it was and once with the change. Both must pass: the first shows the checks work in the VM, the second "
        "that the change broke nothing they check."
    ),
    "focused": (
        "The project's own automatic checks for the part the change touches (not all of them, only the ones that matter "
        "for this change), run once on the code as it was and once with the change. Both must pass: the first shows the "
        "checks work in the VM, the second that the change broke nothing they check."
    ),
}
# The overview is for a user who doesn't know the project: short, plain words. These caps keep it that way.
OVERVIEW_PROJECT_CHARS = 150
OVERVIEW_PART_CHARS = 400
OVERVIEW_RISK_CHARS = 250
OVERVIEW_RISKS_MAX = 3
CONTEXT_CHARS = 500
# Agents never use emoji, in drafts or anywhere (the user's rule): pictographs, dingbats and symbols drawn as emoji,
# flags, and the joiners and selectors that make emoji. Plain arrows and math signs are fine.
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u231A\u231B\u23E9-\u23FA\u203C\u2049\u2139\u3030\u303D\u3297\u3299\uFE0F\u200D\u20E3]")
NO_EMOJI = "No emoji anywhere, also where the project's template has them: write its words without them. Found: "
# pr_examples: the main contributors (most PRs merged lately) and how many of each one's newest merged PRs it shows,
# how many merged PRs of outside contributors, and how much of each description.
PR_EXAMPLES_MAIN = 3
PR_EXAMPLES_EACH = 2
PR_EXAMPLES_OUTSIDE = 3
PR_EXAMPLE_CHARS = 3000
OUTSIDE_ROLES = ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]
# contributing_guide: a repo file holds rules for contributors when its name has "contribut" in it (not CONTRIBUTORS, a
# list of people) or it is in a contributing folder, it is a PR template, or it is one of GUIDE_FILES at the top, in
# .github/ or in docs/ (an AGENTS.md deeper down is only for its folder: those are named, not shown). Only text files,
# never in folders of other people's code, test data or translations. Links in the README and in those files are
# followed when their text or address has one of GUIDE_LINK_WORDS: a file in the repo, or a page on the web (https,
# at most GUIDE_PAGES of them). Each document is cut at GUIDE_CHARS, all of them together at GUIDE_TOTAL_CHARS.
GUIDE_FILES = ["agents.md", "ai_policy.md", "development.md", "developing.md", "hacking.md"]
GUIDE_TEXT_ENDINGS = (".md", ".mdx", ".rst", ".txt", ".adoc")
GUIDE_SKIP_FOLDERS = ["node_modules/", "vendor/", "third_party/", "site-packages/", "tests/", "fixtures/", "i18n/", "locale/", "locales/", "translations/"]
GUIDE_LINK_WORDS = ["contribut", "developer guide", "developer-guide", "development guide", "hacking", "pull request", "pull-request"]
GUIDE_PAGES = 5
GUIDE_CHARS = 30_000
GUIDE_TOTAL_CHARS = 120_000
# A picture made with matplotlib says so in its file ("Software: Matplotlib version ..."): the agent drew it.
MATPLOTLIB_MARK = b"matplotlib"
# Where run_tests's output goes for the terminal window on the desktop.
TESTS_LOG = "~/.cache/sandbox-tests.log"
# The overview's wording, said once for every tool that takes one.
PLAIN = (
    "Plain words for someone who has never seen this project or its code: no function or file names, "
    "and explain any technical term in a few words."
)


class WorkTools:
    def __init__(self, agents, record: dict):
        # The Agents manager: the shared stores (repos, issues, jobs, inbox) and the VMs and their queue.
        self.agents = agents
        # The agent's record (the same dict), so the target VM is always the current one.
        self.record = record
        self.agent_id = record["id"]
        # The repos (owner/name, lower case) whose PRs it looked at with pr_examples since the backend started.
        self.pr_examples_read = set()
        # The repos (owner/name, lower case) whose rules for contributors it read with contributing_guide.
        self.guides_read = set()

    def list(self) -> list:
        names = {"type": "array", "items": {"type": "string"}}
        return [
            tool(
                "repos_list",
                "See the Repos list the user sees, and the user's types of repo (the tags that classify repos, each with what it is). "
                "Each repo with its stars, description, your note, its type, who added it (an agent id, "
                "user, or explore), how many of its issues are in the Issues list, and its signals: AI policy "
                "(welcome, disclose, no_ai, unclear, none), outside contributors' merge rate and median days to a first reply "
                "from a maintainer, stale outside PRs, how many people merged PRs in the last 30 days, how newcomers fare "
                "(welcomes, ok, turned_away, left_waiting, few), PRs, issues and commits a month, and the review tone (warm, neutral, strict, curt) with what reviewers "
                "often ask for.",
                {},
            )(self.repos_list),
            tool(
                "repos_add",
                "Add repos to the Repos list, by full name (owner/name). note is one short line on why they fit (shown under each repo). "
                "type is the name of the user's type of repo they are (repos_list lists the types); leave it out when none fits. "
                "Repos already in the list are skipped. Add only repos you "
                "checked and would recommend.",
                {
                    "type": "object",
                    "properties": {"names": names, "note": {"type": "string"}, "type": {"type": "string"}},
                    "required": ["names", "note"],
                },
            )(self.repos_add),
            tool(
                "repos_remove",
                "Remove repos from the Repos list, by full name. Their issues stay in the Issues list.",
                {"type": "object", "properties": {"names": names}, "required": ["names"]},
            )(self.repos_remove),
            tool(
                "repos_note",
                "Replace the note of one repo in the Repos list: one short line on why it fits or what to watch out for.",
                {"name": str, "note": str},
            )(self.repos_note),
            tool(
                "issues_list",
                "See the Issues list the user sees: each issue with its title, labels, state, your note, its job status "
                "(new when nobody was assigned yet) and the app's tags: free / assigned / waiting (whether someone new can take it), "
                "level (easy, medium, hard, or out of scope: we can't do it yet), kind and the reason, made shortly after an issue is added. repo limits it to one "
                "repo (owner/name).",
                {"type": "object", "properties": {"repo": {"type": "string"}}},
            )(self.issues_list),
            tool(
                "issues_add",
                "Add issues to the Issues list, each as owner/name#number. Only issues, not pull requests. note is one short line on "
                "why it is a good pick (shown under each issue). Their repos are added to the Repos list too if missing. "
                "Issues already in the list are skipped.",
                {"type": "object", "properties": {"issues": names, "note": {"type": "string"}}, "required": ["issues", "note"]},
            )(self.issues_add),
            tool(
                "issues_remove",
                "Remove issues from the Issues list, each as owner/name#number, e.g. when someone else took one or it got fixed. "
                "An issue an agent is working on (a job on it queued, working or waiting on the user) stays: kept_working lists them.",
                {"type": "object", "properties": {"ids": names}, "required": ["ids"]},
            )(self.issues_remove),
            tool(
                "issues_note",
                "Replace the note of one issue in the Issues list (owner/name#number): one short line.",
                {"id": str, "note": str},
            )(self.issues_note),
            tool(
                "tracked_list",
                "See the Tracked list: the repos the user wants to keep an eye on for new issues. Each with its stars, note, who "
                "added it, when its issues were last checked, and how many open issues it has: all, free (the app's tags say a "
                "newcomer can take it now), assigned (someone is on it) and new (opened in the last 3 days).",
                {},
            )(self.tracked_list),
            tool(
                "tracked_add",
                "Add repos to the Tracked list, by full name (owner/name), so their new issues get checked every few minutes. "
                "note is one short line on why (may be empty). Repos already tracked are skipped.",
                {"type": "object", "properties": {"names": names, "note": {"type": "string"}}, "required": ["names"]},
            )(self.tracked_add),
            tool(
                "tracked_remove",
                "Remove repos from the Tracked list, by full name. Only when the user asks, or a repo is archived or gone.",
                {"type": "object", "properties": {"names": names}, "required": ["names"]},
            )(self.tracked_remove),
            tool(
                "tracked_issues",
                "See the open issues the last check found in tracked repos, newest first, each with its labels, comments, "
                "assignees, the app's tags (free / assigned / waiting, level easy / medium / hard / out of scope, kind, and the reason; None "
                "while not made yet), whether it is new (opened in the last 3 days) and whether it is in the Issues list "
                "already. name limits it to one repo (owner/name). which: free (a newcomer can take it now; the default), "
                "assigned (someone is on it), or all (the 100 newest open issues plus every good first or help wanted one).",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "which": {"type": "string", "enum": ["free", "assigned", "all"]}},
                },
            )(self.tracked_issues),
            tool(
                "my_jobs",
                "See your jobs: open ones in full (kind, title, issue, thread (a follow_up's PR or issue), repo, VM, status, "
                "the user's instructions, your notes, drafts and their decisions), finished ones (done, cancelled) by id and title only.",
                {},
            )(self.my_jobs),
            tool(
                "job_create",
                "Make a job for yourself, e.g. a follow-up task the user asked for in chat. kind: fix_issue (issue is required) or task. "
                "title says what the job is in a few words; instructions say what exactly to do. It is for your target VM.",
                {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string"},
                        "title": {"type": "string"},
                        "instructions": {"type": "string"},
                        "issue": {"type": "string", "description": "owner/name#number, if the job is about one issue"},
                    },
                    "required": ["kind", "title", "instructions"],
                },
            )(self.job_create),
            tool(
                "job_update",
                "Update one of your jobs. status: working when you start on it, done when it is finished, cancelled when it can't or "
                "shouldn't be done. notes replaces the job's notes: a few lines on where it stands (what you did, what is left, "
                "where the work is in the VM), so you or the user can pick it up later.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "status": {"type": "string", "enum": AGENT_STATUSES},
                        "notes": {"type": "string"},
                    },
                    "required": ["job_id"],
                },
            )(self.job_update),
            tool(
                "job_progress",
                "Show the user where one of your jobs stands. They watch this to follow your work, and they don't know the project's "
                "code. step: the step you are on now, one of the job's steps (my_jobs lists them; for fix_issue: understand, set_up, "
                "reproduce, fix, test, draft; for set_up_repo: understand, set_up, show, introduce; for follow_up: understand, work, "
                "test, draft). Going back is fine, e.g. from test to fix when tests fail. headline: one sentence in "
                "everyday words on what you are doing and how it is going, for someone who doesn't know the code (no file, function or "
                "test names, no jargon). detail: the same in technical terms (files, tests, errors), shown when they look closer. "
                "about: what the job is about, in everyday words; set it once, when you understand the issue. Call this at every new "
                "step and whenever the headline changes, e.g. a check failed or you found the cause. It also marks the job working.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "step": {"type": "string"},
                        "headline": {"type": "string"},
                        "detail": {"type": "string"},
                        "about": {"type": "string"},
                    },
                    "required": ["job_id", "headline"],
                },
            )(self.job_progress),
            tool(
                "run_tests",
                "Run the project's tests in the VM for one of your fix jobs (only while you hold the VM), and keep the result on "
                "the job and as evidence. Read the project's rules first (contributing_guide). scope: full (the project's official "
                "checks: what its rules ask to run before a PR, as one command, e.g. `pytest -n 2 && ruff check .`, however long "
                "they take) or focused (the basic checks, when the rules ask for no more: the test files and folders that cover "
                "the code you change, e.g. `pytest tests/test_parser.py tests/cli/`). command: what runs them "
                "(setup belongs in bash before, not here). "
                "path: the repo folder (e.g. ~/click); base: what you branch from (e.g. origin/main). when: before (on the "
                "unchanged code: the folder must not differ from base; it has to pass before you change anything), or after (on "
                "your finished change, with exactly the same command and scope; it has to pass before draft_pr). A PR draft is "
                "refused unless the last after run passed on exactly the code being drafted. "
                f"Takes as long as the tests; stopped after {TEST_TIMEOUT // 60} minutes.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "path": {"type": "string"},
                        "base": {"type": "string"},
                        "command": {"type": "string"},
                        "scope": {"type": "string", "enum": TEST_SCOPES},
                        "when": {"type": "string", "enum": ["before", "after"]},
                    },
                    "required": ["job_id", "path", "base", "command", "scope", "when"],
                },
            )(self.run_tests),
            tool(
                "draft_comment",
                "Draft a comment on an issue or PR (target: owner/name#number) for the user's Inbox, e.g. \"I'd like to work on this\", "
                "or a follow_up job's reply (target: its thread). "
                "Nothing is posted: the user decides, and you get a message with their decision. The job waits on the user meanwhile. "
                "body is the comment as it would be posted. project, problem and why are only for the user, in the Inbox's overview. " + PLAIN,
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "target": {"type": "string"},
                        "body": {"type": "string"},
                        "project": {"type": "string", "description": "One line: what the project is, e.g. 'matplotlib: a Python library that draws charts'."},
                        "problem": {"type": "string", "description": "What the issue is about: what goes wrong, for whom, when. Specific, 1 to 2 sentences."},
                        "why": {"type": "string", "description": "Why post this comment now, in 1 to 2 sentences."},
                    },
                    "required": ["job_id", "target", "body", "project", "problem", "why"],
                },
            )(self.draft_comment),
            tool(
                "draft_question",
                "Ask the user a question through their Inbox when you are blocked and need their decision or information. "
                "job_id is the job it is about (leave it out if none). The job waits on the user until they answer. "
                "Not for a secret to fill in (env_var_add, then say so in your message), nor to ask whether to go on.",
                {
                    "type": "object",
                    "properties": {"job_id": {"type": "string"}, "question": {"type": "string"}},
                    "required": ["question"],
                },
            )(self.draft_question),
            tool(
                "artifacts_list",
                "See what is in your artifacts: your own folder on the user's computer, the Artifacts tab of your page. The user "
                "puts files and folders there for you (pictures to look at, files to use in the VM); you keep your screenshots and "
                "files from the VM there. path: a folder in it (empty for the top).",
                {"type": "object", "properties": {"path": {"type": "string"}}},
            )(self.artifacts_list),
            tool(
                "artifact_view",
                "Look at a file in your artifacts. A picture (PNG, JPEG, GIF or WebP, up to 5 MB) comes back as the picture itself, "
                "text as text (the first 50,000 characters). path: e.g. 'screenshots/before.jpg'. To show the user a picture in "
                "chat, write ![what it shows](artifact:screenshots/before.jpg).",
                {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            )(self.artifact_view),
            tool(
                "artifact_screenshot",
                "Take a screenshot of your VM's desktop and keep it in your artifacts (only while you hold the VM). path: where, "
                "e.g. 'screenshots/login-page.jpg' (a JPEG; a name that is taken is refused). region: [x, y, width, height] for "
                "only that part of the screen.",
                {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "region": {"type": "array", "items": {"type": "integer"}}},
                    "required": ["path"],
                },
            )(self.artifact_screenshot),
            tool(
                "artifact_from_vm",
                "Copy a file or folder from your VM into your artifacts, e.g. a picture you made or a log (only while you hold the "
                "VM; 200 MB at most). source: its path in the VM (~/ is the home folder). folder: where in your artifacts (empty "
                "for the top). A name that is already there is refused.",
                {
                    "type": "object",
                    "properties": {"source": {"type": "string"}, "folder": {"type": "string"}},
                    "required": ["source"],
                },
            )(self.artifact_from_vm),
            tool(
                "artifact_to_vm",
                "Copy a file or folder from your artifacts into your VM, e.g. something the user put there for you (only while "
                "you hold the VM). path: in your artifacts. folder: where in the VM (empty for the home folder). A name that is "
                "already there is refused.",
                {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "folder": {"type": "string"}},
                    "required": ["path"],
                },
            )(self.artifact_to_vm),
            tool(
                "name_yourself",
                "Give yourself a name, once, while you still have the automatic one (agent-N; the app tells you): 2 to 30 "
                "lowercase letters, digits and hyphens, for the work you do, e.g. hermes-reasoning or cli-typo-fixes. A name "
                "the user gave you is never changed, and the one you give yourself stays.",
                {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            )(self.name_yourself),
            tool(
                "pr_examples",
                "How the project's own people write their pull requests, so you write yours the same way: its main contributors "
                "(who got the most PRs merged lately) with their newest merged PRs, and some merged PRs of outside contributors, "
                "each with its title, labels and full description. name: owner/name. draft_pr refuses until you read it for the "
                "job's repo.",
                {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            )(self.pr_examples),
            tool(
                "contributing_guide",
                "The project's rules for contributors, wherever they are, in full: every CONTRIBUTING file (any folder), "
                "developer guides in its docs, its PR template, AGENTS.md and the like, and the guides its README and those "
                "files link to, in the repo or on the project's website. Read all of it before you set up, and follow every "
                "rule (setup, what to run before a PR and how, commit and PR style), however long its checks take. name: "
                "owner/name. run_tests and draft_pr refuse until you read it for the job's repo.",
                {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            )(self.contributing_guide),
            tool(
                "draft_pr",
                "Draft a pull request for the user's Inbox from your work in the VM (only while you hold it). Only when you are certain the "
                "fix is right and complete, and your evidence shows it. path is the repo folder in the VM (e.g. ~/click), base what to "
                "compare against (e.g. origin/main): the PR goes into that branch. The diff is everything that differs from base, committed or "
                "not, new files included. It is sent with your branch's commits as they are (their messages), all with the user's "
                "name: every commit must be your own, never cherry-picked from someone else, and nothing credits a co-author. What "
                "you didn't commit goes in one more commit, with the title as its message. "
                "title and body are the PR exactly as it would be sent, written from the project's contribution rules "
                "(contributing_guide) and the way its recently merged PRs are written (pr_examples: their title style, length, "
                "sections, tone, and whether they keep the PR template's headings; the result says which headings you left out). "
                "Read both first. The user's instructions on the form win. No emoji anywhere. Your before and after pictures "
                "go in the body as ![before](evidence:ev_...) (a Before / After table); they are uploaded with the PR. You push and send "
                "nothing: the user reviews it, approving sends it from their account, and you get a message with their decision. project, problem, cause, fix and "
                "risks are only for the user, who reads them first to understand and judge the PR. " + PLAIN + " "
                "pr: only for the next version of the user's own open PR (owner/name#number; a follow_up job: a reviewer asked "
                "for changes, or its checks failed). Then base is the PR's newest commit (the sha the follow-up message gave), "
                "and your work is on top of it; approving pushes your commits onto the PR's branch instead of opening a new PR. "
                "title is then the commit message's subject (one more commit has it when you didn't commit everything), and "
                "body the comment posted on the PR with the push: what changed, in a line or two. The project's rules "
                "(contributing_guide) and the tests apply as for any PR; the PR template and pr_examples don't. problem is then "
                "what the reviewer asked for or what failed.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "path": {"type": "string"},
                        "base": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "pr": {"type": "string", "description": "owner/name#number of the user's open PR this is the next version of; leave it out for a new PR."},
                        "project": {"type": "string", "description": "One line: what the project is, e.g. 'matplotlib: a Python library that draws charts'."},
                        "problem": {
                            "type": "string",
                            "description": "What goes wrong, as someone using it sees it, specific about when and what, in 1 to 2 sentences. E.g. "
                            "'While you drag a slider, the chart shows the picture from before the slider moved; the right picture only "
                            "appears once the slider stops.'",
                        },
                        "cause": {"type": "string", "description": "Why it goes wrong, in 1 to 2 sentences."},
                        "fix": {"type": "string", "description": "What your change does about it, and what stays the same, in 1 to 2 sentences."},
                        "risks": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "1 to 3 ways this change could still go wrong or be turned down: real, specific ones (who or what "
                            "could be affected, what a maintainer might object to), not 'tests might fail'.",
                        },
                    },
                    "required": ["job_id", "path", "base", "title", "body", "project", "problem", "cause", "fix", "risks"],
                },
            )(self.draft_pr),
            tool(
                "evidence_add",
                "Add evidence to one of your jobs, for the user to decide on its drafts (only while you hold the VM). The user sees "
                "it next to your draft in the Inbox, with each topic's before and after side by side. "
                "kind: screenshot (the VM's desktop now; region [x, y, width, height] takes only that part, e.g. one window), "
                "image (an image file in the VM, path: a PNG, JPEG, GIF or WebP up to 5 MB: a screen recording, or a picture the "
                "project itself made; never one you drew, and one made with matplotlib is refused), or "
                "command (runs command in the VM and keeps the command, its exit code and its output, e.g. the failing test, "
                "the tool's wrong output). stage: before (the problem, before your change), after (the same with your change), "
                "or other. topic: a few words naming what is shown, the same for its before and after (e.g. \"help output\", "
                "\"tests\"). context: what this comparison shows and how to read it, for the user who doesn't know the project "
                "(the same text for a topic's before and after). caption: one line on what this side shows. Adding a topic and stage "
                "again replaces the old one. Pictures are real screenshots of the project running on the desktop: the app's window, "
                "or a terminal window running the program or a few lines that use the library; a short screen-recorded GIF of "
                "something that moves. Never a chart, table or side-by-side image you made. Raw output only when it speaks for itself.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "kind": {"type": "string", "enum": EVIDENCE_KINDS},
                        "stage": {"type": "string", "enum": EVIDENCE_STAGES},
                        "topic": {"type": "string"},
                        "context": {
                            "type": "string",
                            "description": "1 to 3 sentences in plain words: what is shown, what to look at, and what it means. E.g. 'Each "
                            "frame is what the chart showed while the slider moved to 0.7. The red line should follow the slider.'",
                        },
                        "caption": {"type": "string"},
                        "region": {"type": "array", "items": {"type": "integer"}, "description": "screenshot only: x, y, width, height"},
                        "path": {"type": "string", "description": "image only: the image file in the VM"},
                        "command": {"type": "string", "description": "command only: the shell command to run"},
                    },
                    "required": ["job_id", "kind", "stage", "topic", "context", "caption"],
                },
            )(self.evidence_add),
            tool(
                "evidence_remove",
                "Take evidence off one of your jobs, by id (my_jobs lists them), e.g. when it no longer fits your change. "
                "Drafts you already made keep theirs.",
                {"type": "object", "properties": {"job_id": {"type": "string"}, "ids": names}, "required": ["job_id", "ids"]},
            )(self.evidence_remove),
            tool(
                "vms_list",
                "See every VM: whether it runs, CPU, memory and disk, who holds it and how many wait, what it started "
                "with (the OS, languages, tools, ready-made Docker images and models of its image), and its notes: what agents "
                "and the user set up in it since (a project cloned and built, a service configured, what was added on top), "
                "oldest first, each with who wrote it and when. Use it to pick the VM that suits your jobs (choose_vm). "
                "You can't make VMs; only the user can.",
                {},
            )(self.vms_list),
            tool(
                "vm_note_add",
                "Add a note to the VM you hold, for the next agent that picks it or works in it: what is set up in it now and "
                "how it differs from a plain set-up. One thing per note, e.g. 'openclaw in ~/openclaw: pnpm install and build "
                "done, on main at 3f2a1c9 (Oct 27). Added the matrix plugin and turned on debug logs in ~/.openclaw for issue "
                "4120.' Facts that stay true, not a diary. Never a secret.",
                {"text": str},
            )(self.vm_note_add),
            tool(
                "vm_note_remove",
                "Take notes that are no longer true off the VM you hold, by id (vms_list shows them). Notes the user wrote "
                "can't be removed.",
                {"type": "object", "properties": {"ids": names}, "required": ["ids"]},
            )(self.vm_note_remove),
            tool(
                "choose_vm",
                "Make a VM your target VM: the one your jobs that need a VM run in. reason: in a few words why it suits them "
                "(e.g. 'has Rust and Postgres', 'free now'). Not while you wait for or hold a VM. If the user picked your VM, "
                "keep it unless it lacks what a job needs; then say why.",
                {"name": str, "reason": str},
            )(self.choose_vm),
            tool(
                "image_packages",
                "Search what a VM's image has installed: apt, pip, npm, cargo, snap, flatpak, VS Code extensions, Docker images "
                "and Playwright browsers, by name (e.g. 'libpq', 'torch'). vm is a VM's name. Returns up to 200 matches.",
                {"vm": str, "search": str},
            )(self.image_packages),
            tool(
                "queue_for_vm",
                "Join your target VM's queue to work in it. Either it is yours at once, or you get your place in line: then end your "
                "turn, and you get a message when it is yours (even while the VM is off, you keep your place).",
                {},
            )(self.queue_for_vm),
            tool(
                "release_vm",
                "Give your VM back so the next agent in line can use it. Do it as soon as your jobs for it are done or waiting on the user. "
                "While you wait in a VM's queue, it takes you out of the queue instead (e.g. when your jobs there were cancelled).",
                {},
            )(self.release_vm),
            tool(
                "vm_queue_status",
                "See your target VM, whether it is running, who holds it, who waits for it, and your own place.",
                {},
            )(self.vm_queue_status),
        ]

    def describe(self, name: str, args: dict) -> str:
        """The line the chat shows for a call, e.g. "Adding to Issues: pallets/click#812".

        Also for the GitHub tools and TodoWrite; the VM tools have their own (ComputerTools.describe).
        """
        if name == "repos_list":
            return "Looked at the Repos list"
        if name == "repos_add":
            return "Adding to Repos: " + ", ".join(args.get("names") or [])
        if name == "repos_remove":
            return "Removing from Repos: " + ", ".join(args.get("names") or [])
        if name == "repos_note":
            return f"Note on {args.get('name')}: {args.get('note')}"
        if name == "issues_list" and args.get("repo"):
            return f"Looked at the Issues list of {args['repo']}"
        if name == "issues_list":
            return "Looked at the Issues list"
        if name == "issues_add":
            return "Adding to Issues: " + ", ".join(args.get("issues") or [])
        if name == "issues_remove":
            return "Removing from Issues: " + ", ".join(args.get("ids") or [])
        if name == "issues_note":
            return f"Note on {args.get('id')}: {args.get('note')}"
        if name == "tracked_list":
            return "Looked at the Tracked list"
        if name == "tracked_add":
            return "Tracking: " + ", ".join(args.get("names") or [])
        if name == "tracked_remove":
            return "No longer tracking: " + ", ".join(args.get("names") or [])
        if name == "tracked_issues":
            which = args.get("which") or "free"
            return f"Looked at the {which} issues of " + (args.get("name") or "the tracked repos")
        if name == "my_jobs":
            return "Looked at its jobs"
        if name == "job_create":
            return f"New job: {args.get('title')}"
        if name == "job_update" and args.get("status"):
            return f"Job {args.get('job_id')}: {args['status']}"
        if name == "job_update":
            return f"Updated the notes of {args.get('job_id')}"
        if name == "job_progress" and args.get("step"):
            return f"{str(args['step']).replace('_', ' ').capitalize()}: {args.get('headline')}"
        if name == "job_progress":
            return f"Progress: {args.get('headline')}"
        if name == "run_tests":
            tests = "the basic checks" if args.get("scope") == "focused" else "the project's official checks"
            code = "on the unchanged code" if args.get("when") == "before" else "with the change"
            return f"Running {tests} {code}: `{args.get('command')}`"
        if name == "draft_comment":
            return f"Drafting a comment on {args.get('target')}"
        if name == "draft_question":
            return "Asking: " + (args.get("question") or "").split("\n")[0][:120]
        if name == "draft_pr" and args.get("pr"):
            return f"Drafting a new version of {args['pr']}: {args.get('title')}"
        if name == "draft_pr":
            return f"Drafting a PR: {args.get('title')}"
        if name == "artifacts_list":
            return f"Looking in its artifacts: {args.get('path') or '(top)'}"
        if name == "artifact_view":
            return f"Looking at {args.get('path')} in its artifacts"
        if name == "artifact_screenshot":
            return f"Screenshot into its artifacts: {args.get('path')}"
        if name == "artifact_from_vm":
            return f"Copying {args.get('source')} from the VM into its artifacts"
        if name == "artifact_to_vm":
            return f"Copying {args.get('path')} from its artifacts into the VM"
        if name == "name_yourself":
            return f"Naming itself {args.get('name')}"
        if name == "pr_examples":
            return f"Reading how {args.get('name')}'s people write their PRs"
        if name == "contributing_guide":
            return f"Reading {args.get('name')}'s rules for contributors"
        if name == "evidence_add":
            return f"Evidence, {args.get('stage')}: {args.get('topic')} ({args.get('kind')})"
        if name == "evidence_remove":
            return "Removing evidence: " + ", ".join(args.get("ids") or [])
        if name == "vms_list":
            return "Looked at the VMs"
        if name == "choose_vm":
            return f"Chose {args.get('name')}: {args.get('reason')}"
        if name == "image_packages":
            return f"Searched {args.get('vm')}'s image for `{args.get('search')}`"
        if name == "queue_for_vm":
            return f"Queuing for {self.record['target_vm']}"
        if name == "release_vm":
            return "Releasing its VM (or leaving the queue)"
        if name == "vm_queue_status":
            return "Looked at the VM queue"
        if name == "vm_note_add":
            return f"Note on its VM: {args.get('text')}"
        if name == "vm_note_remove":
            return "Removing notes from its VM: " + ", ".join(args.get("ids") or [])
        # Claude Code's todo list and the GitHub tools, which have no describe() of their own.
        if name == "TodoWrite":
            return "Updated its todo list"
        if name == "read_readme":
            return "Read README of " + ", ".join(args.get("names") or [])
        if name == "check_activity":
            return "Checked activity of " + ", ".join(args.get("names") or [])
        if name == "read_thread":
            return "Read " + ", ".join(args.get("threads") or [])
        if name == "list_files" and args.get("path"):
            return f"Listed files of {args.get('name')} in {args['path']}"
        if name == "list_files":
            return f"Listed files of {args.get('name')}"
        if name == "read_files":
            return "Read " + ", ".join(args.get("paths") or []) + f" in {args.get('name')}"
        if name == "search_code":
            return f"Searched code `{args.get('q')}`"
        if name == "search_issues":
            return f"Searched issues `{args.get('q')}`"
        return name

    async def repos_list(self, args: dict) -> dict:
        issues = await asyncio.to_thread(self.agents.issues.items)
        signals = await asyncio.to_thread(self.agents.repo_signals.all)
        type_names = {}
        for lane in self.agents.explore.profile["lanes"]:
            type_names[lane["id"]] = lane["label"]
        repos = []
        for item in await asyncio.to_thread(self.agents.repos.items):
            count = len([issue for issue in issues if issue["repo"] == item["full_name"]])
            repo_signals = signals.get(item["full_name"])
            summary = {
                "name": item["full_name"],
                "stars": item["stars"],
                "description": item["description"],
                "note": item["note"],
                "added_by": item["added_by"],
                "issues_in_list": count,
            }
            if item.get("lane"):
                summary["type"] = type_names.get(item["lane"], item["lane"])
            if repo_signals is not None:
                summary["ai_policy"] = repo_signals["ai_policy"]["tag"]
                summary["outside_merge_rate"] = repo_signals["outside_merge_rate"]
                summary["median_days_to_first_reply"] = repo_signals["median_days_to_first_reply"]
                summary["stale_outside_prs"] = repo_signals["stale_outside_prs"]
                summary["active_mergers_30d"] = repo_signals["active_mergers_30d"]
                if "newcomers" in repo_signals:
                    summary["newcomers"] = repo_signals["newcomers"]["tag"]
                    summary["prs_a_month"] = repo_signals["activity"]["prs_opened_month"]
                    summary["issues_a_month"] = repo_signals["activity"]["issues_opened_month"]
                    summary["commits_a_month"] = repo_signals["activity"]["commits_month"]
                if "reviewers" in repo_signals:
                    summary["reviewed_by"] = repo_signals["reviewers"]["tag"]
                if repo_signals.get("atmosphere"):
                    summary["review_tone"] = repo_signals["atmosphere"]["tone"]
                    summary["reviewers_ask_for"] = repo_signals["atmosphere"]["asks_for"]
            repos.append(summary)
        types = [{"name": lane["label"], "what_it_is": lane["about"]} for lane in self.agents.explore.profile["lanes"]]
        return {"content": [{"type": "text", "text": json.dumps({"types": types, "repos": repos})}]}

    async def repos_add(self, args: dict) -> dict:
        # The type, by its name, as the tag the repos get.
        lane_id = None
        if args.get("type"):
            lanes = self.agents.explore.profile["lanes"]
            for lane in lanes:
                if lane["label"].lower() == args["type"].strip().lower():
                    lane_id = lane["id"]
            if lane_id is None:
                names_text = ", ".join(lane["label"] for lane in lanes)
                return {"content": [{"type": "text", "text": f"There is no type {args['type']!r}. The types are: {names_text}. Nothing was added."}]}
        in_list = [item["full_name"].lower() for item in await asyncio.to_thread(self.agents.repos.items)]
        report = {}
        items = []
        for name in args["names"]:
            if name.count("/") != 1:
                report[name] = "not a full name (owner/name)"
                continue
            if name.lower() in in_list:
                report[name] = "already in Repos"
                continue
            try:
                info = await asyncio.to_thread(get_repository, name.split("/")[0], name.split("/")[1])
            except httpx.HTTPStatusError as error:
                report[name] = f"GitHub error {error.response.status_code}: {error.response.text[:200]}"
                continue
            except httpx.HTTPError as error:
                report[name] = f"could not reach GitHub: {error}"
                continue
            item = {
                "full_name": info["full_name"],
                "description": info["description"] or "",
                "stars": info["stargazers_count"],
                "default_branch": info["default_branch"],
                "html_url": info["html_url"],
                "note": args["note"],
                "added_by": self.agent_id,
                "added_at": datetime.now(UTC).isoformat(),
            }
            if lane_id is not None:
                item["lane"] = lane_id
            items.append(item)

        added = await asyncio.to_thread(self.agents.repos.add, items)
        for item in items:
            report[item["full_name"]] = "added" if item["full_name"] in added else "already in Repos"
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    async def repos_remove(self, args: dict) -> dict:
        removed = await asyncio.to_thread(self.agents.repos.remove, args["names"])
        missing = [name for name in args["names"] if name not in removed]
        text = json.dumps({"removed": removed, "not_in_list": missing})
        return {"content": [{"type": "text", "text": text}]}

    async def repos_note(self, args: dict) -> dict:
        try:
            await asyncio.to_thread(self.agents.repos.set_note, args["name"], args["note"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"{args['name']} is not in the Repos list."}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Note set on {args['name']}."}]}

    async def issues_list(self, args: dict) -> dict:
        repo = args.get("repo") or ""
        # The newest job of each issue gives its status. jobs.list() is newest first.
        latest = {}
        for job in reversed(self.agents.jobs.list()):
            latest[job["issue"]] = job

        tags = await asyncio.to_thread(self.agents.issue_tags.all)
        issues = []
        for item in await asyncio.to_thread(self.agents.issues.items):
            if repo and item["repo"].lower() != repo.lower():
                continue
            job = latest.get(item["id"])
            issues.append(
                {
                    "id": item["id"],
                    "title": item["title"],
                    "labels": item["labels"],
                    "state": item["state"],
                    "comments": item["comments"],
                    "note": item["note"],
                    "added_by": item["added_by"],
                    "status": job["status"] if job else "new",
                    "agent": job["agent"] if job else None,
                    # Made in the background after an issue is added; None until then.
                    "tags": tags.get(item["id"]),
                }
            )
        return {"content": [{"type": "text", "text": json.dumps({"issues": issues})}]}

    async def issues_add(self, args: dict) -> dict:
        in_list = [item["id"].lower() for item in await asyncio.to_thread(self.agents.issues.items)]
        report = {}
        items = []
        # Repo info by the issue's repo, for the Repos list.
        repos = {}
        for issue_id in args["issues"]:
            name = issue_id.split("#")[0]
            number = issue_id.split("#")[-1]
            if "#" not in issue_id or name.count("/") != 1 or not number.isdigit():
                report[issue_id] = "not owner/name#number"
                continue
            if issue_id.lower() in in_list:
                report[issue_id] = "already in Issues"
                continue
            try:
                info = await asyncio.to_thread(get_repository, name.split("/")[0], name.split("/")[1])
                # The repo's own spelling, so the issue matches its repo in the lists.
                name = info["full_name"]
                data = await asyncio.to_thread(get_thread, name.split("/")[0], name.split("/")[1], int(number))
            except httpx.HTTPStatusError as error:
                report[issue_id] = f"GitHub error {error.response.status_code}: {error.response.text[:200]}"
                continue
            except (httpx.HTTPError, ValueError) as error:
                report[issue_id] = f"could not read it from GitHub: {error}"
                continue
            if data is None:
                report[issue_id] = "no issue with that number"
                continue
            if data["__typename"] != "Issue":
                report[issue_id] = "a pull request, not an issue"
                continue
            repos[name] = info
            items.append(
                {
                    "id": f"{name}#{number}",
                    "repo": name,
                    "number": int(number),
                    "title": data["title"],
                    "labels": [label["name"] for label in data["labels"]["nodes"]],
                    "state": data["state"],
                    "comments": data["comments"]["totalCount"],
                    "html_url": f"https://github.com/{name}/issues/{number}",
                    "note": args["note"],
                    "added_by": self.agent_id,
                    "added_at": datetime.now(UTC).isoformat(),
                }
            )

        added = await asyncio.to_thread(self.agents.issues.add, items)
        for item in items:
            report[item["id"]] = "added" if item["id"] in added else "already in Issues"

        # The repo of each new issue goes into Repos too, so the user can look at its code.
        repos_in_list = [item["full_name"] for item in await asyncio.to_thread(self.agents.repos.items)]
        repo_items = []
        for name, info in repos.items():
            if name in repos_in_list:
                continue
            if not any(issue_id.startswith(name + "#") for issue_id in added):
                continue
            repo_items.append(
                {
                    "full_name": name,
                    "description": info["description"] or "",
                    "stars": info["stargazers_count"],
                    "default_branch": info["default_branch"],
                    "html_url": info["html_url"],
                    "note": "",
                    "added_by": self.agent_id,
                    "added_at": datetime.now(UTC).isoformat(),
                }
            )
        added_repos = await asyncio.to_thread(self.agents.repos.add, repo_items)
        result = {"issues": report}
        if added_repos:
            result["also_added_to_repos"] = added_repos
            result["hint"] = "These repos have no note yet; give each one with repos_note."
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    async def issues_remove(self, args: dict) -> dict:
        result = await asyncio.to_thread(self.agents.issues.remove, args["ids"])
        missing = [issue_id for issue_id in args["ids"] if issue_id not in result["removed"] and issue_id not in result["working"]]
        text = json.dumps({"removed": result["removed"], "kept_working": result["working"], "not_in_list": missing})
        return {"content": [{"type": "text", "text": text}]}

    async def issues_note(self, args: dict) -> dict:
        try:
            await asyncio.to_thread(self.agents.issues.set_note, args["id"], args["note"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"{args['id']} is not in the Issues list."}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Note set on {args['id']}."}]}

    async def tracked_list(self, args: dict) -> dict:
        checks = await asyncio.to_thread(self.agents.tracked_issues.all)
        tags = await asyncio.to_thread(self.agents.issue_tags.all)
        repos = []
        for item in await asyncio.to_thread(self.agents.tracked.items):
            check = checks.get(item["full_name"])
            summary = {
                "name": item["full_name"],
                "stars": item["stars"],
                "description": item["description"],
                "note": item["note"],
                "added_by": item["added_by"],
            }
            if check is None:
                summary["checked"] = "not yet (it will be within a minute)"
                repos.append(summary)
                continue
            summary["checked_at"] = check["checked_at"]
            summary["check_error"] = check["error"]
            summary["open_issues"] = len(check["issues"])
            # New for three days after it was opened. GitHub's time format, so it compares as text.
            new_since = (datetime.now(UTC) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
            free = 0
            assigned = 0
            for issue in check["issues"]:
                status = tags.get(f"{item['full_name']}#{issue['number']}", {}).get("status")
                if issue["assignees"] > 0 or status == "assigned":
                    assigned += 1
                elif status == "free":
                    free += 1
            summary["free"] = free
            summary["assigned"] = assigned
            summary["new"] = len([issue for issue in check["issues"] if issue["created_at"] > new_since])
            repos.append(summary)
        return {"content": [{"type": "text", "text": json.dumps({"tracked": repos})}]}

    async def tracked_add(self, args: dict) -> dict:
        in_list = [item["full_name"].lower() for item in await asyncio.to_thread(self.agents.tracked.items)]
        report = {}
        items = []
        for name in args["names"]:
            if name.count("/") != 1:
                report[name] = "not a full name (owner/name)"
                continue
            if name.lower() in in_list:
                report[name] = "already tracked"
                continue
            try:
                info = await asyncio.to_thread(get_repository, name.split("/")[0], name.split("/")[1])
            except httpx.HTTPStatusError as error:
                report[name] = f"GitHub error {error.response.status_code}: {error.response.text[:200]}"
                continue
            except httpx.HTTPError as error:
                report[name] = f"could not reach GitHub: {error}"
                continue
            items.append(
                {
                    "full_name": info["full_name"],
                    "description": info["description"] or "",
                    "stars": info["stargazers_count"],
                    "default_branch": info["default_branch"],
                    "html_url": info["html_url"],
                    "note": args.get("note") or "",
                    "added_by": self.agent_id,
                    "added_at": datetime.now(UTC).isoformat(),
                }
            )

        added = await asyncio.to_thread(self.agents.tracked.add, items)
        for item in items:
            report[item["full_name"]] = "now tracked; its issues are checked within a minute" if item["full_name"] in added else "already tracked"
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    async def tracked_remove(self, args: dict) -> dict:
        removed = await asyncio.to_thread(self.agents.tracked.remove, args["names"])
        missing = [name for name in args["names"] if name not in removed]
        text = json.dumps({"removed": removed, "not_tracked": missing})
        return {"content": [{"type": "text", "text": text}]}

    async def tracked_issues(self, args: dict) -> dict:
        name = args.get("name") or ""
        which = args.get("which") or "free"
        if which not in ("free", "assigned", "all"):
            return {"content": [{"type": "text", "text": "which must be free, assigned or all."}], "is_error": True}
        names = [item["full_name"] for item in await asyncio.to_thread(self.agents.tracked.items)]
        if name and name.lower() not in [tracked.lower() for tracked in names]:
            return {"content": [{"type": "text", "text": f"{name} is not tracked; tracked_list shows what is."}], "is_error": True}
        checks = await asyncio.to_thread(self.agents.tracked_issues.all)
        tags = await asyncio.to_thread(self.agents.issue_tags.all)
        in_issues = [item["id"] for item in await asyncio.to_thread(self.agents.issues.items)]
        # New for three days after it was opened. GitHub's time format, so it compares as text.
        new_since = (datetime.now(UTC) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")

        result = {}
        for full_name in names:
            if name and full_name.lower() != name.lower():
                continue
            check = checks.get(full_name)
            if check is None:
                result[full_name] = "not checked yet; try again in a minute"
                continue
            issues = []
            for issue in check["issues"]:
                issue_id = f"{full_name}#{issue['number']}"
                new = issue["created_at"] > new_since
                tag = tags.get(issue_id)
                status = tag["status"] if tag else None
                assigned = issue["assignees"] > 0 or status == "assigned"
                if which == "free" and (assigned or status != "free"):
                    continue
                if which == "assigned" and not assigned:
                    continue
                issues.append({**issue, "id": issue_id, "tags": tag, "new": new, "in_issues_list": issue_id in in_issues})
            result[full_name] = {"checked_at": check["checked_at"], "check_error": check["error"], "issues": issues}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    async def my_jobs(self, args: dict) -> dict:
        jobs = []
        for job in self.agents.jobs.for_agent(self.agent_id):
            if job["status"] in ["done", "cancelled"]:
                jobs.append({"id": job["id"], "title": job["title"], "status": job["status"]})
                continue
            drafts = []
            for draft_id in job["drafts"]:
                # The user may have deleted it from the Inbox.
                try:
                    draft = self.agents.inbox.get(draft_id)
                except KeyError:
                    continue
                drafts.append({"id": draft_id, "kind": draft["kind"], "title": draft["title"], "status": draft["status"], "reply": draft["reply"]})
            evidence = []
            for item in job["evidence"]:
                evidence.append({"id": item["id"], "kind": item["kind"], "stage": item["stage"], "topic": item["topic"], "caption": item["caption"]})
            jobs.append(
                {
                    "id": job["id"],
                    "kind": job["kind"],
                    "title": job["title"],
                    "issue": job["issue"],
                    "thread": job["thread"],
                    "repo": job["repo"],
                    "vm": job["vm"],
                    "status": job["status"],
                    "instructions": job["instructions"],
                    "notes": job["notes"],
                    "steps": job["steps"],
                    "step": job["step"],
                    "about": job["about"],
                    "headline": job["headline"],
                    "drafts": drafts,
                    "evidence": evidence,
                }
            )
        text = json.dumps({"target_vm": self.record["target_vm"], "jobs": jobs})
        return {"content": [{"type": "text", "text": text}]}

    async def job_create(self, args: dict) -> dict:
        kind = (args.get("kind") or "task").strip()
        title = (args.get("title") or "").strip()
        issue = (args.get("issue") or "").strip() or None
        if not title:
            return {"content": [{"type": "text", "text": "A job needs a title."}], "is_error": True}
        if issue is not None and ("#" not in issue or issue.split("#")[0].count("/") != 1 or not issue.split("#")[-1].isdigit()):
            return {"content": [{"type": "text", "text": "issue must be owner/name#number."}], "is_error": True}
        if kind == "fix_issue" and issue is None:
            return {"content": [{"type": "text", "text": "A fix_issue job needs its issue (owner/name#number)."}], "is_error": True}

        vm_name = self.record["target_vm"]
        job = self.agents.jobs.create(kind, title, self.agent_id, self.agent_id, issue=issue, vm=vm_name, instructions=args.get("instructions") or "")
        text = f"Made {job['id']}: {title}. It is for {vm_name}."
        if vm_name is None:
            text = f"Made {job['id']}: {title}. You have no target VM; if it needs one, pick it with vms_list and choose_vm."
        return {"content": [{"type": "text", "text": text}]}

    async def job_update(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it); it can't change anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        fields = {}
        if args.get("status"):
            fields["status"] = args["status"]
        if args.get("notes") is not None:
            fields["notes"] = args["notes"]
        if not fields:
            return {"content": [{"type": "text", "text": "Give a status, notes, or both."}], "is_error": True}
        if "status" in fields and fields["status"] not in AGENT_STATUSES:
            return {"content": [{"type": "text", "text": f"status must be one of: {', '.join(AGENT_STATUSES)}."}], "is_error": True}

        job = self.agents.jobs.update(job["id"], **fields)
        text = f"{job['id']} is {job['status']}."
        # Holding the VM with nothing left to do there means it should go back now.
        vm_name, place = self.agents.queue.place(self.agent_id)
        left = [other for other in self.agents.jobs.for_agent(self.agent_id) if other["status"] in OPEN_STATUSES and other["vm"] == vm_name]
        if place == 0 and not left:
            text += f" You have no open jobs left for {vm_name}: call release_vm now."
        return {"content": [{"type": "text", "text": text}]}

    async def job_progress(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it); it can't change anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        headline = args["headline"].strip()
        if not headline:
            return {"content": [{"type": "text", "text": "The headline is empty."}], "is_error": True}
        step = (args.get("step") or "").strip().lower().replace(" ", "_") or None
        if step is not None and step not in job["steps"]:
            return {"content": [{"type": "text", "text": f"step must be one of: {', '.join(job['steps'])}."}], "is_error": True}
        # The tests have to work on the unchanged code before any change is made. When another job on the same repo
        # already got the official checks passing on this VM, the project is set up there: that run counts for this job too.
        before = job["tests"]["before"]
        reused = None
        carry = job["kind"] == "fix_issue" and step in STEPS_AFTER_SETUP
        # A follow-up that changes its PR's code (its test step) takes such a run over too.
        if job["kind"] == "follow_up" and step == "test":
            carry = True
        if carry and before is None:
            for other in self.agents.jobs.list():
                run = other["tests"]["before"]
                if other["id"] == job["id"] or other["repo"] != job["repo"] or other["vm"] != self.record["target_vm"]:
                    continue
                if run is None or not run["passed"] or run.get("scope", "full") != "full":
                    continue
                if reused is None or run["at"] > reused["tests"]["before"]["at"]:
                    reused = other
        if reused is not None:
            before = reused["tests"]["before"]
            self.agents.jobs.update(job["id"], tests={"before": before, "after": None})
            for item in reused["evidence"]:
                if item["id"] == before["evidence"]:
                    self.agents.jobs.add_evidence(job["id"], item)
        if job["kind"] == "fix_issue" and step in STEPS_AFTER_SETUP and (before is None or not before["passed"]):
            text = (
                "You are still in set_up: get the project's tests passing on the unchanged code first "
                "(run_tests with when: before), then go on."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # A queued job (new, or back from the user's decision) is being worked on now. One waiting on the
        # user stays waiting: its draft is still in their Inbox.
        fields = {"headline": headline}
        if job["status"] == "queued":
            fields["status"] = "working"
        if step is not None:
            fields["step"] = step
        if args.get("detail") is not None:
            fields["detail"] = args["detail"].strip()
        if args.get("about") is not None:
            fields["about"] = args["about"].strip()
        job = self.agents.jobs.update(job["id"], **fields)
        text = f"{job['id']}: {(job['step'] or 'no step yet').replace('_', ' ')}, \"{job['headline']}\"."
        if reused is not None:
            text += (
                f" The project is already set up on {reused['vm']}: its official checks passed there on the unchanged code for "
                f"{reused['id']}, so that run counts for this job too. Run when: after with exactly that command: `{before['command']}`."
            )
        return {"content": [{"type": "text", "text": text}]}

    async def draft_comment(self, args: dict) -> dict:
        target = args["target"].strip()
        name = target.split("#")[0]
        if "#" not in target or name.count("/") != 1 or not target.split("#")[-1].isdigit():
            return {"content": [{"type": "text", "text": "target must be owner/name#number."}], "is_error": True}
        if not args["body"].strip():
            return {"content": [{"type": "text", "text": "The comment is empty."}], "is_error": True}
        overview = {
            "project": (args.get("project") or "").strip(),
            "problem": (args.get("problem") or "").strip(),
            "why": (args.get("why") or "").strip(),
        }
        for part, text in overview.items():
            limit = OVERVIEW_PROJECT_CHARS if part == "project" else OVERVIEW_PART_CHARS
            if not text:
                return {"content": [{"type": "text", "text": f"Give {part}: the user reads it to understand the comment."}], "is_error": True}
            if len(text) > limit:
                text = f"{part} is {len(text)} characters; keep it under {limit}. Short and plain: the user reads it at a glance."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        found = EMOJI.findall(" ".join([args["body"]] + list(overview.values())))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it): no drafts for it anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        draft = self.agents.inbox.create(
            "comment", self.agent_id, f"Comment on {target}", args["body"], job=job["id"], repo=name, target=target, evidence=job["evidence"], overview=overview
        )
        self.agents.jobs.update(job["id"], status="waiting_on_user", drafts=job["drafts"] + [draft["id"]])
        text = (
            f"{draft['id']} is in the user's Inbox. Nothing was posted: the user decides, and you'll get a message with their "
            f"decision. {job['id']} waits on the user now; move on to your next job."
        )
        return {"content": [{"type": "text", "text": text}]}

    async def draft_question(self, args: dict) -> dict:
        question = args["question"].strip()
        if not question:
            return {"content": [{"type": "text", "text": "The question is empty."}], "is_error": True}
        found = EMOJI.findall(question)
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        job = None
        if args.get("job_id"):
            try:
                job = self.agents.jobs.get(args["job_id"])
            except KeyError:
                return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
            if job["agent"] != self.agent_id:
                return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
            if job["status"] in CLOSED_STATUSES:
                text = f"{job['id']} is {job['status']} (the user may have cancelled it): no questions about it anymore. Move on."
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The subject line is the question's first line.
        title = question.split("\n")[0][:120]
        if job is None:
            self.agents.inbox.create("question", self.agent_id, title, question)
            text = "Your question is in the user's Inbox. You'll get a message with their answer."
            return {"content": [{"type": "text", "text": text}]}

        # A follow-up's question is about its PR or issue.
        target = job["thread"] or job["issue"]
        draft = self.agents.inbox.create("question", self.agent_id, title, question, job=job["id"], repo=job["repo"], target=target, evidence=job["evidence"])
        self.agents.jobs.update(job["id"], status="waiting_on_user", drafts=job["drafts"] + [draft["id"]])
        text = f"Your question is in the user's Inbox. {job['id']} waits on the user now; move on to your next job. You'll get a message with their answer."
        return {"content": [{"type": "text", "text": text}]}

    async def artifacts_list(self, args: dict) -> dict:
        try:
            listing = await asyncio.to_thread(self.agents.artifacts.list, self.agent_id, args.get("path") or "")
        except ArtifactsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        lines = [f"Your artifacts, {listing['path'] or 'the top'}:"]
        for entry in listing["entries"]:
            if entry["kind"] == "folder":
                lines.append(f"{entry['name']}/")
            else:
                when = datetime.fromtimestamp(entry["modified"], UTC).strftime("%Y-%m-%d %H:%M")
                lines.append(f"{entry['name']}  ({entry['size']:,} bytes, {when})")
        if not listing["entries"]:
            lines.append("(empty)")
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

    async def artifact_view(self, args: dict) -> dict:
        try:
            target = self.agents.artifacts.resolve(self.agent_id, args.get("path") or "")
        except ArtifactsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if not target.is_file():
            return {"content": [{"type": "text", "text": f"{args.get('path')} is not a file in your artifacts."}], "is_error": True}
        size = target.stat().st_size
        with open(target, "rb") as file:
            start = file.read(16)
        # The type comes from the file's first bytes, never its name.
        mime = ""
        if start.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif start.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif start.startswith(b"GIF87a") or start.startswith(b"GIF89a"):
            mime = "image/gif"
        elif start[:4] == b"RIFF" and start[8:12] == b"WEBP":
            mime = "image/webp"
        if mime != "" and size > IMAGE_LIMIT:
            text = f"{args.get('path')} is a picture over {IMAGE_LIMIT // 1_000_000} MB: too big to look at. Make a smaller copy in the VM."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if mime != "":
            data = await asyncio.to_thread(target.read_bytes)
            text = f"{args.get('path')} ({size:,} bytes)"
            return {"content": [{"type": "text", "text": text}, {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime}]}
        with open(target, "rb") as file:
            data = file.read(200_000)
        if b"\0" in data[:8192]:
            return {"content": [{"type": "text", "text": f"{args.get('path')} is not a picture or text ({size:,} bytes)."}]}
        text = data.decode("utf-8", errors="replace")[:50_000]
        if size > 50_000:
            text += f"\n[cut: the file has {size:,} bytes]"
        return {"content": [{"type": "text", "text": text}]}

    async def artifact_screenshot(self, args: dict) -> dict:
        path = (args.get("path") or "").strip()
        if not path.lower().endswith((".jpg", ".jpeg")):
            path += ".jpg"
        region = None
        if args.get("region"):
            region = args["region"]
            if len(region) != 4 or region[2] <= 0 or region[3] <= 0 or region[0] < 0 or region[1] < 0:
                return {"content": [{"type": "text", "text": "region is [x, y, width, height], all positive."}], "is_error": True}
            region = tuple(region)
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if vm_record.holder != self.agent_id:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        computer = Computer(vm_record.vm, f"sandbox-agent-{self.agent_id}")
        try:
            await asyncio.to_thread(computer.check)
            data = await asyncio.to_thread(computer.screenshot, EVIDENCE_QUALITY, region)
        except (ComputerError, subprocess.TimeoutExpired) as error:
            return {"content": [{"type": "text", "text": f"Could not take the screenshot: {error}"}], "is_error": True}
        try:
            saved = await asyncio.to_thread(self.agents.artifacts.save, self.agent_id, path, data)
        except ArtifactsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        text = f"Kept as {saved} in your artifacts. In chat it shows with ![what it shows](artifact:{saved})."
        return {"content": [{"type": "text", "text": text}, {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/jpeg"}]}

    async def artifact_from_vm(self, args: dict) -> dict:
        source = (args.get("source") or "").strip()
        if not source:
            return {"content": [{"type": "text", "text": "Give the path in the VM."}], "is_error": True}
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if vm_record.holder != self.agent_id:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # Commands run in the home folder, so ~/x and x are the same; the copy needs the full path.
        where = await asyncio.to_thread(vm_record.vm.exec, f"realpath -e -- {shlex.quote(source.removeprefix('~/'))}", 30)
        if where.returncode != 0:
            return {"content": [{"type": "text", "text": f"{source} is not in the VM."}], "is_error": True}
        try:
            saved = await asyncio.to_thread(self.agents.artifacts.from_vm, self.agent_id, vm_record.vm, where.stdout.strip(), args.get("folder") or "")
        except (ArtifactsError, FileTransferError) as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Copied into your artifacts as {saved}."}]}

    async def artifact_to_vm(self, args: dict) -> dict:
        path = (args.get("path") or "").strip()
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if vm_record.holder != self.agent_id:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            source = self.agents.artifacts.resolve(self.agent_id, path)
            # A link would be followed by the copy and could take a file of this computer into the VM.
            links = await asyncio.to_thread(self.agents.artifacts.has_links, self.agent_id, path)
        except ArtifactsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if path == "" or not source.exists():
            return {"content": [{"type": "text", "text": f"{path or 'The top folder'} is not a file or folder in your artifacts."}], "is_error": True}
        if links:
            return {"content": [{"type": "text", "text": f"{path} has links in it, which can't be copied."}], "is_error": True}
        folder = (args.get("folder") or "").strip().removeprefix("~/")
        where = await asyncio.to_thread(vm_record.vm.exec, f"realpath -e -- {shlex.quote(folder or '.')}", 30)
        if where.returncode != 0:
            return {"content": [{"type": "text", "text": f"{args.get('folder')} is not a folder in the VM."}], "is_error": True}
        try:
            await asyncio.to_thread(to_vm, vm_record.vm, str(source), where.stdout.strip())
        except FileTransferError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Copied into the VM as {where.stdout.strip()}/{source.name}."}]}

    async def name_yourself(self, args: dict) -> dict:
        name = (args.get("name") or "").strip()
        if self.record["name_by"] != "auto":
            who = "the user" if self.record["name_by"] == "user" else "you"
            text = f"Your name, {self.record['name']}, was given by {who}; it stays."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,29}", name):
            text = "A name is 2 to 30 lowercase letters, digits and hyphens, starting with a letter or digit, e.g. hermes-reasoning."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            self.agents.rename(self.agent_id, name, "agent")
        except ValueError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"You are {name} now."}]}

    async def pr_examples(self, args: dict) -> dict:
        name = (args.get("name") or "").strip()
        if name.count("/") != 1:
            return {"content": [{"type": "text", "text": "name must be owner/name."}], "is_error": True}
        try:
            pulls = await asyncio.to_thread(get_merged_prs, name.split("/")[0], name.split("/")[1])
        except (httpx.HTTPError, ValueError) as error:
            return {"content": [{"type": "text", "text": f"Could not read {name}'s merged PRs: {error}"}], "is_error": True}
        # Bots' PRs (dependency bumps, releases) say nothing about how people write theirs.
        people = []
        for pull in pulls:
            if pull["author"] is not None and pull["author"]["__typename"] != "Bot" and not pull["author"]["login"].endswith("[bot]"):
                people.append(pull)
        counts = {}
        for pull in people:
            login = pull["author"]["login"]
            counts[login] = counts.get(login, 0) + 1
        main = sorted(counts, key=lambda login: counts[login], reverse=True)[:PR_EXAMPLES_MAIN]
        outside = [pull for pull in people if pull["authorAssociation"] in OUTSIDE_ROLES and pull["author"]["login"] not in main]
        # Newest first, as GitHub gave them.
        chosen = []
        for login in main:
            theirs = [pull for pull in people if pull["author"]["login"] == login]
            chosen.extend(theirs[:PR_EXAMPLES_EACH])
        chosen.extend(outside[:PR_EXAMPLES_OUTSIDE])
        self.pr_examples_read.add(name.lower())

        lines = [f"Of the last {len(pulls)} merged PRs, {len(people)} are by people (not bots), {len(outside)} of those by outside contributors."]
        if main:
            lines.append("Main contributors: " + ", ".join(f"{login} ({counts[login]} merged)" for login in main) + ".")
        for pull in chosen:
            login = pull["author"]["login"]
            who = "main contributor" if login in main else "outside contributor"
            labels = ", ".join(label["name"] for label in pull["labels"]["nodes"]) or "none"
            body = (pull["body"] or "").strip()
            lines.append("")
            lines.append(f"=== #{pull['number']} by {login} ({pull['authorAssociation']}, {who}), merged {pull['mergedAt'][:10]} ===")
            lines.append(f"Title: {pull['title']}")
            lines.append(f"Labels: {labels}")
            lines.append(f"Description ({len(body)} characters):")
            if len(body) > PR_EXAMPLE_CHARS:
                body = body[:PR_EXAMPLE_CHARS] + "\n[cut]"
            lines.append(body or "(none)")
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

    async def contributing_guide(self, args: dict) -> dict:
        name = (args.get("name") or "").strip()
        if name.count("/") != 1:
            return {"content": [{"type": "text", "text": "name must be owner/name."}], "is_error": True}
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        try:
            info = await asyncio.to_thread(get_repository, owner, repo)
            tree = await asyncio.to_thread(get_tree, owner, repo, info["default_branch"])
        except (httpx.HTTPError, ValueError) as error:
            return {"content": [{"type": "text", "text": f"Could not read {name}: {error}"}], "is_error": True}
        ref = info["default_branch"]
        files = set()
        for item in tree["tree"]:
            if item["type"] == "blob":
                files.add(item["path"])

        # The repo's files with rules for contributors, wherever they are (see GUIDE_FILES): the contributing guides and
        # PR templates first, then AGENTS.md and the like, the ones nearest the top first. A translation
        # (CONTRIBUTING.es.md) says the same as its original.
        paths = []
        folder_rules = []
        for path in files:
            lower = path.lower()
            base = lower.split("/")[-1]
            if any(folder in lower for folder in GUIDE_SKIP_FOLDERS):
                continue
            if not base.endswith(GUIDE_TEXT_ENDINGS) and base != "contributing":
                continue
            if re.search(r"\.[a-z]{2}(-[a-z]{2})?\.[a-z]+$", base):
                continue
            guide = ("contribut" in base and not base.startswith("contributors")) or "contributing/" in lower
            if guide or "pull_request_template" in lower:
                paths.append(path)
            elif base in GUIDE_FILES and (lower == base or lower.startswith((".github/", "docs/")) and lower.count("/") == 1):
                paths.append(path)
            elif base == "agents.md":
                folder_rules.append(path)
        paths.sort(key=lambda path: (0 if "contribut" in path.lower() or "pull_request_template" in path.lower() else 1, path.count("/"), len(path)))
        folder_rules.sort()

        # Read them all at once, and the README for its links.
        results = await asyncio.gather(*[asyncio.to_thread(get_contents, owner, repo, path, ref) for path in paths], return_exceptions=True)
        documents = []
        for path, data in zip(paths, results):
            if isinstance(data, Exception) or isinstance(data, list) or data.get("encoding") != "base64":
                continue
            documents.append((path, base64.b64decode(data["content"]).decode("utf-8", errors="replace")))
        # No CONTRIBUTING of its own: GitHub shows the one in the owner's .github repo instead, when there is one.
        if not any("contribut" in path.lower() for path, text in documents):
            for path in ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]:
                try:
                    data = await asyncio.to_thread(get_contents, owner, ".github", path)
                except (httpx.HTTPError, ValueError):
                    continue
                if isinstance(data, dict) and data.get("encoding") == "base64":
                    documents.append((f"{owner}/.github: {path}", base64.b64decode(data["content"]).decode("utf-8", errors="replace")))
                    break
        try:
            readme = await asyncio.to_thread(get_readme, owner, repo)
        except (httpx.HTTPError, ValueError):
            readme = ""

        # Links to more rules, in the README and in those files: [text](address) or a bare address, followed when the
        # text or the address says it is about contributing. A file of this repo (a relative link, or its GitHub link)
        # is read from the repo; another file on GitHub as its raw text; anything else as a web page.
        linked = []
        urls = []
        this_repo = f"https://github.com/{owner}/{repo}/".lower()
        for source, text in [("README.md", readme)] + documents:
            folder = posixpath.dirname(source) if ": " not in source else ""
            for match in re.finditer(r"\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)|(https?://[^\s<>\"'`)\]]+)", text):
                label = match.group(1) or ""
                address = (match.group(2) or match.group(3)).split("#")[0]
                if address == "" or not any(word in (label + " " + address).lower() for word in GUIDE_LINK_WORDS):
                    continue
                if address.lower().startswith(this_repo):
                    # .../blob/<branch>/<path> or .../tree/<branch>/<path>
                    parts = address[len(this_repo):].split("/", 2)
                    if len(parts) != 3 or parts[0] not in ["blob", "tree"]:
                        continue
                    path = parts[2]
                elif address.startswith("https://"):
                    if address not in urls:
                        urls.append(address)
                    continue
                elif ":" in address:
                    continue
                elif address.startswith("/"):
                    path = posixpath.normpath(address.lstrip("/"))
                else:
                    path = posixpath.normpath(posixpath.join(folder, address))
                if path in files and path not in paths and path not in linked:
                    linked.append(path)
        results = await asyncio.gather(*[asyncio.to_thread(get_contents, owner, repo, path, ref) for path in linked], return_exceptions=True)
        for path, data in zip(linked, results):
            if isinstance(data, Exception) or isinstance(data, list) or data.get("encoding") != "base64":
                continue
            documents.append((path, base64.b64decode(data["content"]).decode("utf-8", errors="replace")))
        for url in urls[:GUIDE_PAGES]:
            address = url
            match = re.match(r"https://github\.com/([^/]+)/([^/]+)/blob/(.+)", url)
            if match:
                address = f"https://raw.githubusercontent.com/{match.group(1)}/{match.group(2)}/{match.group(3)}"
            try:
                host = httpx.URL(address).host
                if host == "localhost" or re.fullmatch(r"[0-9.]+|[0-9a-fA-F:]*:[0-9a-fA-F:]*", host):
                    continue
                response = await asyncio.to_thread(httpx.get, address, follow_redirects=True, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            except (httpx.HTTPError, httpx.InvalidURL) as error:
                documents.append((f"{url} (web page)", f"Could not read it: {error}"))
                continue
            # Only public pages: never this computer or its network, also not after a redirect.
            host = response.url.host
            if host == "localhost" or re.fullmatch(r"[0-9.]+|[0-9a-fA-F:]*:[0-9a-fA-F:]*", host) or response.url.scheme != "https":
                continue
            if response.status_code != 200:
                documents.append((f"{url} (web page)", f"The page answered {response.status_code}."))
                continue
            # A badge or a picture behind the link is no guide.
            if not response.headers.get("content-type", "").startswith("text/"):
                continue
            text = response.text[:2_000_000]
            if "html" in response.headers.get("content-type", ""):
                text = re.sub(r"(?is)<(script|style|nav|header|footer|svg)\b.*?</\1>", " ", text)
                text = re.sub(r"(?s)<[^>]+>", " ", text)
                text = html.unescape(text)
                text = re.sub(r"[ \t\r\f\v]+", " ", text)
                text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
            documents.append((f"{url} (web page)", text))

        self.guides_read.add(name.lower())
        if not documents and not folder_rules:
            text = (
                f"{name} has no rules for contributors that could be found: no CONTRIBUTING, developer guide, PR template or "
                "AGENTS.md in the repo, and no link to one in its README. Go by its README and its CI config (.github/workflows/)."
            )
            return {"content": [{"type": "text", "text": text}]}
        lines = [
            f"The rules for contributors to {name}: {len(documents)} documents. Follow every rule in them, however long the "
            "checks they ask for take."
        ]
        total = 0
        left = []
        for title, text in documents:
            if total >= GUIDE_TOTAL_CHARS:
                left.append(title)
                continue
            if len(text) > GUIDE_CHARS:
                line = text[:GUIDE_CHARS].count("\n") + 1
                text = text[:GUIDE_CHARS] + f"\n[cut at line {line}: read on with read_files, start_line {line}]"
            total += len(text)
            lines.append("")
            lines.append(f"=== {title} ===")
            lines.append(text)
        if left:
            lines.append("")
            lines.append("Too much to show at once, read these with read_files too: " + ", ".join(left))
        if folder_rules:
            lines.append("")
            lines.append("These folders have rules of their own: read the one for each folder you change (read_files): " + ", ".join(folder_rules))
        if tree.get("truncated"):
            lines.append("")
            lines.append("GitHub listed only part of this big repo: look with list_files for more guides in its docs.")
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

    async def draft_pr(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it): no drafts for it anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if not args["title"].strip():
            return {"content": [{"type": "text", "text": "The PR needs a title."}], "is_error": True}
        # The next version of the user's open PR (a follow-up: a reviewer asked for changes, or its checks failed): approving
        # pushes it onto that PR's branch and posts the body there as a comment (github_account.py). The repo is the PR's.
        pr = (args.get("pr") or "").strip() or None
        repo = job["repo"]
        if pr is not None and ("#" not in pr or pr.split("#")[0].count("/") != 1 or not pr.split("#")[-1].isdigit()):
            return {"content": [{"type": "text", "text": "pr must be owner/name#number: the user's open PR this is the next version of."}], "is_error": True}
        if pr is not None:
            repo = pr.split("#")[0]
        # The user reads the overview first: it must be there, and short.
        overview = {
            "project": (args.get("project") or "").strip(),
            "problem": (args.get("problem") or "").strip(),
            "cause": (args.get("cause") or "").strip(),
            "fix": (args.get("fix") or "").strip(),
        }
        for part, text in overview.items():
            limit = OVERVIEW_PROJECT_CHARS if part == "project" else OVERVIEW_PART_CHARS
            if not text:
                return {"content": [{"type": "text", "text": f"Give {part}: the user reads it to understand the PR."}], "is_error": True}
            if len(text) > limit:
                text = f"{part} is {len(text)} characters; keep it under {limit}. Short and plain: the user reads it at a glance."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        risks = [risk.strip() for risk in (args.get("risks") or []) if risk.strip()]
        if not risks or len(risks) > OVERVIEW_RISKS_MAX:
            text = f"Give 1 to {OVERVIEW_RISKS_MAX} risks: real ways this change could still go wrong or be turned down."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        for risk in risks:
            if len(risk) > OVERVIEW_RISK_CHARS:
                text = f"A risk is {len(risk)} characters; keep each under {OVERVIEW_RISK_CHARS}."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        overview["risks"] = risks
        found = EMOJI.findall(" ".join([args["title"], args["body"], overview["project"], overview["problem"], overview["cause"], overview["fix"]] + risks))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        # Written from the project's rules and the way its own people write their PRs: the agent has to have read both.
        # A new version of an open PR keeps that PR's description, so only the rules (its commits follow them too).
        if repo is not None and repo.lower() not in self.guides_read:
            text = f"First read {repo}'s rules for contributors (contributing_guide), then write the PR the way they say."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if pr is None and repo is not None and repo.lower() not in self.pr_examples_read:
            text = f"First read how {repo}'s own people write their PRs (pr_examples), then write yours the same way."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The job's pictures go in the body, as ![what](evidence:ev_...): the Inbox shows them there, and sending
        # uploads them to the user's fork (github_account.py).
        pictures = [item["id"] for item in job["evidence"] if item["kind"] in ["screenshot", "image"]]
        shown = re.findall(r"evidence:(ev_[0-9a-f]{6})", args["body"])
        unknown = [evidence_id for evidence_id in shown if evidence_id not in pictures]
        if unknown:
            text = f"The body shows {', '.join(unknown)}, which aren't pictures of {job['id']}: use the ids evidence_add gave your screenshots and images."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # A new version's comment shows its pictures when it has new ones to show; the PR already shows the old ones.
        if pictures and not shown and pr is None:
            text = (
                "Put your before and after pictures in the body, where the project's template asks for screenshots (else in a "
                "short Screenshots section at the end), as a table:\n| Before | After |\n| --- | --- |\n"
                "| ![before](evidence:ev_a1b2c3) | ![after](evidence:ev_d4e5f6) |\nwith your evidence ids. They are uploaded with the PR."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The user decides on evidence, not on the agent's word: no PR without a before and an after
        # of the problem itself (the test suite's runs are kept apart: they show nothing about the issue).
        # A follow-up's change is often one nobody can see (a rename a reviewer asked for): its test runs are its proof,
        # and it adds a before and after when there is something to show.
        stages = [item["stage"] for item in job["evidence"] if item["topic"] not in TESTS_TOPICS.values()]
        if job["kind"] != "follow_up" and ("before" not in stages or "after" not in stages):
            text = (
                "A PR draft needs evidence the user can judge it by: at least one 'before' (the problem without your change) "
                "and one 'after' (the same thing with your change), under the same topic, added with evidence_add. "
                "If you already changed the code, show the before with `git stash`, add it, then `git stash pop`."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if vm_record.holder != self.agent_id:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Commands run in the user's home, so ~/click and click are the same folder.
        folder = shlex.quote(args["path"].strip().removeprefix("~/"))
        base = shlex.quote(args["base"].strip())
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, f"cd {folder} && pwd && git rev-parse --abbrev-ref HEAD", 60)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        if result.returncode != 0:
            # Hidden as in the bash tool: error text can hold the user's secrets too.
            text = f"Not a git repo folder: {result.stderr.strip()}"
            for value in sorted(list(vm_record.global_env.values()) + list(vm_record.env.values()), key=len, reverse=True):
                if len(value) >= HIDE_MIN_LENGTH:
                    text = text.replace(value, "[hidden]")
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        path = result.stdout.strip().split("\n")[0]
        branch = result.stdout.strip().split("\n")[-1]

        # The project's PR template, if it has one: the draft says whether the body keeps its headings (the Inbox shows
        # that), and the agent hears which it left out. Not a rule: many projects' merged PRs don't use the template, and
        # the user may ask for another form. The first line printed is the template's path, the rest its text; nothing
        # printed means there is none.
        command = (
            f"cd {folder} && f=$(find . .github docs -maxdepth 1 -iname pull_request_template.md 2>/dev/null | head -1); "
            '[ -z "$f" ] || { echo "$f"; cat "$f"; }'
        )
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, command, 60)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        template = None
        left_out = ""
        if result.stdout.strip():
            template = result.stdout.split("\n")[0].removeprefix("./")
            template_text = "\n".join(result.stdout.split("\n")[1:])
            # Headings compared without case, extra spaces and emoji (the body has none), the way they read.
            body_lines = [" ".join(line.split()).lower() for line in args["body"].split("\n")]
            missing = []
            for line in template_text.split("\n"):
                heading = " ".join(EMOJI.sub("", line).split())
                if heading.startswith("#") and heading.lower() not in body_lines:
                    missing.append(heading)
            if missing:
                left_out = (
                    f" It leaves out these headings of the project's PR template ({template}): {', '.join(missing)}. That is right "
                    "when the user asked for another form or the project's merged PRs don't use the template; otherwise draft again in its form."
                )
                template = None
        # A new version of an open PR has no description of its own: its body is a comment, so no template.
        if pr is not None:
            template = None
            left_out = ""

        # -N marks new files as "intent to add", so git diff shows them too. head stops a huge diff
        # inside the VM (one byte over the limit is enough to tell), so it never fills this machine's memory.
        command = f"set -o pipefail; cd {folder} && git add -A -N . && git diff {base} | head -c {DIFF_LIMIT + 1}"
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, command, 120)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        diff = result.stdout
        # Before the exit code: head stopping git diff makes the pipe fail too.
        if len(diff.encode()) > DIFF_LIMIT:
            text = (
                f"The diff is over the {DIFF_LIMIT // 1000} KB limit. A fix is never that big: look for build output, lockfiles "
                "or a virtualenv in it (git diff --stat), remove them or add them to .git/info/exclude, then try again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if result.returncode != 0:
            text = f"git diff failed: {result.stderr.strip()}"
            for value in sorted(list(vm_record.global_env.values()) + list(vm_record.env.values()), key=len, reverse=True):
                if len(value) >= HIDE_MIN_LENGTH:
                    text = text.replace(value, "[hidden]")
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if not diff.strip():
            text = f"There is no difference between {args['path']} and {args['base']}: nothing to draft."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The diff is shown in the Inbox, sent to the browser and downloaded as it is: a secret (a VM env
        # value, e.g. written into a .env file) must never be in it. Named by its variable, never its value.
        for env_name, value in list(vm_record.global_env.items()) + list(vm_record.env.items()):
            if len(value) < HIDE_MIN_LENGTH or value not in diff:
                continue
            # One chunk per file; each starts with "a/<path> b/<path>" (the first with "diff --git ").
            chunks = diff.split("\ndiff --git ")
            files = [chunk.split("\n")[0].split(" b/")[-1] for chunk in chunks if value in chunk]
            text = (
                f"The diff contains the value of the environment variable {env_name}, in: {', '.join(files)}. Take it out "
                "of those files, or keep the file out of the diff (delete it, or add it to .git/info/exclude), then try again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # What GitNexus writes by itself when an agent builds its index (analyze): its block in AGENTS.md and CLAUDE.md
        # (the symbol counts), its skills in .claude/skills/gitnexus/ and its .gitnexus/ folder. None of it is the fix.
        tool_files = []
        for chunk in diff.split("\ndiff --git "):
            path = chunk.split("\n")[0].split(" b/")[-1]
            changed = [line for line in chunk.split("\n")[1:] if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))]
            if path.startswith((".gitnexus/", ".claude/skills/gitnexus/")):
                tool_files.append(path)
            elif path.split("/")[-1] in ["AGENTS.md", "CLAUDE.md"] and any("gitnexus" in line.lower() for line in changed):
                tool_files.append(path)
        if tool_files:
            text = (
                f"The diff changes what GitNexus writes by itself when it builds its index: {', '.join(tool_files)}. That isn't "
                f"your fix and must not be in the PR: restore them (git checkout {args['base']} -- <file>; git clean for new "
                "files), keep them out of your commits (take them out of a commit that has them), check git status, then try again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Finished means the project's tests pass: before the change, and after it on exactly this code.
        before = job["tests"]["before"]
        after = job["tests"]["after"]
        if before is None or not before["passed"]:
            text = (
                "No PR without the project's tests: they must have passed on the unchanged code first (run_tests with when: before). "
                "If you already changed the code, `git stash -u`, run it, then `git stash pop`."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if after is None or not after["passed"] or after["command"] != before["command"]:
            text = f"No PR until the tests pass with your change: run_tests with when: after and the command `{before['command']}`."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if after["diff_hash"] != hashlib.sha256(diff.encode()).hexdigest():
            text = (
                "The code changed since the tests last passed (or the test run left new files behind: add those to "
                ".git/info/exclude). Run run_tests with when: after again on the code as it is now, then draft."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The commit the diff starts from, as it is now: sending the PR builds it on that commit (github_account.py),
        # wherever the base moves later.
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, f"cd {folder} && git rev-parse --verify {base}^{{commit}}", 60)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        base_sha = result.stdout.strip()
        if result.returncode != 0 or re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", base_sha) is None:
            return {"content": [{"type": "text", "text": f"{args['base']} is not a commit in {args['path']}."}], "is_error": True}

        # A new version goes on top of the open PR's newest commit, so that it can be pushed onto its branch as it is.
        if pr is not None:
            try:
                pull = await asyncio.to_thread(get_pr_status, repo.split("/")[0], repo.split("/")[1], int(pr.split("#")[1]))
            except (httpx.HTTPError, ValueError) as error:
                return {"content": [{"type": "text", "text": f"Could not read {pr}: {error}"}], "is_error": True}
            if pull is None:
                return {"content": [{"type": "text", "text": f"{pr} is not a PR on GitHub."}], "is_error": True}
            if pull["state"] != "OPEN":
                text = f"{pr} is {pull['state'].lower()}: only an open PR takes a new version. Tell the user in a draft_comment or draft_question instead."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            newest = ""
            if pull["commits"]["nodes"]:
                newest = pull["commits"]["nodes"][0]["commit"]["oid"]
            if newest != base_sha:
                text = (
                    f"base must be {pr}'s newest commit, {newest}, and {args['base']} is {base_sha}. Fetch its branch again, put "
                    "your work on top of that commit, run the tests again (when: after, base that commit), then draft."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Every commit must be the agent's own, by the VM's git address: never someone else's fix cherry-picked in, and no
        # co-authors (the user's rule). The first line printed is that address, possibly empty; the second how many
        # Co-authored-by lines the commit messages have; then each commit.
        command = (
            f"cd {folder} && echo \"$(git config user.email)\" && echo \"$(git log --format=%B {base}..HEAD | grep -ci '^co-authored-by:')\" && "
            f"git log --format=%ae%x1f%an%x1f%h%x1f%s {base}..HEAD"
        )
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, command, 60)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        if result.returncode != 0:
            return {"content": [{"type": "text", "text": f"Could not read your branch's commits: {result.stderr.strip()}"}], "is_error": True}
        vm_email = result.stdout.split("\n")[0].strip()
        if result.stdout.split("\n")[1:2] != ["0"]:
            text = "A commit message on your branch has a Co-authored-by line. Credit no co-author: reword it (git commit --amend or a rebase), then draft again."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        others = []
        for line in result.stdout.strip().split("\n")[2:]:
            fields = line.split("\x1f", 3)
            if len(fields) == 4 and fields[0] != vm_email:
                others.append(f"{fields[2]} by {fields[1]} <{fields[0]}>: {fields[3]}")
        if others:
            text = (
                f"Your branch has commits that aren't yours (your git address in the VM is {vm_email or 'not set'}): "
                + "; ".join(others)
                + ". Every commit must be your own work: never cherry-pick or copy someone else's fix, and credit no co-author. "
                f"Take them out (e.g. `git reset --soft {args['base']}`, set `git config user.email` if it isn't, then commit your "
                "own change), run the tests again if the code changed, and draft again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The branch's commits on top of base, as they are: sending replays them (their messages), so the history goes
        # out too. %x1e starts each commit, %x1f splits its fields, its patch comes last; the VM's git address comes
        # first. None kept when the branch has a merge, doesn't start right at base, or is too big: sending then makes one
        # commit (github_account.py).
        command = (
            f"set -o pipefail; cd {folder} && git config user.email && test -z \"$(git rev-list --merges {base}..HEAD)\" && "
            f"git log --reverse -p --format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B%x1f {base}..HEAD | head -c {DIFF_LIMIT + 1}"
        )
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, command, 120)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        commits = []
        if result.returncode == 0 and len(result.stdout.encode()) <= DIFF_LIMIT:
            parent = base_sha
            vm_email = result.stdout.split("\x1e")[0].strip()
            for record in result.stdout.split("\x1e")[1:]:
                fields = record.split("\x1f", 6)
                if len(fields) != 7 or fields[1] != parent:
                    commits = []
                    break
                commits.append({
                    "sha": fields[0],
                    "message": fields[5].strip() + "\n",
                    "author": {"name": fields[2], "email": fields[3], "date": fields[4]},
                    # The agent's own (by the VM's git address), as every one is now: they go out with the user's name.
                    "own": fields[3] == vm_email,
                    "vm_email": vm_email,
                    "diff": fields[6].lstrip("\n"),
                })
                parent = fields[0]
        # A secret in a commit goes out with the history, even when a later commit took it out again.
        for env_name, value in list(vm_record.global_env.items()) + list(vm_record.env.items()):
            if len(value) < HIDE_MIN_LENGTH:
                continue
            for commit in commits:
                if value in commit["message"] or value in commit["diff"]:
                    text = (
                        f"Commit {commit['sha'][:10]} on your branch contains the value of the environment variable {env_name}, and it "
                        f"would go out with the PR. Take it out of the branch's history (e.g. `git reset --soft {args['base']}` and "
                        "commit again), then try again."
                    )
                    return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The user may have cancelled the job while the commands ran.
        job = self.agents.jobs.get(job["id"])
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} now (the user may have cancelled it): no draft was made. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        target = job["issue"]
        if pr is not None:
            target = pr
        draft = self.agents.inbox.create(
            "pr",
            self.agent_id,
            args["title"].strip(),
            args["body"],
            job=job["id"],
            repo=repo,
            target=target,
            diff=diff,
            branch=branch,
            base=args["base"].strip(),
            base_sha=base_sha,
            commits=commits,
            vm=vm_name,
            path=path,
            evidence=job["evidence"],
            overview=overview,
            template=template,
            update_of=pr,
        )
        fields = {"status": "waiting_on_user", "drafts": job["drafts"] + [draft["id"]]}
        # A PR draft is the draft step, even if the agent didn't say so.
        if "draft" in job["steps"]:
            fields["step"] = "draft"
        self.agents.jobs.update(job["id"], **fields)

        lines = diff.split("\n")
        files = len([line for line in lines if line.startswith("diff --git ")])
        added = len([line for line in lines if line.startswith("+") and not line.startswith("+++")])
        removed = len([line for line in lines if line.startswith("-") and not line.startswith("---")])
        what = f"branch {branch} against {args['base']}"
        if pr is not None:
            what = f"a new version of {pr}, on top of its newest commit"
        text = (
            f"{draft['id']} is in the user's Inbox: {files} files, +{added} -{removed}, {what}, "
            f"with {len(job['evidence'])} pieces of evidence. "
            f"Nothing was pushed or sent: the user reviews it, and you'll get a message with their decision. "
            f"{job['id']} waits on the user now; move on to your next job (release_vm if none is left for {vm_name})."
            f"{left_out}"
        )
        return {"content": [{"type": "text", "text": text}]}

    async def evidence_add(self, args: dict) -> dict:
        kind = args.get("kind") or ""
        stage = args.get("stage") or ""
        topic = (args.get("topic") or "").strip()
        caption = (args.get("caption") or "").strip()
        context = (args.get("context") or "").strip()
        if kind not in EVIDENCE_KINDS:
            return {"content": [{"type": "text", "text": f"kind must be one of: {', '.join(EVIDENCE_KINDS)}."}], "is_error": True}
        if stage not in EVIDENCE_STAGES:
            return {"content": [{"type": "text", "text": f"stage must be one of: {', '.join(EVIDENCE_STAGES)}."}], "is_error": True}
        if not topic:
            text = "Give a topic: a few words naming what is shown, the same for its before and after."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if not caption:
            return {"content": [{"type": "text", "text": "Give a caption: one line on what this side shows."}], "is_error": True}
        if not context:
            text = "Give context: what this comparison shows, what to look at and what it means, for someone who doesn't know the project."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if len(context) > CONTEXT_CHARS:
            return {"content": [{"type": "text", "text": f"context is {len(context)} characters; keep it under {CONTEXT_CHARS}."}], "is_error": True}
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it): no evidence for it anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if vm_record.holder != self.agent_id:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The same tag as the agent's VM tools (ComputerTools), so losing the VM stops these commands too.
        tag = f"sandbox-agent-{self.agent_id}"
        # The user's secrets, longest first, so a value that contains another one is hidden whole.
        hidden = [value for value in sorted(list(vm_record.global_env.values()) + list(vm_record.env.values()), key=len, reverse=True) if len(value) >= HIDE_MIN_LENGTH]
        evidence_id = "ev_" + secrets.token_hex(3)
        item = {
            "id": evidence_id,
            "kind": kind,
            "topic": topic,
            "stage": stage,
            "context": context,
            "caption": caption,
            "file": None,
            "command": None,
            "exit_code": None,
            "output_file": None,
            "output_tail": "",
            "output_size": 0,
            "created_at": datetime.now(UTC).isoformat(),
        }
        data = b""
        mime = ""
        output = ""

        if kind == "screenshot":
            region = None
            if args.get("region"):
                region = args["region"]
                if len(region) != 4 or region[2] <= 0 or region[3] <= 0 or region[0] < 0 or region[1] < 0:
                    return {"content": [{"type": "text", "text": "region is [x, y, width, height], all positive."}], "is_error": True}
                region = tuple(region)
            computer = Computer(vm_record.vm, tag)
            try:
                await asyncio.to_thread(computer.check)
                data = await asyncio.to_thread(computer.screenshot, EVIDENCE_QUALITY, region)
            except (ComputerError, subprocess.TimeoutExpired) as error:
                text = f"Could not take the screenshot: {error}"
                for value in hidden:
                    text = text.replace(value, "[hidden]")
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            item["file"] = f"{evidence_id}.jpg"
            mime = "image/jpeg"

        if kind == "image":
            path = (args.get("path") or "").strip()
            if not path:
                return {"content": [{"type": "text", "text": "Give the image's path in the VM."}], "is_error": True}
            # Commands run in the user's home, so ~/plot.png and plot.png are the same file. One byte
            # over the limit is enough to tell, and a huge file never fills this machine's memory.
            command = f"set -o pipefail; head -c {IMAGE_LIMIT + 1} {shlex.quote(path.removeprefix('~/'))} | base64 -w0"
            try:
                result = await asyncio.to_thread(vm_record.vm.exec, command, 60, None, tag)
            except subprocess.TimeoutExpired:
                return {"content": [{"type": "text", "text": "Reading the image took too long."}], "is_error": True}
            if result.returncode != 0:
                text = f"Could not read {path}: {result.stderr.strip()}"
                for value in hidden:
                    text = text.replace(value, "[hidden]")
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            data = base64.b64decode(result.stdout)
            if len(data) > IMAGE_LIMIT:
                text = f"{path} is over {IMAGE_LIMIT // 1_000_000} MB. Save it smaller (a lower resolution, or JPEG) and try again."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            # The type comes from the file's first bytes, never its name. No SVG: it can carry scripts.
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                item["file"] = f"{evidence_id}.png"
                mime = "image/png"
            elif data.startswith(b"\xff\xd8\xff"):
                item["file"] = f"{evidence_id}.jpg"
                mime = "image/jpeg"
            elif data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
                item["file"] = f"{evidence_id}.gif"
                mime = "image/gif"
            elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                item["file"] = f"{evidence_id}.webp"
                mime = "image/webp"
            else:
                return {"content": [{"type": "text", "text": f"{path} is not a PNG, JPEG, GIF or WebP image."}], "is_error": True}
            # Pictures are real screenshots, never ones the agent drew (the user's rule). matplotlib marks its files.
            if MATPLOTLIB_MARK in data[:4096].lower() and "matplotlib" not in (job["repo"] or "").lower():
                text = (
                    f"{path} was made with matplotlib: a picture you drew. Evidence must be a real screenshot of the project "
                    "running on the desktop: its window, or a terminal window running it (kind screenshot). If the project itself "
                    "makes this picture, open it in its window or an image viewer and take a screenshot."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        if kind == "command":
            command = (args.get("command") or "").strip()
            if not command:
                return {"content": [{"type": "text", "text": "Give the command to run."}], "is_error": True}
            # Output and errors together, in the order they came, as in a terminal. tail keeps the end and never
            # stops the command; pipefail makes the exit code the command's. The newline ends a comment on its last line.
            capped = f"set -o pipefail; {{ {command}\n}} 2>&1 | tail -c {OUTPUT_LIMIT}"
            try:
                result = await asyncio.to_thread(vm_record.vm.exec, capped, 600, None, tag)
            except subprocess.TimeoutExpired:
                return {"content": [{"type": "text", "text": "The command ran over 10 minutes and was stopped."}], "is_error": True}
            output = result.stdout
            for value in hidden:
                output = output.replace(value, "[hidden]")
                command = command.replace(value, "[hidden]")
            item["command"] = command
            item["exit_code"] = result.returncode
            item["output_file"] = f"{evidence_id}.txt"
            item["output_size"] = len(output.encode())
            tail = "\n".join(output.rstrip("\n").split("\n")[-TAIL_LINES:])
            item["output_tail"] = tail[-TAIL_CHARS:]
            data = output.encode()

        # The VM may have been taken from it, or the job cancelled, while it ran.
        if vm_record.holder != self.agent_id:
            return {"content": [{"type": "text", "text": "You lost the VM meanwhile; no evidence was added."}], "is_error": True}
        job = self.agents.jobs.get(job["id"])
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} now (the user may have cancelled it): no evidence was added. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Write, then rename: a crash never leaves half a file.
        name = item["file"] or item["output_file"]
        await asyncio.to_thread(EVIDENCE_DIR.mkdir, parents=True, exist_ok=True)
        temporary = EVIDENCE_DIR / f"{name}.tmp"
        await asyncio.to_thread(temporary.write_bytes, data)
        await asyncio.to_thread(temporary.replace, EVIDENCE_DIR / name)
        replaced = self.agents.jobs.add_evidence(job["id"], item)

        text = f"Added {evidence_id} to {job['id']}: {stage} of \"{topic}\" ({kind})."
        if replaced:
            text += f" It replaced the {stage} you had for that topic."
        if kind == "command":
            text += f"\nexit code {item['exit_code']}\n{output}"
            return {"content": [{"type": "text", "text": text}]}
        # The agent sees what the user will see, so it can tell whether it shows what the caption says.
        text += " This is what the user sees. If it doesn't show what the caption says, take it again with the same topic and stage."
        return {"content": [{"type": "text", "text": text}, {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime}]}

    async def run_tests(self, args: dict) -> dict:
        when = args.get("when") or ""
        command = (args.get("command") or "").strip()
        scope = args.get("scope") or ""
        if when not in ["before", "after"]:
            return {"content": [{"type": "text", "text": "when must be before (the unchanged code) or after (your finished change)."}], "is_error": True}
        if scope not in TEST_SCOPES:
            return {"content": [{"type": "text", "text": "scope must be focused (the tests that cover your change) or full (the project's official checks)."}], "is_error": True}
        if not command:
            return {"content": [{"type": "text", "text": "Give the command that runs the tests."}], "is_error": True}
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it); no more test runs for it. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # What to run comes from the project's rules: the agent has to have read them.
        if job["repo"] is not None and job["repo"].lower() not in self.guides_read:
            text = f"First read {job['repo']}'s rules for contributors (contributing_guide): they say which checks to run before a PR, and how."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        before = job["tests"]["before"]
        if when == "after" and (before is None or not before["passed"]):
            text = (
                "First get the tests passing on the unchanged code (when: before). If another job on this repo already got the "
                "official checks passing on this VM, job_progress with the next step carries that run over instead."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if when == "after" and scope != before.get("scope", "full"):
            text = f"Run it with the same scope as on the unchanged code: {before.get('scope', 'full')}."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if when == "after" and command != before["command"]:
            text = (
                f"Run it with the same command as on the unchanged code: `{before['command']}`. To use another command "
                "(e.g. the user agreed to leave out tests that already failed), run that one on the unchanged code first: "
                "`git stash -u`, run_tests with when: before, `git stash pop`."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if vm_record.holder != self.agent_id:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The same tag as the agent's VM tools (ComputerTools), so losing the VM stops the run too.
        tag = f"sandbox-agent-{self.agent_id}"
        hidden = [value for value in sorted(list(vm_record.global_env.values()) + list(vm_record.env.values()), key=len, reverse=True) if len(value) >= HIDE_MIN_LENGTH]
        # Commands run in the user's home, so ~/click and click are the same folder.
        folder = shlex.quote(args["path"].strip().removeprefix("~/"))
        base = shlex.quote(args["base"].strip())

        # The code the suite runs on: its diff from base, read exactly the way draft_pr reads it, so the two can be compared.
        diff_command = f"set -o pipefail; cd {folder} && git add -A -N . && git diff {base} | head -c {DIFF_LIMIT + 1}"
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, diff_command, 120, None, tag)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        diff = result.stdout
        if len(diff.encode()) > DIFF_LIMIT:
            text = (
                f"The diff from {args['base']} is over the {DIFF_LIMIT // 1000} KB limit: look for build output, lockfiles or a "
                "virtualenv in it (git diff --stat), remove them or add them to .git/info/exclude, then try again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if result.returncode != 0:
            text = f"Could not compare {args['path']} with {args['base']}: {result.stderr.strip()}"
            for value in hidden:
                text = text.replace(value, "[hidden]")
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if when == "before" and diff.strip():
            text = (
                f"when: before is for the unchanged code, but {args['path']} differs from {args['base']}. Run it before you change "
                "anything; if you already did, `git stash -u`, run it, then `git stash pop`."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if when == "after" and not diff.strip():
            text = f"{args['path']} doesn't differ from {args['base']} yet: there is no change to test."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The step it is on shows in the user's progress view while the suite runs.
        fields = {"step": "set_up" if when == "before" else "test"}
        if fields["step"] not in job["steps"]:
            fields = {}
        if job["status"] == "queued":
            fields["status"] = "working"
        if fields:
            self.agents.jobs.update(job["id"], **fields)

        # Output and errors together, as in a terminal. tail keeps the end (the summary and the failures) and never
        # stops the suite; pipefail makes the exit code the suite's. The newline ends a comment on the command's last line.
        # The user follows the run live in a terminal window on the VM's desktop (WATCH), which shows TESTS_LOG; Python
        # prints as it goes there instead of in chunks.
        capped = (
            f"set -o pipefail; mkdir -p ~/.cache; : > {TESTS_LOG}; {WATCH.format(log=TESTS_LOG)}export PYTHONUNBUFFERED=1; "
            f"cd {folder} && {{ {command}\n}} 2>&1 | tee {TESTS_LOG} | tail -c {OUTPUT_LIMIT}"
        )
        started = time.monotonic()
        try:
            result = await asyncio.to_thread(vm_record.vm.exec, capped, TEST_TIMEOUT, None, tag)
            exit_code = result.returncode
            output = result.stdout
        except subprocess.TimeoutExpired:
            # Stop what still runs in the VM, or it keeps the VM busy.
            await asyncio.to_thread(vm_record.vm.kill_tagged, tag)
            exit_code = None
            output = f"Stopped after {TEST_TIMEOUT // 60} minutes."
        seconds = round(time.monotonic() - started)
        for value in hidden:
            output = output.replace(value, "[hidden]")
            command = command.replace(value, "[hidden]")
        passed = exit_code == 0

        # The VM may have been taken from it, or the job cancelled, while the tests ran.
        if vm_record.holder != self.agent_id:
            return {"content": [{"type": "text", "text": "You lost the VM while the tests ran; the run doesn't count."}], "is_error": True}
        job = self.agents.jobs.get(job["id"])
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} now (the user may have cancelled it): the run wasn't kept. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The output goes to the user as evidence: this run's before or after of the suite.
        minutes = f"{seconds // 60}m {seconds % 60}s" if seconds >= 60 else f"{seconds}s"
        tests = "the tests that cover the change" if scope == "focused" else "the project's official checks"
        caption = f"{'Passed' if passed else 'Failed'}: {tests} {'on the code as it was' if when == 'before' else 'with the change'}, in {minutes}"
        if exit_code is None:
            caption = f"Stopped: {tests} took over {TEST_TIMEOUT // 60} minutes"
        evidence_id = "ev_" + secrets.token_hex(3)
        tail = "\n".join(output.rstrip("\n").split("\n")[-TAIL_LINES:])
        item = {
            "id": evidence_id,
            "kind": "command",
            "topic": TESTS_TOPICS[scope],
            "stage": when,
            "context": TESTS_CONTEXTS[scope],
            "caption": caption,
            "file": None,
            "command": command,
            "exit_code": exit_code,
            "output_file": f"{evidence_id}.txt",
            "output_tail": tail[-TAIL_CHARS:],
            "output_size": len(output.encode()),
            "created_at": datetime.now(UTC).isoformat(),
        }
        # Write, then rename: a crash never leaves half a file.
        await asyncio.to_thread(EVIDENCE_DIR.mkdir, parents=True, exist_ok=True)
        temporary = EVIDENCE_DIR / f"{evidence_id}.txt.tmp"
        await asyncio.to_thread(temporary.write_bytes, output.encode())
        await asyncio.to_thread(temporary.replace, EVIDENCE_DIR / f"{evidence_id}.txt")
        self.agents.jobs.add_evidence(job["id"], item)

        run = {
            "command": command,
            "scope": scope,
            "base": args["base"].strip(),
            "exit_code": exit_code,
            "passed": passed,
            "diff_hash": hashlib.sha256(diff.encode()).hexdigest() if when == "after" else "",
            "evidence": evidence_id,
            "seconds": seconds,
            "at": datetime.now(UTC).isoformat(),
        }
        tests = {"before": job["tests"]["before"], "after": job["tests"]["after"]}
        tests[when] = run
        # A new run on the unchanged code starts over: an after from before it may have used another command.
        if when == "before":
            tests["after"] = None
        self.agents.jobs.update(job["id"], tests=tests)

        if when == "before" and passed:
            advice = "It passes on the unchanged code: now you may change the code."
        elif when == "before":
            advice = (
                "It must pass on the unchanged code before you change anything. Fix the setup (dependencies, services, settings "
                "the project's docs or CI ask for) and run it again. If the project's own code fails on its main branch (not your "
                "setup), don't change the code: draft_question with the failing tests and wait for the user's decision."
            )
        elif passed:
            advice = "It passes with your change: you may draft the PR (it must be this exact code)."
        else:
            advice = (
                "It must pass with your change before you can draft the PR. Find out why it fails and fix the code (or your test); "
                "never skip, weaken or delete a test to make it pass."
            )
        text = f"{'Passed' if passed else 'Failed'} (exit code {exit_code}, {minutes}). {advice}\n{output}"
        return {"content": [{"type": "text", "text": text}]}

    async def evidence_remove(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        removed = self.agents.jobs.remove_evidence(job["id"], args["ids"])
        missing = [evidence_id for evidence_id in args["ids"] if evidence_id not in removed]
        return {"content": [{"type": "text", "text": json.dumps({"removed": removed, "not_on_job": missing})}]}

    async def vms_list(self, args: dict) -> dict:
        names = {}
        for agent in self.agents.agents.values():
            names[agent.id] = agent.name
        vms = []
        for vm_record in self.agents.vms.list():
            holder = vm_record.holder
            if holder is not None and holder != "user":
                holder = names.get(holder, holder)
            if holder == self.agent_id or holder == names.get(self.agent_id):
                holder = "you"
            notes = []
            for note in vm_record.notes:
                by = names.get(note["by"], note["by"])
                if note["by"] == self.agent_id:
                    by = "you"
                notes.append({"id": note["id"], "text": note["text"], "by": by, "at": note["at"][:16]})
            entry = {
                "name": vm_record.name,
                "status": vm_record.status,
                "cpus": vm_record.cpus,
                "memory_gb": vm_record.memory_gb,
                "disk_gb": vm_record.disk_gb,
                "internet": vm_record.internet,
                "holder": holder,
                "waiting": len(vm_record.queue),
                "your_target": vm_record.name == self.record["target_vm"],
                "forked_from": vm_record.forked_from or None,
                "image": vm_record.image or None,
                "notes": notes or "none yet",
                "image_has": "not inspected yet",
            }
            inventory = await asyncio.to_thread(load_inventory, vm_record.image_fingerprint)
            if inventory is not None:
                entry["image"] = inventory["image"]["name"]
                entry["image_has"] = {
                    "os": inventory["system"]["os"],
                    "languages": [f"{item['name']} {item['version']}" for item in inventory["languages"]],
                    "tools": [f"{item['name']} {item['version']}" for item in inventory["tools"]],
                    "docker_images": [item["name"] for item in inventory["packages"] if item["kind"] == "docker"],
                    "models": inventory["models"],
                    "pip_packages": len([item for item in inventory["packages"] if item["kind"] == "pip"]),
                    "apt_packages": len([item for item in inventory["packages"] if item["kind"] == "apt"]),
                }
            vms.append(entry)
        if not vms:
            return {"content": [{"type": "text", "text": "There are no VMs. Only the user can make one; ask them if a job needs it."}]}
        return {"content": [{"type": "text", "text": json.dumps(vms)}]}

    async def choose_vm(self, args: dict) -> dict:
        try:
            self.agents.set_target_vm(self.agent_id, args["name"], by_agent=True)
        except (ValueError, VMsError) as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"{args['name']} is your target VM now; your open jobs moved to it. Use queue_for_vm when ready."}]}

    async def image_packages(self, args: dict) -> dict:
        try:
            vm_record = self.agents.vms.get(args["vm"])
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        inventory = await asyncio.to_thread(load_inventory, vm_record.image_fingerprint)
        if inventory is None:
            text = f"{vm_record.name}'s image wasn't inspected yet, so its packages aren't listed. Check in the VM itself."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        search = args["search"].strip().lower()
        matches = [item for item in inventory["packages"] if search in item["name"].lower()]
        text = json.dumps({"image": inventory["image"]["name"], "found": len(matches), "packages": matches[:200]})
        return {"content": [{"type": "text", "text": text}]}

    async def queue_for_vm(self, args: dict) -> dict:
        vm_name = self.record["target_vm"]
        if vm_name is None:
            text = "You have no target VM. Pick the VM that suits your jobs with vms_list and choose_vm, then queue again."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            place = self.agents.queue.join(vm_name, self.agent_id)
            vm_record = self.agents.vms.get(vm_name)
        except (ValueError, VMsError) as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}

        if place > 0:
            text = f"You are number {place} in {vm_name}'s queue. End your turn; you'll get a message when it's yours."
            return {"content": [{"type": "text", "text": text}]}
        jobs = [job for job in self.agents.jobs.for_agent(self.agent_id) if job["status"] in OPEN_STATUSES and job["vm"] == vm_name]
        titles = ", ".join(f"{job['id']} ({job['title']})" for job in jobs) or "none"
        text = f"{vm_name} is yours now. Your open jobs for it: {titles}. Do them all, then release_vm."
        if vm_record.status != "running":
            text += f" {vm_name} is {vm_record.status}: start it with vm_start."
        # Its notes come with it, so the agent always knows what earlier agents left in it.
        if vm_record.notes:
            agent_names = {}
            for agent in self.agents.agents.values():
                agent_names[agent.id] = agent.name
            text += "\nIts notes (check what is really there before you rely on them):"
            for note in vm_record.notes:
                text += f"\n- {note['id']} by {agent_names.get(note['by'], note['by'])}, {note['at'][:10]}: {note['text']}"
        else:
            text += "\nIt has no notes yet: nobody wrote down what is set up in it."
        return {"content": [{"type": "text", "text": text}]}

    async def vm_note_add(self, args: dict) -> dict:
        vm_name, place = self.agents.queue.place(self.agent_id)
        if place != 0:
            return {"content": [{"type": "text", "text": "You don't hold a VM. Notes go on the VM you hold."}], "is_error": True}
        if EMOJI.search(args["text"]):
            return {"content": [{"type": "text", "text": NO_EMOJI + ", ".join(EMOJI.findall(args["text"]))}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
            note = await asyncio.to_thread(vm_record.add_note, args["text"], self.agent_id)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Noted on {vm_name} as {note['id']}."}]}

    async def vm_note_remove(self, args: dict) -> dict:
        vm_name, place = self.agents.queue.place(self.agent_id)
        if place != 0:
            return {"content": [{"type": "text", "text": "You don't hold a VM. You can only change the notes of the VM you hold."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
            removed = await asyncio.to_thread(vm_record.remove_notes, args["ids"], self.agent_id)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        user_notes = [note["id"] for note in vm_record.notes if note["by"] == "user"]
        text = json.dumps({
            "removed": removed,
            "the_users_own": [note_id for note_id in args["ids"] if note_id in user_notes],
            "not_on_vm": [note_id for note_id in args["ids"] if note_id not in removed and note_id not in user_notes],
        })
        return {"content": [{"type": "text", "text": text}]}

    async def release_vm(self, args: dict) -> dict:
        vm_name, place = self.agents.queue.place(self.agent_id)
        if place is None:
            return {"content": [{"type": "text", "text": "You don't hold a VM and wait for none."}], "is_error": True}
        if place > 0:
            self.agents.queue.leave_all(self.agent_id)
            return {"content": [{"type": "text", "text": f"You left {vm_name}'s queue."}]}
        try:
            self.agents.queue.release(vm_name, self.agent_id)
        except (ValueError, VMsError) as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Released {vm_name}."}]}

    async def vm_queue_status(self, args: dict) -> dict:
        vm_name, place = self.agents.queue.place(self.agent_id)
        you = "in no queue"
        if place == 0:
            you = f"holding {vm_name}"
        if place is not None and place > 0:
            you = f"number {place} in {vm_name}'s queue"
        status = {"target_vm": self.record["target_vm"], "you": you}
        if self.record["target_vm"] is not None:
            try:
                vm_record = self.agents.vms.get(self.record["target_vm"])
            except VMsError as error:
                return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
            status["vm_status"] = vm_record.status
            status["holder"] = vm_record.holder
            status["queue"] = list(vm_record.queue)
        return {"content": [{"type": "text", "text": json.dumps(status)}]}
