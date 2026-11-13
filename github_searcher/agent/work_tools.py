"""The agent's work tools: the Repos and Issues lists, its jobs, drafts for the Inbox and the VM queue.

The GitHub tools (github_tools.py) only read GitHub; these change what the user sees and decides on:
- Lists: the Repos and Issues lists are the user's view of what the agents found. Each change is
  one undo step for the user. Repos and issues are read from GitHub here, on this machine, so the
  agent only names them. The Tracked list is the repos the user wants to keep an eye on; the
  backend checks their open issues now and then (github_searcher/tracked_issues.py), and
  tracked_issues shows what it found, so the agent can pick good ones for the Issues list.
- Jobs: the smallest unit of work (github_searcher/jobs.py). The user makes them by assigning an
  issue; the agent can make its own and keeps their status and notes up to date, and their
  progress (job_progress: the step it is on and a headline in everyday words) for the user to follow. A new status
  (with its note), each new headline and each test run that counts also go on the job's timeline (jobs.py).
  The app makes follow_up jobs (agents.py, follow_up): someone else wrote on a PR or issue of the user's that
  the agent follows, or the PR's checks failed. my_jobs shows that PR or issue as the job's thread; the agent
  answers with draft_comment (target: the thread), draft_pr with pr (a new version of the user's own PR), or by
  marking the job done when nothing needs an answer. A question it drafts for the job is about the thread.
- Drafts: nothing goes to GitHub from here. A PR, an issue comment or a question becomes a draft
  in the user's Inbox and its job waits on the user. A comment with reply_to answers inside one of a PR's
  conversations on lines of code instead of below it, and with resolve Approve marks that conversation resolved
  after it (some projects only merge once every conversation is; refused for an organization that restricts OAuth Apps,
  once a resolve there failed for it). Only the project's maintainers (read_issue's maintainer: OWNER, MEMBER,
  COLLABORATOR, or someone who merged its PRs) and the PR's reviewers (people, not bots) get answers: reply_to is
  refused in a conversation only bots wrote in (unless it resolves it), and in an organization where an earlier one had
  to go below the PR. A follow_up job's thread gets one comment of ours per round: a comment below it, or a new version with a body
  (its comment), is refused while one of ours is there or waits with nobody else writing since (threads_other_at, from
  read_issue; grimmory#3112 got eleven). A fix_issue job takes one comment only: the claim on its issue, made
  on every one once the agent decided the issue still stands and took the job past understand (repowise#5421's claim
  was posted by its repo's Level of automation two seconds after it was drafted, and then the issue turned out fixed),
  so nobody else takes the issue meanwhile ("Claim owner/name#n" in the Inbox). A job that ends (close_issue, job_update
  cancelled or done) withdraws its claim while that waits, and a claim of an ended job is never sent; wait_for_assignment
  when the repo's rules want a maintainer to assign contributors before a PR. The claim holds nothing up: the job goes on
  to its PR while the claim waits for the user, and nobody waits for the maintainers to assign the user (we assume nobody
  answers). The user approves the claim, then the PR; with wait_for_assignment, the PR is only sent once GitHub shows
  the user assigned. A PR draft's diff is read from the repo
  folder in the VM, so only the agent holding the VM can make one, with the commit it starts from
  (base_sha: Approve sends exactly that diff on that commit, github_account.py) and the branch's commits since
  (commits: replayed when it is sent, all with the user's name). Every commit must be the agent's own:
  draft_pr refuses a branch with anyone else's commits (a cherry-pick), and nothing credits a co-author. They are made
  as the user in the VM too, with their GitHub name and noreply address (the VM-is-yours message gives them): draft_pr
  refuses any other git address, so the user's own email never shows in a draft. A new PR's issue is read again first
  (read_issue, within READ_SECONDS), and draft_pr refuses while someone else's open PR closes it.
  It also refuses a diff with what GitNexus writes by itself when it builds its index (its block in AGENTS.md
  and CLAUDE.md, .claude/skills/gitnexus/, .gitnexus/): running a project's required tool never puts its own
  file changes in the PR.
  No draft has emoji in it (EMOJI, the user's rule; a template's emoji are written as words), except a comment's marker
  the project's own rules require (draft_comment's emoji_rule, checked in the repo file it quotes: horizon wants every
  agent comment to start with the robot emoji and "Agent:", and its claim bot ignored ours without). A PR is
  written from the project's contribution rules and its recently merged PRs: contributing_guide
  gathers the rules wherever they are (CONTRIBUTING in any folder, developer guides in the docs, the
  PR template, AGENTS.md, its AI or agent policy and its organization's, and the guides and policies the README and
  CONTRIBUTING link to, on GitHub or on the project's website) and shows them in parts that each fit one answer, pr_examples shows its main contributors' latest
  merged PRs and some outside ones, and draft_pr refuses until the agent read both for that repo (the guide to its last
  part). On a repo whose AI policy is disclose, a new PR that doesn't say AI helped is refused too. Which repos it read is kept in its record, so a backend restart doesn't ask for them again. The job's before and
  after pictures go in the PR body as ![before](evidence:ev_...): the Inbox shows them in place,
  and sending uploads them to the user's fork (or the user does, sending by hand).
  draft_pr with pr ("owner/name#n") is the next version of the user's own open PR instead: base must be that PR's
  newest commit on GitHub (checked when drafting, and again when sending), the title is the commit message's
  subject and the body the comment posted on the PR with the push (the draft's update_of, inbox.py). The rules
  (contributing_guide), the tests and the checks on the diff and commits apply as for a new PR; the PR template
  and pr_examples don't, and a follow_up job's change needs no before and after pair (its test runs show it works).
  With rebase too, its commits replace the PR's (rebased onto a newer main, or squashed, reworded or signed off): base
  is the commit the rewritten branch starts from, the draft keeps the PR's newest commit as rebase_of, Approve
  force-pushes, and the PR's own commits (the user's noreply address) count as the user's. One new version of a PR
  waits at a time: draft_pr with pr refuses while another job's waits (in review, in the Inbox, or approved and not sent
  yet) and names whose (openmed#5511 got a version from one agent and a rebase of the same commit from another), and the
  app gives the PR's follow-ups to the agent that holds it (Agents.follow_up). A comment or edit of the same job goes out
  only after its version is on GitHub (github_account.py).
  Every PR draft has a checklist (each point that was asked: the issue's requirements, or the reviewers' points for a
  new version, done or not and how it was shown) and also_tested (the cases of the same kind beyond the asked example
  that the agent ran), so the user sees the gaps before approving, and maintainers don't find them one round at a time.
  Every PR draft goes to a reviewer agent first (Agents.give_review) and reaches the Inbox only once the review passes:
  a project's reviewer, or else the repo's own reviewer, which checks it on the author's desktop.
- The repo's Level of automation (set by the user on the Dashboard, inbox.py AUTOMATION_FILE) lets some drafts go
  without the user: the app sends them or answers them (backend/repo_automation_api.py). Two tools act on GitHub
  themselves, as the user, and only where it allows them; elsewhere they refuse: open_issue (Open issues: a new issue
  the project's rules allow, claimed for the user (assigned, else the user's comment saying they are on it), which
  goes in the Issues list at the top of the board's Catalog, before every other card, where another agent takes it
  whatever the repo's Take issues says) and update_branch (Pull requests: GitHub's Update branch on the user's
  open PR). open_issue refuses until the agent read the repo's rules (contributing_guide), and refuses one that is out
  of scope (issue_tags.py CHECKS: belongs, linux, apolitical, not_game; Claude is asked before it goes out), since one claimed
  for the user must be fixed. What they did is kept for
  the Dashboard's Actions (Inbox.add_action), like every sent draft.
- Reading first: read_issue reads an issue or PR in full, right then (never cached): every comment, where it was
  mentioned (issues, PRs, commits), the PRs linked to it or that would close it with their checks and newest comments,
  assignments and labels, and the checks on the default branch. What the user wrote there (ours too, sent as them) is
  marked by_user, with their login, so an agent never takes the user's own claim for someone else's (QwenPaw#8698).
  draft_comment on a thread, a fix_issue job going past
  understand (taking it) and close_issue refuse until it was read so within READ_SECONDS. close_issue ends a fix_issue
  job whose issue turns out invalid before anything was claimed or made (fixed already, a duplicate, someone else's
  open PR, a maintainer said no): the job is cancelled with why, a pending draft of it withdrawn, and the issue is taken
  off the Issues board for good (nothing on GitHub changes; a claim posted already is named, for the agent to take back).
- Taking back, only what the agent itself sent and where the repo's Level of automation allows it (Comments, Pull
  requests): delete_comment (a comment posted from its draft), close_pr (a PR opened from its draft, with a comment
  saying why posted on it first) and drop_commits
  (its newest pushes on a PR of its own: the branch goes back to a commit it had before one of them, only while nobody
  pushed since). A stalled PR of its own is made again as a fresh one: draft_pr with replaces (and every remake job,
  Agents.remake_pr, does it by itself); once the new one is on GitHub the old one is closed (github_account.py).
- report_problem puts what went wrong in how the app made the agent work (a rule or tool that led it the wrong way,
  something a maintainer or the user had to correct) on the Dashboard's Problems list (problems.py), for the user to
  fix all at one time. Nobody answers it.
- Questions: draft_question is only for what matters to the user; small choices the agent makes itself and says so in
  its progress. A question with options names the one the agent recommends, and is timed: when the user doesn't answer
  within the timer of their Settings, the app answers it with that recommendation (Agents.answer_questions). One about
  money, a sensitive subject, what gets sent to GitHub or deleting what can't come back is marked must_wait and waits
  for the user, unless they switched that kind off; so does one without options (inbox.py).
- Projects: on one of the user's own repositories that agents develop all the time (github_searcher/projects.py), the
  rules are the repo's own files, so draft_pr and run_tests don't wait for contributing_guide or pr_examples; a PR's
  title must be a Conventional Commit. A fix_issue job with a thread there makes that PR again on the new main: its
  draft replaces it.
- The Workflow tab (github_searcher/workflow.py): its own worker's draft_pr is a pull request of that repository, not an
  Inbox draft. The same checks hold (the rules are the repo's own files, its title a Conventional Commit); then
  Workflow.add_pr keeps it (and opens it on GitHub when the repository's pull requests are there), and its review agent
  gets it (backend/workflow_api.py).
- Evidence: what the user looks at to decide on a draft. Real screenshots of the project running on
  the VM's desktop (its window, or a terminal running it), screen recordings (GIF) and command runs
  (a test failing, then passing), each "before" or "after" the agent's change, under a topic that
  pairs them. Never pictures the agent drew: an image made with matplotlib is refused. It is kept on
  the job (jobs.py), and each draft gets a copy. A PR draft needs at least one before and one after (except a
  follow_up job's).
- Tests: run_tests runs the project's tests in the VM on the agent's change (after), live in a terminal window on the
  VM's desktop for the user. The project's main branch is trusted to pass: they run on the unchanged code (before) only
  as a last resort, when the after run fails in ways the agent can't cleanly tell from its change.
  Two scopes: focused, the basic checks (the tests that cover the change, when the rules ask for no
  more), and full, the project's official checks (what its rules ask to run before a PR), run however
  long they take (up to TEST_TIMEOUT). It refuses until the agent read the rules (contributing_guide).
  The suite is a run (sandbox/agent/long_runs.py): run_tests waits for it up to long_runs.FOREGROUND_SECONDS, then
  it goes on in the background (background: true starts it that way). The agent can work on, or end its turn and
  sleep: it keeps its desktop (agents.py). When it ends, finish_tests keeps the
  result on the job (agents.py calls it for a run in the background); an after run counts only if the code is still
  the code it started on.
  A passing after is needed for a PR draft, on exactly the code being drafted.
- Papers: a reproduce_paper job (the Workspace tab's Papers page) has the user's PDF in the agent's artifacts. paper_read
  shows it page by page, as pictures (formulas, tables and figures as printed) with their text; it only reads a job's
  paper, which only the user puts there, so a file from a VM is never opened by a PDF reader on this computer.
  draft_report puts the agent's report in the Inbox: in plain words what the paper is, claims and how it came out, the
  paper's numbers next to the agent's (and the authors' code's), the problems it found, each with the command run
  (evidence) that shows it, what it couldn't check and why, the full technical report, and its code from the VM (shown
  like a diff, every file new). Approving it ends the job; nothing goes anywhere.
- Artifacts: the agent's own folder on this computer (github_searcher/artifacts.py), the Artifacts tab of its page.
  It lists it, looks at its pictures and text (artifact_view: a picture comes back as a picture), keeps
  screenshots of its VM there, and copies files between it and the VM it holds; never anywhere else on this
  computer, and it can't delete anything there. It shows one of its pictures in chat as ![...](artifact:path).
- Its name is agent-N; only the user renames it (agents.py, name_by).
- VMs: the agent sees every VM with what its image has (sandbox/images.py lists each image once) and
  its notes, and picks the one that suits its jobs as its target VM (the user can set it too). It can't make VMs.
  It joins its target VM's queue (sandbox/vm_queue.py) and releases the VM when its jobs there are done. While
  only its run goes (a test suite, a build), it keeps its desktop and sleeps (agents.py).
  The notes (sandbox/vms.py) say what agents and the user set up in a VM since it was made, so the next
  agent knows (e.g. that a project is already cloned and built there, and what was added on top). Only the
  agent holding the VM adds or removes them (vm_note_add, vm_note_remove), never the user's own. They come
  with the message that a VM is the agent's now (here and in agents.py, on_grant).

Each tool returns its result as text; a bad call returns is_error, so Claude sees it failed.
A job that is done or cancelled (often by the user, while the agent was busy) can't change
anymore: no status, notes or drafts, so the user's cancel is never undone. The list stores
write a file on every change, so they are called in a thread, off the backend's event loop.
describe() gives the one line the chat shows for each call, of these tools, the GitHub tools and a repository's agent's
tools (repo_tools.py).

    tools = WorkTools(agents, record).list()
"""

import asyncio
import base64
import difflib
import hashlib
import html
import json
import posixpath
import re
import secrets
import shlex
import subprocess
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from claude_agent_sdk import tool

from github_searcher.artifacts import ArtifactsError
from github_searcher.claude_judge import JudgeError, judge
from github_searcher.github_account import SendError
from github_searcher.inbox import ASK_SETTINGS_FILE, AUTOMATION_FILE, MUST_WAIT, TIMER_MINUTES
from github_searcher.issue_tags import CHECKS, TAKEN_PR_DAYS
from github_searcher.jobs import EVIDENCE_DIR
from github_searcher.projects import TITLE, TITLE_CHARS
from github_searcher.repo_signals import MAINTAINERS
from github_searcher.search import get_contents, get_issue_in_full, get_issue_status, get_merged_prs, get_pr_status, get_readme, get_repository, get_thread, get_tree, search_issues
from sandbox.agent import long_runs
from sandbox.agent.computer_use import Computer, ComputerError
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
TEST_TIMEOUT = long_runs.RUN_LIMIT_SECONDS
# How long ago read_issue may have read an issue or PR for a comment on it, for taking it (a fix_issue job going past
# understand), or for closing it: newer comments, PRs and checks may have come since.
READ_SECONDS = 60 * 60
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
# A PR draft's checklist (every point that was asked) and also_tested (the cases of the same kind it ran too).
CHECKLIST_MAX = 40
CHECKLIST_ITEM_CHARS = 200
CHECKLIST_HOW_CHARS = 300
ALSO_TESTED_MAX = 15
ALSO_TESTED_CHARS = 250
# A question's options are buttons in the Inbox: a few, each a few words.
QUESTION_OPTIONS_MAX = 4
QUESTION_OPTION_CHARS = 80
# A job that waits only on a timed question with a timer at most this long keeps its agent's desktop meanwhile (the VM
# rule in agents.py): its answer comes within minutes. One with a longer timer gives the desktop back, like any other draft.
QUESTION_HOLD_SECONDS = 30 * 60
CONTEXT_CHARS = 500
# Agents never use emoji, in drafts or anywhere (the user's rule): pictographs, dingbats and symbols drawn as emoji,
# flags, and the joiners and selectors that make emoji. Plain arrows and math signs are fine. The one exception is a
# marker the project's own rules require in comments (draft_comment's emoji_rule).
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u231A\u231B\u23E9-\u23FA\u203C\u2049\u2139\u3030\u303D\u3297\u3299\uFE0F\u200D\u20E3]")
NO_EMOJI = "No emoji anywhere, also where the project's template has them: write its words without them. Found: "
# A PR saying AI helped write it: an "AI assistance" heading, "AI-assisted", "prepared with the help of an AI", "Generated
# with Claude". Only a repo whose AI policy is disclose asks for that (repo_signals.py); elsewhere it stays out. Not a
# plain mention of AI, which a PR about an AI feature has.
AI_NOTE = re.compile(
    r"^#+\s*AI (assistance|usage|use|disclosure|tools?)\b|\bAI[- ](assisted|assistance|generated|disclosure)\b"
    r"|with the help of (an? )?(AI|LLM)\b"
    r"|\b(prepared|written|made|generated|created|developed|drafted|authored) (with|by|using) (the help of )?(an? )?(AI|LLM|Claude|Copilot|ChatGPT)\b",
    re.IGNORECASE | re.MULTILINE,
)
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
# at most GUIDE_PAGES of them). Each document is cut at GUIDE_CHARS, all of them together at GUIDE_TOTAL_CHARS, and they
# are shown in parts of at most GUIDE_PART_CHARS (reticle's 87,000 characters were more than one tool answer may be:
# Claude Code put it in a file the agent has no tool to open). A call without a part reads the next one it hasn't read:
# an agent that learned the tool before it had parts knows no part argument (opencodex's agent got part 1 every time).
GUIDE_FILES =["agents.md", "ai_policy.md", "agent_policy.md", "development.md", "developing.md", "hacking.md"]
GUIDE_TEXT_ENDINGS = (".md", ".mdx", ".rst", ".txt", ".adoc")
GUIDE_SKIP_FOLDERS = ["node_modules/", "vendor/", "third_party/", "site-packages/", "tests/", "fixtures/", "i18n/", "locale/", "locales/", "translations/"]
GUIDE_LINK_WORDS = [
    "contribut", "developer guide", "developer-guide", "development guide", "hacking", "pull request", "pull-request",
    "ai policy", "ai-policy", "ai_policy", "agent policy", "agent-policy", "agent_policy", "llm usage", "llm-usage", "llm_usage",
]
GUIDE_PAGES = 5
GUIDE_CHARS = 30_000
GUIDE_TOTAL_CHARS = 120_000
GUIDE_PART_CHARS = 40_000
# A picture made with matplotlib says so in its file ("Software: Matplotlib version ..."): the agent drew it.
MATPLOTLIB_MARK = b"matplotlib"
# paper_read shows at most this many pages at once, each as a JPEG this many pixels on its long side (still sharp
# enough for formulas and small print in tables).
PAPER_PAGES = 10
PAPER_PIXELS = 1400
# A report: how many rows of numbers and how many problems at most, and how long each plain-words part may be.
REPORT_RESULTS_MAX = 40
REPORT_PROBLEMS_MAX = 10
REPORT_CELL_CHARS = 200
# A report's code: files in the folder up to this size (KiB) are shown; bigger ones are data or output, not code.
REPORT_FILE_KIB = 1000
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
        # The repos (owner/name, lower case) whose PRs it looked at with pr_examples. Kept in the record too, so a backend
        # restart doesn't make it read them again.
        self.pr_examples_read = set(record.get("pr_examples_read", []))
        # The repos (owner/name, lower case) whose rules for contributors it read with contributing_guide (every part).
        # Kept in the record too, like pr_examples_read.
        self.guides_read = set(record.get("guides_read", []))
        # The last part of each repo's rules for contributors it read (owner/name, lower case): a call without a part
        # reads the next one, and part 1 again after the last.
        self.guide_parts = {}
        # When it last read each issue or PR in full with read_issue (owner/name#n, lower case): time.time().
        self.threads_read = {}
        # What read_issue found someone else on it with (owner/name#n, lower case): their open PR that closes it, as a
        # line for the agent ("" when nobody). A claim and taking the issue refuse while it is set.
        self.threads_taken = {}
        # When someone other than the user last wrote on each issue or PR it read (owner/name#n, lower case): GitHub's
        # time, None when nobody did. Our round there ends with it: one comment of ours until then (draft_comment, draft_pr).
        self.threads_other_at = {}

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
                "merge (likely, or what stands in the way of a merge: out of scope, claimed, maintainers only, waiting, no outside prs, "
                "large feature, big change, can't validate), kind and the reason, made shortly after an issue is added. repo limits it to one "
                "repo (owner/name).",
                {"type": "object", "properties": {"repo": {"type": "string"}}},
            )(self.issues_list),
            tool(
                "issues_add",
                "Add issues to the Issues list, each as owner/name#number. Only issues, not pull requests. note is one short line on "
                "why it is a good pick (shown under each issue). Their repos are added to the Repos list too if missing. "
                "Issues already in the list are skipped, and so are ones the app already rates anything but merge likely.",
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
                "assignees, the app's tags (free / assigned / waiting, merge: likely or what stands in the way, kind, and the reason; None "
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
                "shouldn't be done (a fix_issue job's claim that still waits for the user is withdrawn then). notes replaces the "
                "job's notes: a few lines on where it stands (what you did, what is left, "
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
                "reproduce, fix, test, draft; for set_up_repo: understand, set_up, show, introduce; for follow_up: understand, reproduce, "
                "work, test, draft; for reproduce_paper: read, set_up, rebuild, compare, check, report). Going back is fine, e.g. from test to fix when tests fail. headline: one sentence in "
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
                "path: the repo folder (e.g. ~/click); base: what you branch from (e.g. origin/main). when: after (on your "
                "finished change; it has to pass before draft_pr), or before (on the unchanged code, the folder not differing "
                "from base: only as a last resort, when the after run fails and you can't cleanly tell whether your change is "
                "the cause; the main branch is trusted otherwise). A PR draft is refused unless the last after run passed on "
                "exactly the code being drafted. "
                f"Waits for the tests up to {long_runs.FOREGROUND_SECONDS // 60} minutes; still running then, they go on in the "
                "background and you get the result in a message when they end. background: true starts them that way at once, "
                "for a run you expect to take more than about 5 minutes (most full runs): then do what else you have in this VM "
                "(not in the repo folder), or end your turn: you keep your desktop meanwhile. "
                f"Stopped after {TEST_TIMEOUT // 3600} hours.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "path": {"type": "string"},
                        "base": {"type": "string"},
                        "command": {"type": "string"},
                        "scope": {"type": "string", "enum": TEST_SCOPES},
                        "when": {"type": "string", "enum": ["before", "after"]},
                        "background": {"type": "boolean"},
                    },
                    "required": ["job_id", "path", "base", "command", "scope", "when"],
                },
            )(self.run_tests),
            tool(
                "draft_comment",
                "Draft a follow_up job's reply on an issue or PR (target: its thread, owner/name#number) for the user's Inbox, or a "
                "claim. On a fix_issue job only the claim, on every one (unless the user is already assigned or already said "
                "they are on it), once you decided the issue still stands and took the job past understand (job_progress "
                "set_up; refused before), before the VM: one short comment on the job's issue saying the user is taking it on, "
                "so nobody else does meanwhile; never a question. wait_for_assignment: true when the issue or the repo's rules "
                "say a maintainer must assign contributors before they start or open a PR (the PR then waits until GitHub "
                "shows the user assigned). On a follow_up job a claim goes on the issue the PR closes. Never ask anyone on GitHub for anything "
                "(to assign, review, run checks, decide, answer): assume nobody replies. Nothing is posted: the user decides, "
                "and you get a message with their decision. A reply's job waits on the user meanwhile; a claim's doesn't: go "
                "straight on with the fix, without waiting for the user or the maintainers. "
                "On a follow_up job, answer only the project's maintainers and the PR's reviewers (read_issue's maintainer and "
                "reviewers): nobody else, even when they ask something, and no review bot, unless the merge needs it (a CLA "
                "bot's sign line, a bot command or a resolved conversation the rules require). One comment of ours below a thread per round: refused while one is there or "
                "waits in the Inbox with nobody else writing since, a new version's comment too, so say it all in one. "
                "body is the comment as it would be posted. reply_to: on a PR, the id of a comment in one of its conversations "
                "on lines of code (read_issue's conversations), to answer in that conversation instead of below the PR: only "
                "one a person wrote in, not only bots (or with resolve), and refused in an organization that doesn't let the app answer "
                "there (an earlier answer went below the PR). "
                "resolve: true (with reply_to, on the user's own PR) marks that conversation resolved once the answer is "
                "posted: when the change it asked for is on the PR, and the project lets the author resolve (its rules or "
                "its merged PRs show it, or it wants every conversation resolved before a merge). project, problem and why "
                "are only for the user, in the Inbox's overview. " + PLAIN + " "
                "No emoji, unless the project's own rules require them in comments (a marker every agent comment starts "
                "with, such as the robot emoji and 'Agent:'): then write the marker exactly as the rules do, and give that "
                "rule word for word (emoji_rule) with the repo file it is in (emoji_rule_file, e.g. AGENTS.md): it is checked "
                "there, and only its emoji are let through. A claim bot's command then follows the form of an earlier claim "
                "there the bot accepted (read_issue: the claim, then the bot assigning its author); with none, the marker on "
                "the first line and the command alone on the next.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "target": {"type": "string"},
                        "body": {"type": "string"},
                        "reply_to": {"type": "integer"},
                        "resolve": {"type": "boolean"},
                        "emoji_rule": {"type": "string", "description": "Only when the project's rules require emoji in comments: that rule, word for word as the repo writes it."},
                        "emoji_rule_file": {"type": "string", "description": "The repo file emoji_rule is in, e.g. 'AGENTS.md' or 'docs/CONTRIBUTING.md'."},
                        "project": {"type": "string", "description": "One line: what the project is, e.g. 'matplotlib: a Python library that draws charts'."},
                        "problem": {"type": "string", "description": "What the issue is about: what goes wrong, for whom, when. Specific, 1 to 2 sentences."},
                        "why": {"type": "string", "description": "Why post this comment now, in 1 to 2 sentences. For a claim, that the user takes it on, and the rule that asks for it if any."},
                        "wait_for_assignment": {"type": "boolean", "description": "A claim only: the rules want a maintainer to assign contributors before a PR."},
                    },
                    "required": ["job_id", "target", "body", "project", "problem", "why"],
                },
            )(self.draft_comment),
            tool(
                "draft_edit",
                "Draft a new title and description for one of the user's own PRs or issues (target: owner/name#number; a "
                "follow_up job's thread), for the user's Inbox: when a maintainer asks for it (follow the PR template, a "
                "Conventional Commit title, say what was tested), or when the PR's text no longer matches its code. title is the "
                "whole new title, body the whole new description, as they would be on GitHub (leave one out to keep it as it "
                "is). The app reads the text as it is now and shows the user the change. Nothing is changed yet: the user "
                "decides, approving changes it on GitHub as them, and you get a message with their decision. project, problem "
                "and why are only for the user. " + PLAIN,
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "target": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "project": {"type": "string", "description": "One line: what the project is, e.g. 'matplotlib: a Python library that draws charts'."},
                        "problem": {"type": "string", "description": "What was asked for, or what the text gets wrong now, in 1 to 2 sentences."},
                        "why": {"type": "string", "description": "Why this change to the text, in 1 to 2 sentences."},
                    },
                    "required": ["job_id", "target", "project", "problem", "why"],
                },
            )(self.draft_edit),
            tool(
                "open_issue",
                "Open a new issue on a repo (owner/name), as the user and assigned to the user, only where the user lets agents "
                "do it (the repo's Level of automation: Open issues; elsewhere it refuses) and the project's rules allow it: "
                "read them first (contributing_guide), and don't open one when they ask outside people to start a discussion "
                "first, or don't take issues from them. Only for a real problem you saw yourself while working on the repo, "
                "that is not your job's own issue and isn't reported already (search its issues first): never a question, "
                "and never a request for someone else to do something. Only one we would fix ourselves: never out of scope "
                "(nothing political, politically sensitive or activist, nothing against another country's laws, such as "
                "China's; nothing about a game; nothing only seen on Windows, macOS, a phone or other hardware; nothing that isn't for the repo's "
                "own users). It is checked first and refused when it is. Write it the way the project's issue template and "
                "its rules ask (title and body as on GitHub), with how to make it happen and what you saw, and say the user "
                "will fix it: where the template asks whether the author will submit a PR, yes. It is opened at once, "
                "is claimed for the user (assigned, or their comment saying they are on it where GitHub doesn't let them assign), and "
                "goes in the Issues list at the top of the board's Catalog: an issue we open comes before every other one, "
                "and another agent takes it whatever the repo's Take issues says.",
                {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                    },
                    "required": ["repo", "title", "body"],
                },
            )(self.open_issue),
            tool(
                "update_branch",
                "Bring one of the user's open PRs (pr: owner/name#number) up to date with the branch it goes into, as "
                "GitHub's Update branch button does (it merges that branch into the PR's), only where the user lets agents do "
                "it (the repo's Level of automation: Pull requests; elsewhere it refuses). For a PR that is behind with no "
                "conflict, when the project wants it current or a check needs the newer code. Not when the project's rules "
                "ask for a rebase instead of merge commits, or when it conflicts: then rebase it with draft_pr (pr and rebase).",
                {
                    "type": "object",
                    "properties": {"pr": {"type": "string"}},
                    "required": ["pr"],
                },
            )(self.update_branch),
            tool(
                "read_issue",
                "Read an issue or PR (owner/name#number) in full, as it is right now: its text, every comment, where it was "
                "mentioned (other issues, PRs and commits), the PRs linked to it or that would close it with their state, "
                "review, checks and newest comments, the PRs that only name its number in their text (GitHub didn't link "
                "them; read the ones that may be about it), who was assigned and when, its labels, and the checks on the repo's "
                "default branch (and a PR's own reviews, checks and conversations on lines of code, each comment with the id "
                "draft_comment's reply_to takes). maintainer marks the project's own people (OWNER, MEMBER, COLLABORATOR, or "
                "someone who merges its PRs: private members show as CONTRIBUTOR), and a PR's reviewers lists the people who "
                "reviewed it: only these two get answers. user_login is the user's GitHub login, and by_user marks what they "
                "wrote (comments, reviews, related PRs): that is ours (a claim, a reply or a PR the app sent from a draft, as "
                "them), never someone else taking the issue, whatever role it shows. Read it before you take an issue, claim it, comment on it "
                "or close it: draft_comment, close_issue and a fix_issue job going past understand refuse until you read it "
                "within the hour. Read all of it, and every related PR it shows: someone may be on it, it may be fixed "
                "already or a duplicate, or a maintainer may have said how (or whether) they want it done.",
                {"type": "object", "properties": {"thread": {"type": "string"}}, "required": ["thread"]},
            )(self.read_issue),
            tool(
                "close_issue",
                "Close a fix_issue job's issue for us when reading it in full (read_issue) shows it is invalid, before you claim "
                "or make anything: fixed already (a merged PR, a commit, the newest code), a duplicate, someone else's open "
                "PR for it, a maintainer said it won't be done or wants it done another way, or it can't be what it says. The "
                "job is cancelled with your reason, a pending draft of it is withdrawn, and the issue leaves the Issues board "
                "for good, so no agent takes it again. Nothing on GitHub changes; when your claim was posted already, it says "
                "so, and you take it back (delete_comment). reason: one or two plain sentences, with "
                "the link that shows it (the PR, the comment).",
                {
                    "type": "object",
                    "properties": {"job_id": {"type": "string"}, "reason": {"type": "string"}},
                    "required": ["job_id", "reason"],
                },
            )(self.close_issue),
            tool(
                "delete_comment",
                "Take back a comment of yours: one the app posted on GitHub from your draft (comment: its link, as your "
                "decision message gave it). Only where the user lets agents post comments there (the repo's Level of "
                "automation: Comments). For a comment that is wrong or no longer needed (a claim on an issue you closed, a "
                "reply that missed the point).",
                {"type": "object", "properties": {"comment": {"type": "string"}}, "required": ["comment"]},
            )(self.delete_comment),
            tool(
                "close_pr",
                "Take back a PR of yours (pr: owner/name#number): one the app opened from your draft. Only where the user lets "
                "agents send PRs there (the repo's Level of automation: Pull requests). For one that shouldn't be there "
                "anymore (the issue turned out invalid, it was a mistake, another PR with the same change was merged). "
                "comment says why, in a sentence or two, for the maintainers: it is posted on the PR as the user first, then "
                "the PR is closed, so nobody has to ask why. A stalled one is made again instead: draft_pr with replaces.",
                {"type": "object", "properties": {"pr": {"type": "string"}, "comment": {"type": "string"}}, "required": ["pr", "comment"]},
            )(self.close_pr),
            tool(
                "drop_commits",
                "Take back your newest commits on a PR of yours (pr: owner/name#number): its branch goes back to back_to, a "
                "commit it had before one of your pushes (the commit your earlier push ended on, or the PR's newest commit "
                "before your push or rebase), force-pushed. Only your own pushes, only while nobody pushed after your last one, "
                "and only where the user lets agents send PRs there (the repo's Level of automation: Pull requests).",
                {
                    "type": "object",
                    "properties": {"pr": {"type": "string"}, "back_to": {"type": "string"}},
                    "required": ["pr", "back_to"],
                },
            )(self.drop_commits),
            tool(
                "report_problem",
                "Report a problem in how the app made you work, so the user can fix the app: a rule or a tool that led you "
                "the wrong way (you claimed or started an issue someone else was already on, a tool refused what it should "
                "allow or allowed what it shouldn't, your instructions said two different things), or anything a maintainer "
                "or the user had to correct you on. Not the project's own bugs, and not a question: it goes on the "
                "Dashboard's Problems list, which the user fixes all at one time; nobody answers it, so go on with your work. "
                "text: what happened (with links), why as far as you can tell (the rule or tool), and what should have "
                "happened instead. about: the issue or PR it happened on (owner/name#number), if any.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string"}, "about": {"type": "string"}},
                    "required": ["text"],
                },
            )(self.report_problem),
            tool(
                "draft_question",
                "Ask the user a question through their Inbox, only when the answer matters. Small choices are yours (how to "
                "test, names, which of two reasonable ways): decide, say what you chose and why with job_progress, and go on; "
                "never ask about them. Ask before a long passive run or a long hold on a machine others wait for (a timed "
                "question: options and recommended), or about money, politics or another sensitive subject, how or what gets "
                "sent to GitHub, or deleting what can't come back (must_wait). Not for a secret to fill in (env_var_add, then "
                "say so in your message), nor to ask whether to go on. job_id is the job it is about (leave it out if none); "
                "it waits on the user until the question is answered. question: for someone with no technical context: one "
                "plain sentence on what you need, then what each choice means, with no file, test or function names. options: "
                "the 2 to 4 answers they can pick, each a few words that say what happens; the Inbox shows each as a button, "
                "and you hear which one was picked. Leave them out only when the user must answer in their own words: then it "
                "always waits. recommended: the option you would pick, written exactly as in options (needed with options). "
                "With options and no must_wait the question is timed: when the user doesn't answer within the timer they set "
                f"({TIMER_MINUTES} minutes unless they changed it), the app answers it with recommended, and you go on with "
                f"that; with a timer of {QUESTION_HOLD_SECONDS // 60} minutes or less you keep your desktop meanwhile (the "
                "result says so). must_wait: money (it costs the user money), sensitive (politics or another sensitive subject), github "
                "(how or what gets sent to GitHub, beyond your usual drafts), delete (deleting something that can't come "
                "back): the user answers it themselves however long it takes, unless they switched that kind off.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "question": {"type": "string"},
                        "options": {"type": "array", "items": {"type": "string"}},
                        "recommended": {"type": "string", "description": "The option you would pick, exactly as written in options."},
                        "must_wait": {"type": "string", "enum": MUST_WAIT},
                    },
                    "required": ["question"],
                },
            )(self.draft_question),
            tool(
                "paper_read",
                "Read the paper of one of your reproduce_paper jobs: its pages as pictures (formulas, tables and figures as "
                f"printed), then their text. pages: one page ('3') or a range ('1-5'), at most {PAPER_PAGES} at a time. The "
                "result says how many pages it has. Read every page, the appendix too, before you build anything.",
                {
                    "type": "object",
                    "properties": {"job_id": {"type": "string"}, "pages": {"type": "string"}},
                    "required": ["job_id", "pages"],
                },
            )(self.paper_read),
            tool(
                "draft_report",
                "Put your report on a reproduce_paper job in the user's Inbox (only while you hold the VM): the last step. The "
                "job waits on the user; approving it ends the job. Nothing is sent anywhere. paper, claims and verdict are for "
                "the user, who doesn't know the field: " + PLAIN + " results: the paper's numbers next to yours, one row each "
                "(what: e.g. 'age coefficient, MIMIC-IV'; paper and ours: the numbers as printed; authors: what the authors' own "
                "code gives, when you ran it; note: a few words, e.g. 'same to 3 decimals'). problems: what you found wrong, "
                "each proven by a command run on the job (evidence_add kind command, stage other, topic the problem's title) "
                "that shows it: give that evidence id. No proof, no problem. unchecked: what you couldn't check and why (e.g. "
                "'the hospital data is private'). body: the full report, technical, in markdown. code: the folder in the VM "
                "with your code (e.g. ~/valoris): every file in it under 1 MB is shown to the user, so keep only your scripts "
                "and small inputs there, no data downloads or results. No emoji.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "title": {"type": "string", "description": "One line: the paper and how it came out, e.g. 'VALORIS: the numbers reproduce, two claims don't hold'."},
                        "paper": {"type": "string", "description": "One line: what the paper is, e.g. 'VALORIS: a way for hospitals to fit one model together without sharing patient records'."},
                        "claims": {"type": "string", "description": "What the paper says it achieves, in 1 to 3 sentences."},
                        "verdict": {"type": "string", "description": "How it came out, in 1 to 3 sentences: what reproduced, what didn't, what is wrong."},
                        "results": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "what": {"type": "string"},
                                    "paper": {"type": "string"},
                                    "ours": {"type": "string"},
                                    "authors": {"type": "string"},
                                    "note": {"type": "string"},
                                },
                                "required": ["what", "paper", "ours"],
                            },
                        },
                        "problems": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string", "description": "A few words, e.g. 'Privacy holds only on paper'."},
                                    "what": {"type": "string", "description": "What is wrong, in plain words, 1 to 3 sentences."},
                                    "why": {"type": "string", "description": "Why it matters: who or what it affects, 1 to 2 sentences."},
                                    "evidence": {"type": "string", "description": "The id of the command run on the job that shows it (ev_...)."},
                                },
                                "required": ["title", "what", "why", "evidence"],
                            },
                        },
                        "unchecked": {"type": "array", "items": {"type": "string"}},
                        "body": {"type": "string"},
                        "code": {"type": "string"},
                    },
                    "required": ["job_id", "title", "paper", "claims", "verdict", "results", "problems", "body", "code"],
                },
            )(self.draft_report),
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
                "owner/name. A long guide comes in parts: the answer says how many, and part (1, 2, ...) reads each one; "
                "without part, each call gives the next part. "
                "run_tests and draft_pr refuse until you read it, to the last part, for the job's repo; that stays read "
                "after a backend restart.",
                {"type": "object", "properties": {"name": {"type": "string"}, "part": {"type": "integer"}}, "required": ["name"]},
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
                "nothing: a reviewer agent checks it first, then the user reviews it, approving sends it from their account, and you "
                "get a message with each decision. project, problem, cause, fix and "
                "risks are only for the user, who reads them first to understand and judge the PR. " + PLAIN + " "
                "checklist and also_tested are for the user and the reviewer: every point that was asked, each done or not and "
                "how you showed it, and the cases of the same kind you ran beyond the asked example. "
                "pr: only for the next version of the user's own open PR (owner/name#number; a follow_up job: a maintainer asked "
                "for changes, its checks failed, or a bot found a real bug in the change). Then base is the PR's newest commit (the sha the follow-up message gave), "
                "and your work is on top of it; approving pushes your commits onto the PR's branch instead of opening a new PR. "
                "title is then the commit message's subject (one more commit has it when you didn't commit everything), and "
                "body the comment posted on the PR with the push: what changed, in a line or two, and your answers to what the "
                "maintainers and reviewers wrote this round (it is the round's one comment: refused when one of ours is there already, with "
                "nobody else writing since). Leave body empty when no maintainer or reviewer asked for this version (a bot's real bug, a "
                "failing check): the push then goes without a comment. The project's rules "
                "(contributing_guide) and the tests apply as for any PR; the PR template and pr_examples don't. problem is then "
                "what the reviewer asked for or what failed. One new version of a PR waits at a time: refused while another "
                "job's version of it waits (in review, in the Inbox, or approved and not sent), which it names. A comment or a "
                "new title and description of the same job goes out only after the version is on GitHub. "
                "rebase: true (with pr) when your version replaces the PR's commits instead of adding to them: you rebased its "
                "branch onto the project's newer main (a maintainer asked, or it conflicts with main), or squashed, reworded or "
                "signed off its commits as a reviewer asked. Then base is the commit your branch now starts from (e.g. origin/main "
                "after git fetch origin), the diff is the PR's whole change on top of it, and approving force-pushes your commits "
                "onto the PR's branch (refused if the branch moved since). The PR's own commits may stay as they are (they are "
                "the user's); title is the subject of your last commit. "
                "A new PR for a fix_issue job waits until you read its issue again with read_issue (within the hour), and is "
                "refused while someone else's open PR closes it. Commit with the user's GitHub name and noreply address (the "
                "message that a VM is yours gives them); other git addresses are refused.",
                {
                    "type": "object",
                    "properties": {
                        "job_id": {"type": "string"},
                        "path": {"type": "string"},
                        "base": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "pr": {"type": "string", "description": "owner/name#number of the user's open PR this is the next version of; leave it out for a new PR."},
                        "rebase": {"type": "boolean", "description": "With pr: your commits replace the PR's (a rebase, squash, reword or sign-off) and approving force-pushes them."},
                        "replaces": {
                            "type": "string",
                            "description": (
                                "owner/name#number of a PR of yours this new PR replaces: a fresh one with all its changes and a clean "
                                "history in place of one that stalled (long quiet, or buried in rounds of comments). The old one is "
                                "closed once this one is on GitHub. A remake job's draft replaces its PR by itself."
                            ),
                        },
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
                        "checklist": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {"item": {"type": "string"}, "done": {"type": "boolean"}, "how": {"type": "string"}},
                                "required": ["item", "done", "how"],
                            },
                            "description": "Every point that was asked, one by one. A new PR: each requirement of the issue (every "
                            "acceptance criterion and every part of its spec or request; for a plain bug, the behaviour it asks for). "
                            "A new version: each point the maintainers and reviewers raised on the PR, the bots' real bugs in the change you fixed, "
                            "and any requirement of the issue still open. item: the point in a few plain words. done: whether this draft does it. how: for done, what you ran "
                            "that shows it (the test, on which drivers, platforms or backends); for not done, why not, and that the PR "
                            "text says so. Never done for something you didn't run.",
                        },
                        "also_tested": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "1 to 15 cases of the same kind beyond the issue's or the reviewer's own example that you ran, "
                            "each with what came out: other values (limits, empty, huge, special characters, every type a value can "
                            "have), inputs, platforms, drivers or backends the change supports, cancel or failure halfway, the same "
                            "mistake elsewhere in the change. A maintainer will try these next: find them first.",
                        },
                    },
                    "required": ["job_id", "path", "base", "title", "body", "project", "problem", "cause", "fix", "risks", "checklist", "also_tested"],
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
                "See every VM: whether it runs, CPU, memory, disk and disk in use, whether it is full right now and why, its "
                "desktops (who holds each), how many wait, "
                "what it started with (the OS, languages, tools, ready-made Docker images and models of its image), and its "
                "notes: what agents and the user set up in it since (a project cloned and built, a service configured, what "
                "was added on top), oldest first, each with who wrote it, when, and on which desktop. Use it to pick the VM "
                "that suits your jobs (choose_vm). You can't make VMs; only the user can.",
                {},
            )(self.vms_list),
            tool(
                "vm_note_add",
                "Add a note to the VM you hold, for the next agent that picks it or works in it: what is set up in it now and "
                "how it differs from a plain set-up. It is marked with your desktop, since ~ is that desktop's own home. "
                "One thing per note, a repo named as owner/name (the app tells from that which VMs have a repo set up), e.g. "
                "'openclaw/openclaw in ~/openclaw: pnpm install and build "
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
                "Join your target VM's queue to work in it, on one of its desktops: each has its own screen, mouse, keyboard and "
                "home folder, and agents on different desktops work at the same time. Either a desktop is yours at once, or you "
                "get your place in the VM's line: then end your turn, and you get a message when it is yours (even while the VM is "
                "off, you keep your place). desktop: the one to work on, e.g. where your project is already set up (the notes "
                "say which desktop); leave it out to get any desktop, the first one free.",
                {"type": "object", "properties": {"desktop": {"type": "integer"}}, "required": []},
            )(self.queue_for_vm),
            tool(
                "desktop_add",
                "Add a desktop to your target VM, running or not, when all of its desktops are taken and you would otherwise "
                "wait, up to the VM's max desktops (vms_list shows it). It gets the lowest number free (desktops keep their numbers, so with 2 and 3 taken "
                "the new one is desktop 1) and its own user, home folder, screen and browser. Setting it up takes under a "
                "minute (a few more the first time). The agents already waiting in the VM's queue get it first; then "
                "queue_for_vm. Each desktop takes memory from the others, so only when you would really wait, never a "
                "second one for yourself.",
                {},
            )(self.desktop_add),
            tool(
                "release_vm",
                "Give your VM's desktop back so the next agent in line can use it. Do it as soon as your jobs for it are done or waiting on the user. "
                "While you wait in a VM's queue, it takes you out of the queue instead (e.g. when your jobs there were cancelled). "
                "Not while you wait on a run you need the result of, nor on a timed question with a short timer (draft_question "
                f"says so, {QUESTION_HOLD_SECONDS // 60} minutes at most): then just end your turn and keep the desktop; the "
                "result or the answer wakes you.",
                {},
            )(self.release_vm),
            tool(
                "vm_queue_status",
                "See your target VM, whether it is running, who holds and waits for each of its desktops, and your own place.",
                {},
            )(self.vm_queue_status),
        ]

    def describe(self, name: str, args: dict) -> str:
        """The line the chat shows for a call, e.g. "Adding to Issues: pallets/click#812".

        Also for the GitHub tools, a repository's agent's tools (repo_tools.py) and TodoWrite; the VM tools have their own
        (ComputerTools.describe).
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
            if args.get("background"):
                return f"Running {tests} {code} in the background: `{args.get('command')}`"
            return f"Running {tests} {code}: `{args.get('command')}`"
        if name == "draft_comment":
            return f"Drafting a comment on {args.get('target')}"
        if name == "draft_question":
            return "Asking: " + (args.get("question") or "").split("\n")[0][:120]
        if name == "draft_edit":
            return f"Drafting a new title and description for {args.get('target')}"
        if name == "open_issue":
            return f"Opening an issue on {args.get('repo')}: {args.get('title')}"
        if name == "update_branch":
            return f"Updating the branch of {args.get('pr')}"
        if name == "read_issue":
            return f"Reading {args.get('thread')} in full"
        if name == "close_issue":
            return f"Closing the issue of {args.get('job_id')}: {args.get('reason')}"
        if name == "delete_comment":
            return f"Taking back the comment {args.get('comment')}"
        if name == "close_pr":
            return f"Taking back {args.get('pr')}"
        if name == "drop_commits":
            return f"Taking back the commits of {args.get('pr')} after {(args.get('back_to') or '')[:10]}"
        if name == "report_problem":
            return "Reporting a problem: " + (args.get("text") or "").split("\n")[0][:120]
        if name == "paper_read":
            return f"Reading the paper, pages {args.get('pages')}"
        if name == "draft_report":
            return f"Drafting the report: {args.get('title')}"
        if name == "draft_pr" and args.get("pr") and args.get("rebase") is True:
            return f"Drafting a rebase of {args['pr']}: {args.get('title')}"
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
        if name == "pr_examples":
            return f"Reading how {args.get('name')}'s people write their PRs"
        if name == "contributing_guide" and isinstance(args.get("part"), int) and args["part"] > 1:
            return f"Reading {args.get('name')}'s rules for contributors, part {args.get('part')}"
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
        if name == "queue_for_vm" and args.get("desktop"):
            return f"Queuing for desktop {args.get('desktop')} of {self.record['target_vm']}"
        if name == "queue_for_vm":
            return f"Queuing for {self.record['target_vm']}"
        if name == "desktop_add":
            return f"Adding a desktop to {self.record['target_vm']}"
        if name == "release_vm":
            return "Releasing its VM (or leaving the queue)"
        if name == "vm_queue_status":
            return "Looked at the VM queue"
        if name == "vm_note_add":
            return f"Note on its VM: {args.get('text')}"
        if name == "vm_note_remove":
            return "Removing notes from its VM: " + ", ".join(args.get("ids") or [])
        # A repository's agent's tools (repo_tools.py): always on its own repo.
        if name == "repo_files" and args.get("path"):
            return f"Listed the files in {args['path']}"
        if name == "repo_files":
            return "Listed the files"
        if name == "repo_read":
            return "Read " + ", ".join(args.get("paths") or [])
        if name == "repo_search_code":
            return f"Searched the code for `{args.get('q')}`"
        if name == "repo_issues" and args.get("search"):
            return f"Searched the issues for `{args['search']}`"
        if name == "repo_issues":
            return f"Looked at the {args.get('state') or 'open'} issues"
        if name == "repo_pulls":
            return f"Looked at the {args.get('state') or 'open'} pull requests"
        if name == "repo_thread":
            return f"Read #{args.get('number')}"
        if name == "draft_issue":
            return f"Drafting an issue: {args.get('title')}"
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
        dismissed = [issue_id.lower() for issue_id in await asyncio.to_thread(self.agents.issues.dismissed)]
        tags = await asyncio.to_thread(self.agents.issue_tags.all)
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
            if issue_id.lower() in dismissed:
                report[issue_id] = "skipped: the user removed it from the board; never add it again"
                continue
            # Agents only pick issues a pull request from us would likely get merged for; the user may add any.
            tag = tags.get(issue_id)
            if tag is not None and tag.get("merge") is not None and tag["merge"] != "likely":
                report[issue_id] = f"skipped: the app rates its merge {tag['merge']} ({tag['reason']})"
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
                    "paper": job["paper"],
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
        job = self.agents.jobs.create(kind, title, self.agent_id, self.agent_id, issue=issue, vm=vm_name, instructions=args.get("instructions") or "", agent_name=self.record["name"])
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
        if job["status"] == "paused":
            text = f"The user paused {job['id']}. Leave it as it is until they resume it; you will be told."
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

        # A new status goes on the job's timeline, with the note that came with it (often why it stopped).
        if "status" in fields and fields["status"] != job["status"]:
            said = "Working on it"
            if fields["status"] == "done":
                said = "Done"
            if fields["status"] == "cancelled":
                said = f"Stopped by {self.record['name']}"
            if (fields.get("notes") or "").strip():
                said += ": " + fields["notes"].strip()
            self.agents.jobs.add_timeline(job["id"], "status", said)
        job = self.agents.jobs.update(job["id"], **fields)
        text = f"{job['id']} is {job['status']}."
        # A fix_issue job that ends takes back its claim while that still waits for the user, as close_issue does (and
        # github_account.py never posts the claim of a job that ended): nobody works on the issue for the user anymore.
        if job["kind"] == "fix_issue" and job["status"] in CLOSED_STATUSES:
            for draft_id in job["drafts"]:
                try:
                    draft = self.agents.inbox.get(draft_id)
                except KeyError:
                    continue
                if draft["kind"] != "comment" or draft["status"] != "pending":
                    continue
                try:
                    self.agents.inbox.decide(draft_id, "rejected", f"Withdrawn by {self.record['name']}: {job['id']} is {job['status']}")
                    text += f" Its claim {draft_id} is withdrawn."
                except ValueError:
                    # Decided in the meantime.
                    pass
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
        if job["status"] == "paused":
            text = f"The user paused {job['id']}. Leave it as it is until they resume it; you will be told."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        headline = args["headline"].strip()
        if not headline:
            return {"content": [{"type": "text", "text": "The headline is empty."}], "is_error": True}
        step = (args.get("step") or "").strip().lower().replace(" ", "_") or None
        if step is not None and step not in job["steps"]:
            return {"content": [{"type": "text", "text": f"step must be one of: {', '.join(job['steps'])}."}], "is_error": True}
        # Taking the issue: past understand only once everything about it was read, recently.
        if job["kind"] == "fix_issue" and job["issue"] is not None and step not in [None, "understand"] and job["step"] in [None, "understand"]:
            read_at = self.threads_read.get(job["issue"].lower())
            if read_at is None or time.time() - read_at > READ_SECONDS:
                text = (
                    f"First read {job['issue']} in full with read_issue: every comment, mention, related PR and check. If it "
                    "turns out invalid (fixed already, a duplicate, someone else's PR, a maintainer said no), close_issue instead."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            # Someone else's open PR closes it: no second fix.
            if self.threads_taken.get(job["issue"].lower()):
                text = f"{self.threads_taken[job['issue'].lower()]}: someone else is on it. Don't start a second fix: close_issue with that link."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            # A repo that doesn't take AI-made contributions: we don't work there at all.
            no_ai = [name.lower() for name, each in self.agents.repo_signals.all().items() if (each.get("ai_policy") or {}).get("tag") == "no_ai"]
            if job["issue"].split("#")[0].lower() in no_ai:
                text = f"{job['issue'].split('#')[0]} doesn't take AI-made contributions (its AI policy), and we only work as an AI agent. Abandon {job['id']}: job_update cancelled, with that note."
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
        # On the job's timeline as the agent wrote it, unless nothing changed since the last one.
        moved = headline != job["headline"] or (step is not None and step != job["step"])
        job = self.agents.jobs.update(job["id"], **fields)
        if moved:
            self.agents.jobs.add_timeline(job["id"], "step", headline, step=job["step"])
        text = f"{job['id']}: {(job['step'] or 'no step yet').replace('_', ' ')}, \"{job['headline']}\"."
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
        # A project's own rule for comments may ask for emoji (horizon-rust/horizon's AGENTS.md: every agent comment starts
        # with the robot emoji and "Agent:"; our claim went out as "Agent: /claim" and its claim bot never assigned the user). That rule wins
        # over the no-emoji rule, for the emoji in it only: the agent quotes it word for word (emoji_rule) with the repo
        # file it is in (emoji_rule_file), and it is checked there.
        found = EMOJI.findall(" ".join([args["body"]] + list(overview.values())))
        rule = " ".join((args.get("emoji_rule") or "").split())
        rule_file = (args.get("emoji_rule_file") or "").strip().removeprefix("./").strip("/")
        if found and rule:
            try:
                data = await asyncio.to_thread(get_contents, name.split("/")[0], name.split("/")[1], rule_file)
            except (httpx.HTTPError, ValueError) as error:
                return {"content": [{"type": "text", "text": f"Could not read {rule_file or 'emoji_rule_file'} in {name}: {error}"}], "is_error": True}
            rules = ""
            if rule_file and isinstance(data, dict) and data.get("encoding") == "base64":
                rules = " ".join(base64.b64decode(data["content"]).decode("utf-8", errors="replace").split())
            if rule not in rules:
                text = (
                    f"{rule_file or 'emoji_rule_file'} in {name} doesn't say \"{rule}\". Quote the project's rule word for word, "
                    "with the file it is in (emoji_rule_file), or leave the emoji out."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            found = [each for each in found if each not in EMOJI.findall(rule)]
        if found:
            text = (
                NO_EMOJI + " ".join(sorted(set(found))) + ". Only a marker the project's own rules require in comments may "
                "have them: then give that rule word for word (emoji_rule) and the file it is in (emoji_rule_file)."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it): no drafts for it anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # We don't comment and wait for other people: a fix goes straight to a PR. The one comment on a fix_issue job is
        # the claim a repo's rules ask for before contributors start (Agents.decide parks the job until the user is assigned).
        title = f"Comment on {target}"
        if job["kind"] == "fix_issue":
            if target != job["issue"]:
                text = f"On a fix_issue job the only comment is the claim, on its issue {job['issue']}."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            for draft_id in job["drafts"]:
                try:
                    draft = self.agents.inbox.get(draft_id)
                except KeyError:
                    continue
                if draft["kind"] == "comment" and draft["status"] != "rejected":
                    text = f"{job['id']} already has its claim, {draft_id} ({draft['status']}). One claim per job: don't comment again."
                    return {"content": [{"type": "text", "text": text}], "is_error": True}
            # A claim takes the issue, so it comes once the agent decided the issue still stands and took it past understand
            # (job_progress checks it was read and nobody else is on it). repowise#5421's claim was drafted right after the
            # first read, posted by its repo's Level of automation two seconds later, and then its agent found the fix merged
            # days before and closed the job.
            if job["step"] in [None, "understand"]:
                text = (
                    f"First decide whether {job['issue']} still stands (Fixing an issue in the VM, step 1): not fixed already by a "
                    "merged PR or commit, not a duplicate, nobody else on it, no maintainer said no. If it doesn't, close_issue "
                    f"and claim nothing. If it does, take it: job_progress {job['id']} with step set_up, then claim it."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            title = f"Claim {target}"

        # Everything about the thread is read first, recently: someone may be on it, or it may be settled already.
        read_at = self.threads_read.get(target.lower())
        if read_at is None or time.time() - read_at > READ_SECONDS:
            text = f"First read {target} in full with read_issue (every comment, mention, related PR and check), then write the comment."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # No claim on an issue someone else's open PR closes: its maintainers don't want a second fix.
        if job["kind"] == "fix_issue" and self.threads_taken.get(target.lower()):
            text = f"{self.threads_taken[target.lower()]}: someone else is on it. Don't claim it: close_issue with that link."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # Nor on a repo that doesn't take AI-made contributions.
        no_ai = [name.lower() for name, each in self.agents.repo_signals.all().items() if (each.get("ai_policy") or {}).get("tag") == "no_ai"]
        if job["kind"] == "fix_issue" and name.lower() in no_ai:
            text = f"{name} doesn't take AI-made contributions (its AI policy), and we only work as an AI agent. Don't claim anything there: abandon {job['id']} with job_update cancelled."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # An answer inside a conversation on lines of code of a PR goes below its first comment: GitHub takes no replies
        # to replies. With resolve, Approve marks that conversation resolved once the answer is in it.
        reply_to = args.get("reply_to")
        resolve = None
        if args.get("resolve") is True and reply_to is None:
            text = "resolve goes with reply_to: the id of a comment in the conversation to answer and resolve."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if reply_to is not None and job["kind"] == "fix_issue":
            text = "A claim goes below the issue: leave reply_to and resolve out."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if reply_to is not None:
            try:
                thread = await asyncio.to_thread(get_issue_in_full, name.split("/")[0], name.split("/")[1], int(target.split("#")[1]))
            except (httpx.HTTPError, ValueError) as error:
                return {"content": [{"type": "text", "text": f"Could not read {target}: {error}"}], "is_error": True}
            conversations = []
            if thread is not None and thread["__typename"] == "PullRequest":
                conversations = thread["reviewThreads"]["nodes"]
            first = None
            found = None
            for conversation in conversations:
                ids = [comment["databaseId"] for comment in conversation["comments"]["nodes"]]
                if reply_to not in ids:
                    continue
                first = ids[0]
                found = conversation
                if args.get("resolve") is True and not conversation["isResolved"]:
                    resolve = conversation["id"]
            if first is None:
                text = f"{reply_to} isn't a comment in a conversation on lines of code of {target}: use a comment's id from read_issue's conversations."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            # We only answer the project's maintainers and the PR's reviewers: a person writing in a conversation on lines
            # of code is reviewing it. One only review bots wrote in gets no answer (grimmory#3112: six answers to
            # CodeRabbit), unless the merge needs it: the project wants every conversation resolved first.
            login = self.agents.your_repositories.github_account.status().get("login") or ""
            people = []
            reviewers = []
            for comment in found["comments"]["nodes"]:
                person = comment["author"]["login"] if comment["author"] else "ghost"
                if person.lower() == login.lower():
                    continue
                people.append(person)
                if comment["author"] is not None and comment["author"]["__typename"] == "User":
                    reviewers.append(person)
            if not reviewers and resolve is None:
                text = (
                    f"Only a bot wrote in that conversation ({', '.join(people) or 'nobody but the user'}). We only answer the "
                    "project's maintainers and the PR's reviewers: don't reply to it. Only when the project wants every "
                    "conversation resolved before a merge, answer it with resolve: true. A real bug it found in your change goes "
                    "into the next version, without a reply."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            # Only the PR's author (and its maintainers) may resolve its conversations.
            author = thread["author"]["login"] if thread["author"] else "ghost"
            if resolve is not None and login and author.lower() != login.lower():
                text = f"{target} is {author}'s PR, not the user's: they can't resolve its conversations. Leave resolve out."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            # An organization that restricts OAuth Apps doesn't let the app resolve anything on its repos (openchoreo): a
            # resolve that failed for that once says so for all of them. Nor answer inside a conversation: the answer went
            # below the PR instead, each as a comment of its own (github_account.post_comment), so none goes there again.
            restricted = []
            below = []
            for each in self.agents.inbox.list():
                if each["kind"] != "comment" or each["sent"] is None:
                    continue
                if "OAuth App access restrictions" in (each["sent"].get("resolve_error") or ""):
                    restricted.append((each.get("repo") or "").split("/")[0].lower())
                if each.get("reply_to") is not None and "#issuecomment-" in (each["sent"].get("url") or ""):
                    below.append((each.get("repo") or "").split("/")[0].lower())
            if name.split("/")[0].lower() in below:
                text = (
                    f"The {name.split('/')[0]} organization doesn't let the app answer inside a conversation on its repos: an "
                    "earlier answer went below the PR as a comment of its own. Leave reply_to out and say it in the round's one "
                    "comment below the PR (the new version's comment, when you push one)."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            if resolve is not None and name.split("/")[0].lower() in restricted:
                text = (
                    f"The {name.split('/')[0]} organization restricts what apps may do on its repos, so the app can't resolve "
                    "conversations there (it failed before). Leave resolve out: the answer in the conversation is enough."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            reply_to = first
            title = f"Reply in a conversation on {target}"
            if resolve is not None:
                title = f"Reply and resolve a conversation on {target}"
        # One comment of ours below a thread per round: once one is there or waits in the Inbox, with nothing anyone else
        # wrote after it, no other (grimmory#3112: an answer, then the push's comment saying the same). A new version's
        # comment counts.
        since = self.threads_other_at.get(target.lower())
        ours = []
        if job["kind"] == "follow_up" and reply_to is None:
            ours = self.agents.inbox.list()
        for each in ours:
            if each["status"] not in ["pending", "approved"]:
                continue
            if since is not None and datetime.fromisoformat(each["created_at"]) <= datetime.fromisoformat(since):
                continue
            said = each["kind"] == "comment" and each.get("reply_to") is None and (each["target"] or "").lower() == target.lower()
            pushed = each["kind"] == "pr" and (each["update_of"] or "").lower() == target.lower() and each["body"].strip() != ""
            if said or pushed:
                text = (
                    f"{each['id']} ({each['status']}) already speaks for this round on {target}: nobody else wrote there since. "
                    "One comment per round, with all of it. When that one is a new version still waiting, draft the version "
                    "again with everything in its comment; otherwise nothing more until someone writes there again."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        draft = self.agents.inbox.create(
            "comment", self.agent_id, title, args["body"], job=job["id"], repo=name, target=target, evidence=job["evidence"], overview=overview,
            wait_for_assignment=(args.get("wait_for_assignment") is True) if job["kind"] == "fix_issue" else None,
            reply_to=reply_to, resolve=resolve,
        )
        # A claim holds nothing up: the user approves it, and nobody waits for the maintainers' answer. The job goes on to its
        # PR, which can only be sent once the claim is decided, and with wait_for_assignment once the user is assigned
        # (github_account.py).
        if job["kind"] == "fix_issue":
            self.agents.jobs.update(job["id"], drafts=job["drafts"] + [draft["id"]])
            text = (
                f"{draft['id']} is in the user's Inbox. Nothing was posted yet. Don't wait for it: go straight on with "
                f"{job['id']}, the fix and its PR. The user approves the claim, then the PR. Nobody waits for the maintainers "
                "to assign the user either (with wait_for_assignment, the PR is only sent once they did)."
            )
            return {"content": [{"type": "text", "text": text}]}
        self.agents.jobs.update(job["id"], status="waiting_on_user", drafts=job["drafts"] + [draft["id"]])
        text = (
            f"{draft['id']} is in the user's Inbox. Nothing was posted: the user decides, and you'll get a message with their "
            f"decision. {job['id']} waits on the user now; move on to your next job."
        )
        return {"content": [{"type": "text", "text": text}]}

    async def draft_edit(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it): no drafts for it anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        target = (args.get("target") or "").strip()
        repo = target.split("#")[0]
        if "#" not in target or repo.count("/") != 1 or not target.split("#")[-1].isdigit():
            return {"content": [{"type": "text", "text": "target must be owner/name#number: the user's own PR or issue."}], "is_error": True}
        overview = {
            "project": (args.get("project") or "").strip(),
            "problem": (args.get("problem") or "").strip(),
            "why": (args.get("why") or "").strip(),
        }
        for part, text in overview.items():
            limit = OVERVIEW_PROJECT_CHARS if part == "project" else OVERVIEW_PART_CHARS
            if not text:
                return {"content": [{"type": "text", "text": f"Give {part}: the user reads it to understand the change."}], "is_error": True}
            if len(text) > limit:
                text = f"{part} is {len(text)} characters; keep it under {limit}. Short and plain: the user reads it at a glance."
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Its text as it is now, never cached: what the user sees changed, and what sending checks is still there.
        owner = repo.split("/")[0]
        name = repo.split("/")[1]
        number = int(target.split("#")[1])
        try:
            thread = await asyncio.to_thread(get_pr_status, owner, name, number)
            if thread is None:
                thread = await asyncio.to_thread(get_issue_status, owner, name, number)
        except (httpx.HTTPError, ValueError) as error:
            # GraphQL says "Could not resolve" for a number that is an issue when asked for a PR.
            try:
                thread = await asyncio.to_thread(get_issue_status, owner, name, number)
            except (httpx.HTTPError, ValueError) as second:
                return {"content": [{"type": "text", "text": f"Could not read {target}: {error}; {second}"}], "is_error": True}
        if thread is None:
            return {"content": [{"type": "text", "text": f"{target} is not a PR or issue on GitHub."}], "is_error": True}
        # Only the user's own: with their sign-in the app knows who they are (sending checks it again).
        account = self.agents.your_repositories.github_account.status()
        author = ""
        if thread["author"] is not None:
            author = thread["author"]["login"]
        if account["connected"] and author.lower() != account["login"].lower():
            text = f"{target} was opened by {author}, not the user: only the user's own PR or issue can get a new title or description. A draft_comment can suggest one."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        previous = {"title": thread["title"], "body": (thread["body"] or "").replace("\r\n", "\n")}
        title = (args.get("title") or "").strip() or previous["title"]
        body = previous["body"]
        if args.get("body") is not None:
            body = args["body"].strip()
        if title == previous["title"] and body.strip() == previous["body"].strip():
            return {"content": [{"type": "text", "text": f"That is the text {target} has already: nothing changes."}], "is_error": True}
        found = EMOJI.findall(" ".join([title, body] + list(overview.values())))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        pictures = [item["id"] for item in job["evidence"] if item["kind"] in ["screenshot", "image"]]
        unknown = [evidence_id for evidence_id in re.findall(r"evidence:(ev_[0-9a-f]{6})", body) if evidence_id not in pictures]
        if unknown:
            text = f"The description shows {', '.join(unknown)}, which aren't pictures of {job['id']}: use the ids evidence_add gave your screenshots and images."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The change for the user to read, like a PR's diff: one part for the title, one for the description.
        parts = []
        for part, old, new in [("Title", previous["title"], title), ("Description", previous["body"], body)]:
            if old.strip() == new.strip():
                continue
            lines = list(difflib.unified_diff(old.split("\n"), new.split("\n"), f"a/{part}", f"b/{part}", lineterm=""))
            parts.append(f"diff --git a/{part} b/{part}\n" + "\n".join(lines))
        diff = "\n".join(parts) + "\n"

        draft = self.agents.inbox.create(
            "edit", self.agent_id, title, body, job=job["id"], repo=repo, target=target, diff=diff, evidence=job["evidence"],
            overview=overview, previous=previous,
        )
        self.agents.jobs.update(job["id"], status="waiting_on_user", drafts=job["drafts"] + [draft["id"]])
        text = (
            f"{draft['id']} is in the user's Inbox. Nothing was changed on GitHub: the user decides, and you'll get a message "
            f"with their decision. {job['id']} waits on the user now; move on to your next job."
        )
        return {"content": [{"type": "text", "text": text}]}

    async def open_issue(self, args: dict) -> dict:
        repo = args["repo"].strip()
        title = args["title"].strip()
        if repo.count("/") != 1:
            return {"content": [{"type": "text", "text": "repo must be owner/name."}], "is_error": True}
        if not title or not args["body"].strip():
            return {"content": [{"type": "text", "text": "Give the issue a title and a body."}], "is_error": True}
        found = EMOJI.findall(title + " " + args["body"])
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        settings = {}
        if AUTOMATION_FILE.is_file():
            settings = json.loads(AUTOMATION_FILE.read_text())
        allowed = [name.lower() for name, rules in settings.items() if rules.get("open_issues")]
        if repo.lower() not in allowed:
            text = (
                f"The user doesn't let agents open issues on {repo} (its Level of automation: Open issues is off). Don't open "
                "one; put what you found in your job's notes instead."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if repo.lower() not in self.guides_read:
            text = f"First read {repo}'s rules for contributors (contributing_guide): open an issue only if they allow it, the way they say."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        no_ai = [name.lower() for name, each in self.agents.repo_signals.all().items() if (each.get("ai_policy") or {}).get("tag") == "no_ai"]
        if repo.lower() in no_ai:
            return {"content": [{"type": "text", "text": f"{repo} doesn't take AI-made contributions (its AI policy), and we only work as an AI agent: don't open issues there."}], "is_error": True}
        # Claimed for the user once it is out, so never one we wouldn't take: out of scope by the issue tags' own checks
        # (issue_tags.py CHECKS: belongs, linux, apolitical, not_game), asked before it goes to GitHub.
        questions = "\n".join(f"- {key}: {question}" for key, question in CHECKS if key in ["belongs", "linux", "apolitical", "not_game"])
        prompt = (
            f"An issue is about to be opened on the GitHub repo {repo}, and we would fix it ourselves. Answer each "
            f"question about it with true or false, and in reason say why in one plain sentence.\n{questions}\n\n"
            f"Title: {title}\n\n{args['body']}"
        )
        schema = {
            "type": "object",
            "properties": {"belongs": {"type": "boolean"}, "linux": {"type": "boolean"}, "apolitical": {"type": "boolean"}, "not_game": {"type": "boolean"}, "reason": {"type": "string"}},
            "required": ["belongs", "linux", "apolitical", "not_game", "reason"],
        }
        try:
            scope = await judge(prompt, schema, "low")
        except JudgeError as error:
            return {"content": [{"type": "text", "text": f"It wasn't opened: it couldn't be checked ({error}). Try again later."}], "is_error": True}
        if not (scope["belongs"] and scope["linux"] and scope["apolitical"] and scope["not_game"]):
            text = (
                f"It wasn't opened: it is out of scope ({scope['reason']}), so we wouldn't fix it, and an issue claimed for the "
                "user must be fixed. Don't open it; put what you found in your job's notes instead."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            opened = await asyncio.to_thread(self.agents.your_repositories.github_account.open_issue, repo, title, args["body"])
        except SendError as error:
            return {"content": [{"type": "text", "text": f"It wasn't opened. {error}"}], "is_error": True}

        # On the Dashboard's Actions, with the job the agent works on (none when it works on none).
        job_id = None
        for job in self.agents.jobs.for_agent(self.agent_id):
            if job["status"] == "working":
                job_id = job["id"]
        sent = {"url": opened["url"], "repo": opened["repo"], "number": opened["number"], "at": datetime.now(UTC).isoformat()}
        action = {"draft": None, "kind": "issue", "agent": self.agent_id, "job": job_id, "title": opened["title"], "sent": sent}
        await asyncio.to_thread(self.agents.inbox.add_action, action)

        # In the Issues list, and at the top of the board's Catalog: an issue we opened goes before every other card, so
        # an agent takes it first, whatever the repo's Take issues says (take_from_catalog in backend/issues_api.py).
        issue_id = f"{opened['repo']}#{opened['number']}"
        claimed = "assigned to the user"
        if opened["claimed"] == "comment":
            claimed = "claimed for the user with a comment (GitHub only lets the repo's own people assign there)"
        if opened["claimed"] == "none":
            claimed = "not claimed: GitHub let the user neither be assigned nor comment"
        item = {
            "id": issue_id,
            "repo": opened["repo"],
            "number": opened["number"],
            "title": opened["title"],
            "labels": [],
            "state": "OPEN",
            "comments": 0,
            "html_url": opened["url"],
            "note": f"Opened by {self.record['name']} as you, {claimed}. No claim is needed on it.",
            "added_by": self.agent_id,
            "added_at": datetime.now(UTC).isoformat(),
        }
        await asyncio.to_thread(self.agents.issues.add, [item])
        board = await asyncio.to_thread(self.agents.issues.board)
        catalog = [issue_id] + [each for each in board["catalog"] if each != issue_id]
        order = [issue_id] + [each for each in board["order"] if each != issue_id]
        await asyncio.to_thread(self.agents.issues.set_board, catalog, order, board["held"])
        text = (
            f"Opened {issue_id} as the user ({opened['url']}), {claimed}. It is in the Issues list, at the top of the "
            "board's Catalog, so another agent takes it first. Go on with your own job."
        )
        return {"content": [{"type": "text", "text": text}]}

    async def update_branch(self, args: dict) -> dict:
        pr = args["pr"].strip()
        repo, _, number = pr.rpartition("#")
        if repo.count("/") != 1 or not number.isdigit():
            return {"content": [{"type": "text", "text": "pr must be owner/name#number."}], "is_error": True}
        settings = {}
        if AUTOMATION_FILE.is_file():
            settings = json.loads(AUTOMATION_FILE.read_text())
        allowed = [name.lower() for name, rules in settings.items() if rules.get("pull_requests")]
        if repo.lower() not in allowed:
            text = (
                f"The user doesn't let agents act on PRs on {repo} (its Level of automation: Pull requests is off). When it "
                "needs the newer code, rebase it with draft_pr (pr and rebase) for the user to approve."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            result = await asyncio.to_thread(self.agents.your_repositories.github_account.manage, "update_branch", repo, int(number))
        except SendError as error:
            return {"content": [{"type": "text", "text": f"Its branch wasn't updated. {error}"}], "is_error": True}

        # On the Dashboard's Actions, with the job the agent works on (none when it works on none).
        job_id = None
        for job in self.agents.jobs.for_agent(self.agent_id):
            if job["status"] == "working":
                job_id = job["id"]
        sent = {"url": f"https://github.com/{repo}/pull/{number}", "repo": repo, "number": int(number), "at": datetime.now(UTC).isoformat()}
        action = {"draft": None, "kind": "update_branch", "agent": self.agent_id, "job": job_id, "title": "", "sent": sent}
        await asyncio.to_thread(self.agents.inbox.add_action, action)
        return {"content": [{"type": "text", "text": f"{pr}: {result}"}]}

    async def read_issue(self, args: dict) -> dict:
        thread = args["thread"].strip()
        repo, _, number = thread.rpartition("#")
        if repo.count("/") != 1 or not number.isdigit():
            return {"content": [{"type": "text", "text": "thread must be owner/name#number."}], "is_error": True}
        try:
            data = await asyncio.to_thread(get_issue_in_full, repo.split("/")[0], repo.split("/")[1], int(number))
        except httpx.HTTPStatusError as error:
            return {"content": [{"type": "text", "text": f"GitHub error {error.response.status_code}: {error.response.text[:300]}"}], "is_error": True}
        except (httpx.HTTPError, ValueError) as error:
            return {"content": [{"type": "text", "text": f"Could not read it from GitHub: {error}"}], "is_error": True}
        if data is None:
            return {"content": [{"type": "text", "text": f"{repo} has no issue or PR #{number}."}], "is_error": True}
        login = self.agents.your_repositories.github_account.status().get("login") or ""

        result = {
            "kind": "pr" if data["__typename"] == "PullRequest" else "issue",
            "title": data["title"],
            "url": data["url"],
            "state": data["state"].lower(),
            "opened": data["createdAt"],
            "updated": data["updatedAt"],
            # The user's GitHub login (None without their sign-in): what it wrote is the user's, so ours.
            "user_login": login or None,
            "author": data["author"]["login"] if data["author"] else "ghost",
            "author_role": data["authorAssociation"],
            "labels": [label["name"] for label in data["labels"]["nodes"]],
            "assignees": [person["login"] for person in data["assignees"]["nodes"]],
            "body": data["body"] or "",
            "comments": [],
            "timeline": [],
            "related_prs": [],
        }
        if data["__typename"] == "Issue":
            result["state_reason"] = data["stateReason"]
            result["milestone"] = data["milestone"]["title"] if data["milestone"] else None
        # Every comment, in full. A maintainer is one of the project's own people: OWNER, MEMBER, COLLABORATOR, or someone
        # who merged its PRs (a private member shows as CONTRIBUTOR, like grimmory's imnotjames). Only they get answers.
        # What the user wrote is marked by_user: that is us too (a claim, a reply or a version the app sent from a draft,
        # as them). On QwenPaw#8698 a reviewer took the user's own claim (role NONE, nothing more) for someone else's and
        # sent the PR back.
        for comment in data["comments"]["nodes"]:
            author = comment["author"]["login"] if comment["author"] else "ghost"
            role = "BOT" if comment["author"] and comment["author"]["__typename"] != "User" else comment["authorAssociation"]
            maintainer = role in MAINTAINERS or (role != "BOT" and author in data["mergers"])
            by_user = login != "" and author.lower() == login.lower()
            result["comments"].append({
                "at": comment["createdAt"], "author": author, "role": role, "maintainer": maintainer, "by_user": by_user,
                "text": comment["body"],
            })

        # The PRs tied to it: the ones that would close it, and every one that mentions it. Each once.
        related = []
        if data["__typename"] == "Issue":
            for each in data["closedByPullRequestsReferences"]["nodes"]:
                related.append((each, True))
        # What happened to it, oldest first, in one line each.
        for event in data["timelineItems"]["nodes"]:
            kind = event["__typename"]
            at = event.get("createdAt", "")
            actor = (event.get("actor") or {}).get("login", "ghost")
            line = ""
            if kind == "CrossReferencedEvent":
                source = event["source"]
                where = f"{source['repository']['nameWithOwner']}#{source['number']}"
                what = "PR" if source["__typename"] == "PullRequest" else "issue"
                state = source["state"].lower()
                if source["__typename"] == "PullRequest" and source.get("mergedAt"):
                    state = "merged"
                line = f"{at} {actor} mentioned it in {what} {where} ({state}): {source['title']}"
                if event["willCloseTarget"]:
                    line += ". That PR would close it"
                if source["__typename"] == "PullRequest":
                    related.append((source, event["willCloseTarget"]))
            if kind == "ReferencedEvent" and event["commit"] is not None:
                line = f"{at} {actor} referenced it in commit {event['commit']['oid'][:10]} of {event['commitRepository']['nameWithOwner']}: {event['commit']['messageHeadline']}"
            if kind in ["ConnectedEvent", "DisconnectedEvent"] and event["subject"]:
                linked = "linked" if kind == "ConnectedEvent" else "unlinked"
                line = f"{at} {actor} {linked} #{event['subject']['number']} ({event['subject']['state'].lower()}): {event['subject']['title']}"
            if kind in ["AssignedEvent", "UnassignedEvent"]:
                person = (event.get("assignee") or {}).get("login", "someone")
                line = f"{at} {actor} {'assigned' if kind == 'AssignedEvent' else 'unassigned'} {person}"
            if kind in ["LabeledEvent", "UnlabeledEvent"]:
                line = f"{at} {actor} {'added' if kind == 'LabeledEvent' else 'removed'} the label {event['label']['name']}"
            if kind == "ClosedEvent":
                line = f"{at} {actor} closed it"
                closer = event.get("closer") or {}
                if closer.get("__typename") == "PullRequest":
                    line += f" with PR #{closer['number']} ({closer['url']})"
                if closer.get("__typename") == "Commit":
                    line += f" with commit {closer['oid'][:10]} ({closer['url']})"
            if kind == "ReopenedEvent":
                line = f"{at} {actor} reopened it"
            if kind == "MarkedAsDuplicateEvent" and event.get("canonical"):
                line = f"{at} {actor} marked it a duplicate of #{event['canonical']['number']} ({event['canonical']['url']})"
            if line:
                result["timeline"].append(line)

        seen = []
        for each, closes in related:
            where = f"{each['repository']['nameWithOwner']}#{each['number']}"
            if where in seen:
                continue
            seen.append(where)
            state = "merged" if each["mergedAt"] else each["state"].lower()
            rollup = each["commits"]["nodes"][0]["commit"]["statusCheckRollup"] if each["commits"]["nodes"] else None
            result["related_prs"].append(
                {
                    "pr": where,
                    "title": each["title"],
                    "url": each["url"],
                    "state": state,
                    "draft": each["isDraft"],
                    "author": each["author"]["login"] if each["author"] else "ghost",
                    # The user's own PR (one of ours, opened as them): never someone else on it.
                    "by_user": login != "" and each["author"] is not None and each["author"]["login"].lower() == login.lower(),
                    "opened": each["createdAt"],
                    "updated": each["updatedAt"],
                    "review": each["reviewDecision"],
                    "checks": rollup["state"] if rollup else None,
                    "closes_it": closes,
                    "newest_comments": [
                        {"at": comment["createdAt"], "author": comment["author"]["login"] if comment["author"] else "ghost", "text": comment["body"][:1500]}
                        for comment in each["comments"]["nodes"]
                    ],
                    "newest_reviews": [
                        {"at": review["createdAt"], "author": review["author"]["login"] if review["author"] else "ghost", "state": review["state"], "text": review["body"][:1500]}
                        for review in each["reviews"]["nodes"]
                    ],
                }
            )

        # The PRs that name the issue's number in their title or text without GitHub linking them (opencodex#7955 fixed
        # #7954 that way, and we opened a second PR): maybe someone is on it. Some only name the number for something
        # else; the agent reads the ones that may be about it.
        if data["__typename"] == "Issue":
            result["prs_naming_its_number"] = []
            try:
                found = await asyncio.to_thread(search_issues, f"repo:{repo} is:pr {number}")
            except (httpx.HTTPError, ValueError):
                found = {"items": []}
            for item in found["items"][:10]:
                where = f"{repo}#{item['number']}"
                if where.lower() in [each.lower() for each in seen]:
                    continue
                state = item["state"]
                if (item.get("pull_request") or {}).get("merged_at"):
                    state = "merged"
                author = item["user"]["login"] if item.get("user") else "ghost"
                result["prs_naming_its_number"].append({"pr": where, "title": item["title"], "state": state, "author": author, "opened": item["created_at"][:10]})

        # The checks on the default branch's newest commit: failing there is not this change's doing.
        branch = data["default_branch"]
        rollup = branch["target"]["statusCheckRollup"] if branch and branch["target"] else None
        failing = []
        for context in (rollup["contexts"]["nodes"] if rollup else []):
            if context.get("conclusion") in ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"] or context.get("state") in ["FAILURE", "ERROR"]:
                failing.append(context.get("name") or context.get("context"))
        result["default_branch_checks"] = {"branch": branch["name"] if branch else None, "state": rollup["state"] if rollup else None, "failing": failing}

        if data["__typename"] == "PullRequest":
            head = data["commits"]["nodes"][0]["commit"] if data["commits"]["nodes"] else None
            rollup = head["statusCheckRollup"] if head else None
            failing = []
            for context in (rollup["contexts"]["nodes"] if rollup else []):
                if context.get("conclusion") in ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"] or context.get("state") in ["FAILURE", "ERROR"]:
                    failing.append(context.get("name") or context.get("context"))
            result["pr"] = {
                "draft": data["isDraft"],
                "merged": data["merged"],
                "base": data["baseRefName"],
                "head": data["headRefName"],
                "newest_commit": head["oid"] if head else None,
                "mergeable": data["mergeable"],
                "review": data["reviewDecision"],
                "checks": {"state": rollup["state"] if rollup else None, "failing": failing},
                "reviews": [],
                # The people who reviewed it (bots aren't): they get answers, like the maintainers.
                "reviewers": sorted(set(
                    review["author"]["login"] for review in data["reviews"]["nodes"]
                    if review["author"] and review["author"]["__typename"] == "User" and review["author"]["login"].lower() != login.lower()
                )),
            }
            for review in data["reviews"]["nodes"]:
                author = review["author"]["login"] if review["author"] else "ghost"
                role = "BOT" if review["author"] and review["author"]["__typename"] != "User" else review["authorAssociation"]
                maintainer = role in MAINTAINERS or (role != "BOT" and author in data["mergers"])
                by_user = login != "" and author.lower() == login.lower()
                code = [{"path": comment["path"], "text": comment["body"]} for comment in review["comments"]["nodes"]]
                result["pr"]["reviews"].append({
                    "at": review["createdAt"], "author": author, "role": role, "maintainer": maintainer, "by_user": by_user,
                    "state": review["state"], "text": review["body"], "on_code": code,
                })
            # The conversations on lines of code, with their replies: a comment's id is what draft_comment's reply_to
            # answers in that conversation.
            result["pr"]["conversations"] = []
            for conversation in data["reviewThreads"]["nodes"]:
                comments = []
                for comment in conversation["comments"]["nodes"]:
                    author = comment["author"]["login"] if comment["author"] else "ghost"
                    role = "BOT" if comment["author"] and comment["author"]["__typename"] != "User" else comment["authorAssociation"]
                    maintainer = role in MAINTAINERS or (role != "BOT" and author in data["mergers"])
                    by_user = login != "" and author.lower() == login.lower()
                    comments.append({
                        "id": comment["databaseId"], "at": comment["createdAt"], "author": author, "role": role, "maintainer": maintainer,
                        "by_user": by_user, "text": comment["body"],
                    })
                result["pr"]["conversations"].append({
                    "file": conversation["path"],
                    "line": conversation["line"],
                    "resolved": conversation["isResolved"],
                    "outdated": conversation["isOutdated"],
                    "comments": comments,
                })

        # Someone else's open PR that says it closes it, not abandoned (TAKEN_PR_DAYS, like the issue tags): someone is on
        # it, and its maintainers don't want a second fix. The user's own PRs (ours too, made as the user) don't count.
        recent = (datetime.now(UTC) - timedelta(days=TAKEN_PR_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
        taken = ""
        for pr in result["related_prs"]:
            if pr["state"] == "open" and pr["closes_it"] and pr["author"].lower() != login.lower() and pr["updated"] >= recent:
                taken = f"{pr['pr']} by {pr['author']} ({pr['url']}) is open and closes it"
        # An issue the user opened (ours too, opened as the user) is never given up, whoever else shows up.
        if login != "" and result["author"].lower() == login.lower():
            taken = ""
        self.threads_read[thread.lower()] = time.time()
        self.threads_taken[thread.lower()] = taken
        # When someone other than the user last wrote there (a bot too: a CLA bot's request needs its answer).
        times = [comment["at"] for comment in result["comments"] if comment["author"].lower() != login.lower()]
        if "pr" in result:
            times += [review["at"] for review in result["pr"]["reviews"] if review["author"].lower() != login.lower()]
            for conversation in result["pr"]["conversations"]:
                times += [comment["at"] for comment in conversation["comments"] if comment["author"].lower() != login.lower()]
        self.threads_other_at[thread.lower()] = max(times) if times else None
        if taken:
            result["someone_else_is_on_it"] = (
                f"{taken}: someone else is on it. Don't claim it, comment that you'd like it or start a second fix: on a "
                "fix_issue job, close_issue with that link."
            )
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    async def close_issue(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["kind"] != "fix_issue" or job["issue"] is None:
            return {"content": [{"type": "text", "text": "close_issue is for a fix_issue job's issue."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} already; nothing to close."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        reason = args["reason"].strip()
        if not reason:
            return {"content": [{"type": "text", "text": "Say why, with the link that shows it."}], "is_error": True}
        read_at = self.threads_read.get(job["issue"].lower())
        if read_at is None or time.time() - read_at > READ_SECONDS:
            text = f"First read {job['issue']} in full with read_issue, then decide."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The job ends first, so its claim isn't posted from now on (github_account.py refuses one whose job ended); then
        # what still waits for the user is withdrawn.
        self.agents.jobs.add_timeline(job["id"], "status", f"Closed by {self.record['name']}: {reason}")
        self.agents.jobs.update(job["id"], status="cancelled", notes=reason)
        posted = []
        for draft_id in job["drafts"]:
            try:
                draft = self.agents.inbox.get(draft_id)
            except KeyError:
                continue
            if draft["status"] == "pending":
                try:
                    draft = self.agents.inbox.decide(draft_id, "rejected", f"Withdrawn by {self.record['name']}: {reason}")
                except ValueError:
                    # Decided in the meantime.
                    draft = self.agents.inbox.get(draft_id)
            # On GitHub already: repowise#5421's repo's Level of automation posted the claim two seconds after it was drafted,
            # before its agent found the fix merged days before, and the agent took close_issue's silence for a withdrawal.
            # It takes it back.
            if draft["kind"] == "comment" and draft["sent"] is not None and draft["sent"].get("deleted_at") is None:
                posted.append(f"{draft['id']} ({draft['sent']['url']})")
        result = await asyncio.to_thread(self.agents.issues.dismiss, [job["issue"]])
        text = f"Closed: {job['id']} is cancelled, and {job['issue']} is off the Issues board for good. Nothing on GitHub changed."
        if result["working"]:
            text = f"{job['id']} is cancelled. {job['issue']} stays on the Issues board: another job on it is still open."
        if posted:
            text += (
                f" But your claim was posted already: {', '.join(posted)}. Take it back with delete_comment (where the repo's "
                "Level of automation allows comments); otherwise tell the user in one line, so they delete it."
            )
        vm_name, place = self.agents.queue.place(self.agent_id)
        left = [other for other in self.agents.jobs.for_agent(self.agent_id) if other["status"] in OPEN_STATUSES and other["vm"] == vm_name]
        if place == 0 and not left:
            text += f" You have no open jobs left for {vm_name}: call release_vm now."
        return {"content": [{"type": "text", "text": text}]}

    async def delete_comment(self, args: dict) -> dict:
        url = args["comment"].strip()
        mine = None
        for draft in self.agents.inbox.list():
            sent = draft["sent"]
            if draft["agent"] == self.agent_id and draft["kind"] == "comment" and sent is not None and sent.get("url") == url:
                mine = draft
        if mine is None:
            text = "Only a comment of yours: one the app posted from your draft. Give its link as your decision message gave it."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        sent = mine["sent"]
        if sent.get("deleted_at"):
            return {"content": [{"type": "text", "text": "It was deleted already."}], "is_error": True}
        if mine["reply_to"] is not None:
            text = "It is a reply in a conversation on lines of code: the app can't take those back. Leave it, or say what changed in a new reply."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        settings = {}
        if AUTOMATION_FILE.is_file():
            settings = json.loads(AUTOMATION_FILE.read_text())
        allowed = [name.lower() for name, rules in settings.items() if rules.get("comments")]
        if sent["repo"].lower() not in allowed:
            text = f"The user doesn't let agents post comments on {sent['repo']} (its Level of automation: Comments is off), so you can't take one back there either."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            result = await asyncio.to_thread(self.agents.your_repositories.github_account.manage, "delete_comment", sent["repo"], sent["id"])
        except SendError as error:
            return {"content": [{"type": "text", "text": f"It wasn't deleted. {error}"}], "is_error": True}
        self.agents.inbox.mark_sent(mine["id"], {**sent, "deleted_at": datetime.now(UTC).isoformat()})
        return {"content": [{"type": "text", "text": result}]}

    async def close_pr(self, args: dict) -> dict:
        pr = args["pr"].strip()
        repo, _, number = pr.rpartition("#")
        if repo.count("/") != 1 or not number.isdigit():
            return {"content": [{"type": "text", "text": "pr must be owner/name#number."}], "is_error": True}
        owned = []
        for draft in self.agents.inbox.list():
            sent = draft["sent"]
            if draft["agent"] == self.agent_id and draft["kind"] == "pr" and sent is not None and not sent.get("update"):
                owned.append(f"{sent['repo']}#{sent['number']}".lower())
        if pr.lower() not in owned:
            return {"content": [{"type": "text", "text": f"{pr} isn't a PR of yours (one the app opened from your draft)."}], "is_error": True}
        settings = {}
        if AUTOMATION_FILE.is_file():
            settings = json.loads(AUTOMATION_FILE.read_text())
        allowed = [name.lower() for name, rules in settings.items() if rules.get("pull_requests")]
        if repo.lower() not in allowed:
            text = f"The user doesn't let agents send PRs on {repo} (its Level of automation: Pull requests is off), so you can't close one there either."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        comment = (args.get("comment") or "").strip()
        if comment == "":
            return {"content": [{"type": "text", "text": "comment is required: why it is closed, for the maintainers."}], "is_error": True}
        # Why first, then the close: a PR closed without a word makes the maintainers ask.
        github_account = self.agents.your_repositories.github_account
        try:
            posted = await asyncio.to_thread(github_account.comment, pr, comment)
        except SendError as error:
            return {"content": [{"type": "text", "text": f"It wasn't closed: the comment didn't go. {error}"}], "is_error": True}
        try:
            result = await asyncio.to_thread(github_account.manage, "close", repo, int(number))
        except SendError as error:
            return {"content": [{"type": "text", "text": f"The comment is on it ({posted['url']}), but it wasn't closed. {error}"}], "is_error": True}
        return {"content": [{"type": "text", "text": f"{pr}: posted why ({posted['url']}), then {result}"}]}

    async def drop_commits(self, args: dict) -> dict:
        pr = args["pr"].strip()
        back_to = args["back_to"].strip().lower()
        repo, _, number = pr.rpartition("#")
        if repo.count("/") != 1 or not number.isdigit():
            return {"content": [{"type": "text", "text": "pr must be owner/name#number."}], "is_error": True}
        if len(back_to) < 7:
            return {"content": [{"type": "text", "text": "back_to is a commit's sha, at least its first 7 characters."}], "is_error": True}
        # Its own pushes on this PR, oldest first: where each ended, and where the PR was before each update or rebase.
        pushes = []
        for draft in self.agents.inbox.list():
            sent = draft["sent"]
            if draft["agent"] == self.agent_id and draft["kind"] == "pr" and sent is not None and f"{sent['repo']}#{sent['number']}".lower() == pr.lower():
                pushes.append(sent)
        pushes.sort(key=lambda sent: sent["at"])
        if not pushes:
            return {"content": [{"type": "text", "text": f"You pushed nothing to {pr}: only your own commits can be taken back."}], "is_error": True}
        points = []
        for sent in pushes:
            points.append(sent["commit"])
            if sent.get("update") and sent.get("rebase_of"):
                points.append(sent["rebase_of"])
            elif sent.get("update"):
                points.append(sent["base_sha"])
        head = pushes[-1]["commit"]
        matches = [sha for sha in points if sha.startswith(back_to) and sha != head]
        if not matches:
            text = (
                f"back_to must be where {pr} was before one of your pushes: {', '.join(sorted(set(sha[:10] for sha in points if sha != head)))}. "
                "To take back the whole PR, close_pr."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        settings = {}
        if AUTOMATION_FILE.is_file():
            settings = json.loads(AUTOMATION_FILE.read_text())
        allowed = [name.lower() for name, rules in settings.items() if rules.get("pull_requests")]
        if repo.lower() not in allowed:
            text = f"The user doesn't let agents send PRs on {repo} (its Level of automation: Pull requests is off), so you can't take commits back there either."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            result = await asyncio.to_thread(
                self.agents.your_repositories.github_account.manage, "reset_branch", repo, int(number), sha=matches[0], expected_head=head
            )
        except SendError as error:
            return {"content": [{"type": "text", "text": f"Nothing was taken back. {error}"}], "is_error": True}
        return {"content": [{"type": "text", "text": f"{pr}: {result}"}]}

    async def report_problem(self, args: dict) -> dict:
        text = args["text"].strip()
        if not text:
            return {"content": [{"type": "text", "text": "Say what happened, why, and what should have happened."}], "is_error": True}
        about = (args.get("about") or "").strip() or None
        # With the job the agent works on (none when it works on none).
        job_id = None
        for job in self.agents.jobs.for_agent(self.agent_id):
            if job["status"] == "working":
                job_id = job["id"]
        item = await asyncio.to_thread(self.agents.problems.add, self.agent_id, job_id, about, text)
        text = f"Reported as {item['id']} on the Dashboard's Problems list; the user fixes them all at one time. Go on with your work."
        return {"content": [{"type": "text", "text": text}]}

    async def draft_question(self, args: dict) -> dict:
        question = args["question"].strip()
        if not question:
            return {"content": [{"type": "text", "text": "The question is empty."}], "is_error": True}
        options = [option.strip() for option in (args.get("options") or []) if option.strip()]
        if len(options) == 1 or len(options) > QUESTION_OPTIONS_MAX:
            text = f"Give 2 to {QUESTION_OPTIONS_MAX} options, or none when the user answers in their own words."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        for option in options:
            if len(option) > QUESTION_OPTION_CHARS:
                text = f"An option is {len(option)} characters; keep each under {QUESTION_OPTION_CHARS}: it is a button. The question says what each means."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        recommended = (args.get("recommended") or "").strip() or None
        must_wait = (args.get("must_wait") or "").strip() or None
        if options and recommended not in options:
            text = (
                "Give recommended: the option you would pick, written exactly as in options. Unless the question must wait, "
                "the app picks it for the user when they don't answer in time."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if must_wait is not None and must_wait not in MUST_WAIT:
            text = f"must_wait is one of: {', '.join(MUST_WAIT)}. Leave it out for anything else."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        found = EMOJI.findall(" ".join([question] + options))
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

        # Timed, unless it must wait (inbox.py): one without options always does ("open"), and so does one marked with a
        # kind the user's Settings keep waiting. A kind they switched off is timed like any other.
        settings = {"timer_minutes": TIMER_MINUTES, "must_wait": list(MUST_WAIT)}
        if ASK_SETTINGS_FILE.is_file():
            settings.update(json.loads(ASK_SETTINGS_FILE.read_text()))
        answer_by = None
        if not options:
            recommended = None
            must_wait = "open"
        elif must_wait not in settings["must_wait"]:
            must_wait = None
            answer_by = (datetime.now(UTC) + timedelta(minutes=settings["timer_minutes"])).isoformat()
        answer = "You'll get a message with their answer."
        if answer_by is not None:
            answer = (
                f"If they don't answer within {settings['timer_minutes']} minutes, the app picks your recommendation "
                f"({recommended}), and you get a message saying so."
            )

        # The subject line is the question's first line.
        title = question.split("\n")[0][:120]
        if job is None:
            self.agents.inbox.create("question", self.agent_id, title, question, options=options, recommended=recommended, answer_by=answer_by, must_wait=must_wait)
            text = "Your question is in the user's Inbox. " + answer
            return {"content": [{"type": "text", "text": text}]}

        # A follow-up's question is about its PR or issue.
        target = job["thread"] or job["issue"]
        draft = self.agents.inbox.create(
            "question", self.agent_id, title, question, job=job["id"], repo=job["repo"], target=target, evidence=job["evidence"], options=options,
            recommended=recommended, answer_by=answer_by, must_wait=must_wait
        )
        self.agents.jobs.update(job["id"], status="waiting_on_user", drafts=job["drafts"] + [draft["id"]])
        text = f"Your question is in the user's Inbox. {job['id']} waits on the user now; move on to your next job. " + answer
        # A short timed question keeps the desktop (QUESTION_HOLD_SECONDS, the VM rule in agents.py): the answer comes
        # within minutes, and giving the desktop back can mean days in a full VM's line (opencodex#8319).
        vm_name, place = self.agents.queue.place(self.agent_id)
        if answer_by is not None and settings["timer_minutes"] * 60 <= QUESTION_HOLD_SECONDS and place == 0 and vm_name == job["vm"]:
            text += (
                f" Keep your desktop of {vm_name} meanwhile: don't release_vm for this. Do your other jobs there, or end your "
                "turn; the answer wakes you, and you go on there at once."
            )
        return {"content": [{"type": "text", "text": text}]}

    async def paper_read(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["paper"] is None:
            return {"content": [{"type": "text", "text": f"{job['id']} has no paper."}], "is_error": True}
        try:
            target = self.agents.artifacts.resolve(self.agent_id, job["paper"])
        except ArtifactsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        if not target.is_file():
            text = f"{job['paper']} is not in your artifacts anymore (the user may have moved it); ask the user where it is."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        info = await asyncio.to_thread(subprocess.run, ["pdfinfo", str(target)], capture_output=True, text=True, timeout=60)
        match = re.search(r"^Pages:\s+(\d+)", info.stdout, re.MULTILINE)
        if info.returncode != 0 or match is None:
            return {"content": [{"type": "text", "text": f"Could not read {job['paper']} as a PDF: {info.stderr.strip()}"}], "is_error": True}
        total = int(match.group(1))
        parts = (args.get("pages") or "").replace(" ", "").split("-")
        if len(parts) > 2 or not all(part.isdigit() for part in parts):
            return {"content": [{"type": "text", "text": "pages is one page ('3') or a range ('1-5')."}], "is_error": True}
        first = int(parts[0])
        last = int(parts[-1])
        if first < 1 or last < first or first > total:
            return {"content": [{"type": "text", "text": f"The paper has pages 1 to {total}."}], "is_error": True}
        last = min(last, total, first + PAPER_PAGES - 1)

        content = [{"type": "text", "text": f"{job['paper']}: pages {first} to {last} of {total}, as pictures, then their text."}]
        with tempfile.TemporaryDirectory() as folder:
            command = ["pdftoppm", "-f", str(first), "-l", str(last), "-scale-to", str(PAPER_PIXELS), "-jpeg", "-jpegopt", "quality=80", str(target), f"{folder}/page"]
            render = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True, timeout=300)
            if render.returncode != 0:
                return {"content": [{"type": "text", "text": f"Could not show the pages: {render.stderr.strip()}"}], "is_error": True}
            # page-01.jpg, page-02.jpg, ...: the same width of number, so they sort in page order.
            for picture in sorted(Path(folder).glob("page*.jpg")):
                data = await asyncio.to_thread(picture.read_bytes)
                content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/jpeg"})
        words = await asyncio.to_thread(subprocess.run, ["pdftotext", "-layout", "-f", str(first), "-l", str(last), str(target), "-"], capture_output=True, text=True, timeout=120)
        text = words.stdout.strip()[:50_000]
        if text == "":
            text = "(These pages have no text layer: read the pictures.)"
        if last < total:
            text += f"\n\n[Pages {last + 1} to {total} are next.]"
        content.append({"type": "text", "text": text})
        return {"content": content}

    async def draft_report(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["kind"] != "reproduce_paper":
            return {"content": [{"type": "text", "text": "draft_report is for reproduce_paper jobs."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} (the user may have cancelled it): no drafts for it anymore. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        title = (args.get("title") or "").strip()
        body = (args.get("body") or "").strip()
        if title == "" or body == "":
            return {"content": [{"type": "text", "text": "Give the report a title and a body."}], "is_error": True}

        # The user reads these first: they must be there, and short.
        overview = {
            "paper": (args.get("paper") or "").strip(),
            "claims": (args.get("claims") or "").strip(),
            "verdict": (args.get("verdict") or "").strip(),
        }
        for part, text in overview.items():
            limit = OVERVIEW_PROJECT_CHARS if part == "paper" else OVERVIEW_PART_CHARS
            if not text:
                return {"content": [{"type": "text", "text": f"Give {part}: the user reads it to understand the report."}], "is_error": True}
            if len(text) > limit:
                text = f"{part} is {len(text)} characters; keep it under {limit}. Short and plain: the user reads it at a glance."
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        results = []
        for row in args.get("results") or []:
            result = {
                "what": str(row.get("what") or "").strip(),
                "paper": str(row.get("paper") or "").strip(),
                "ours": str(row.get("ours") or "").strip(),
                "authors": str(row.get("authors") or "").strip(),
                "note": str(row.get("note") or "").strip(),
            }
            if result["what"] == "" or result["paper"] == "" or result["ours"] == "":
                return {"content": [{"type": "text", "text": "Every row of results needs what, paper and ours."}], "is_error": True}
            for value in result.values():
                if len(value) > REPORT_CELL_CHARS:
                    text = f"A row of results has a part of {len(value)} characters; keep each under {REPORT_CELL_CHARS}."
                    return {"content": [{"type": "text", "text": text}], "is_error": True}
            results.append(result)
        if len(results) > REPORT_RESULTS_MAX:
            text = f"{len(results)} rows of results; keep it to the {REPORT_RESULTS_MAX} that matter most, the rest goes in the body."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Each problem is proven by a command run on the job: its output shows the problem.
        commands = [item["id"] for item in job["evidence"] if item["kind"] == "command"]
        problems = []
        for row in args.get("problems") or []:
            problem = {
                "title": str(row.get("title") or "").strip(),
                "what": str(row.get("what") or "").strip(),
                "why": str(row.get("why") or "").strip(),
                "evidence": str(row.get("evidence") or "").strip(),
            }
            if problem["title"] == "" or problem["what"] == "" or problem["why"] == "":
                return {"content": [{"type": "text", "text": "Every problem needs a title, what and why."}], "is_error": True}
            if len(problem["title"]) > REPORT_CELL_CHARS or len(problem["what"]) > OVERVIEW_PART_CHARS or len(problem["why"]) > OVERVIEW_PART_CHARS:
                text = f"Keep a problem's title under {REPORT_CELL_CHARS} characters, and what and why under {OVERVIEW_PART_CHARS} each."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            if problem["evidence"] not in commands:
                text = (
                    f"\"{problem['title']}\" has no proof: evidence must be the id of a command run on {job['id']} that shows it "
                    "(evidence_add kind command, stage other, topic the problem's title; my_jobs lists them). A problem you "
                    "can't show with a run is not a problem yet: check it, or leave it out."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            problems.append(problem)
        if len(problems) > REPORT_PROBLEMS_MAX:
            text = f"{len(problems)} problems; keep the {REPORT_PROBLEMS_MAX} that matter most, the rest goes in the body."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        unchecked = [str(item).strip() for item in (args.get("unchecked") or []) if str(item).strip()]
        overview["results"] = results
        overview["problems"] = problems
        overview["unchecked"] = unchecked

        everything = [title, body] + [overview["paper"], overview["claims"], overview["verdict"]] + unchecked
        for row in results + problems:
            everything += list(row.values())
        found = EMOJI.findall(" ".join(everything))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}

        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)

        # The code, as a diff where every file is new, so the Inbox shows it like a PR's. Files over REPORT_FILE_KIB are
        # left out: data and results, not code. git diff --no-index exits 1 when the files differ, which they always do.
        code = (args.get("code") or "").strip()
        folder = shlex.quote(code.removeprefix("~/") or ".")
        command = (
            f"cd -- {folder} && find . -type f -not -path './.git/*' -size -{REPORT_FILE_KIB}k -printf '%P\\n' | sort | "
            f"while read -r file; do git diff --no-index --no-color -- /dev/null \"$file\"; done | head -c {DIFF_LIMIT + 1}"
        )
        try:
            result = await asyncio.to_thread(vm.exec, command, 120)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        diff = result.stdout
        if diff.strip() == "":
            text = f"Found no code in {code} ({result.stderr.strip() or 'no files under 1 MB'}). code is the folder in the VM with your scripts; git must be installed."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if len(diff.encode()) > DIFF_LIMIT:
            text = f"The code in {code} is over {DIFF_LIMIT // 1000} KB. Keep only your scripts and small inputs there: move data and results out."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The code is shown in the Inbox and sent to the browser: a secret must never be in it. Named by its variable.
        for env_name, value in list(vm_record.global_env.items()) + list(vm_record.env.items()):
            if len(value) >= HIDE_MIN_LENGTH and value in diff:
                text = f"The code contains the value of the environment variable {env_name}. Take it out (read it as ${env_name}), then try again."
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The user may have cancelled the job while the command ran.
        job = self.agents.jobs.get(job["id"])
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} now (the user may have cancelled it): no draft was made. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        draft = self.agents.inbox.create(
            "report", self.agent_id, title, body, job=job["id"], diff=diff, vm=vm_name, path=code, evidence=job["evidence"], overview=overview
        )
        self.agents.jobs.update(job["id"], status="waiting_on_user", step="report", drafts=job["drafts"] + [draft["id"]])
        files = len([line for line in diff.split("\n") if line.startswith("diff --git ")])
        text = (
            f"{draft['id']} is in the user's Inbox: {len(results)} results, {len(problems)} problems, {files} files of code. "
            f"Nothing was sent anywhere. {job['id']} waits on the user now; release_vm if nothing else needs {vm_name}, and "
            "you'll get a message with their decision."
        )
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
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)
        computer = Computer(vm, f"sandbox-agent-{self.agent_id}")
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
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)
        # Commands run in the home folder, so ~/x and x are the same; the copy needs the full path.
        where = await asyncio.to_thread(vm.exec, f"realpath -e -- {shlex.quote(source.removeprefix('~/'))}", 30)
        if where.returncode != 0:
            return {"content": [{"type": "text", "text": f"{source} is not in the VM."}], "is_error": True}
        try:
            saved = await asyncio.to_thread(self.agents.artifacts.from_vm, self.agent_id, vm, where.stdout.strip(), args.get("folder") or "")
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
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)
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
        where = await asyncio.to_thread(vm.exec, f"realpath -e -- {shlex.quote(folder or '.')}", 30)
        if where.returncode != 0:
            return {"content": [{"type": "text", "text": f"{args.get('folder')} is not a folder in the VM."}], "is_error": True}
        try:
            await asyncio.to_thread(to_vm, vm, str(source), where.stdout.strip())
        except FileTransferError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        return {"content": [{"type": "text", "text": f"Copied into the VM as {where.stdout.strip()}/{source.name}."}]}

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
        self.record["pr_examples_read"] = sorted(self.pr_examples_read)

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
        # The organization's AI policy holds for all its repos (nextcloud's, in nextcloud/.github), unless it has its own.
        if not any("ai_policy" in path.lower() for path, text in documents):
            try:
                data = await asyncio.to_thread(get_contents, owner, ".github", "AI_POLICY.md")
            except (httpx.HTTPError, ValueError):
                data = None
            if isinstance(data, dict) and data.get("encoding") == "base64":
                documents.append((f"{owner}/.github: AI_POLICY.md", base64.b64decode(data["content"]).decode("utf-8", errors="replace")))
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

        if not documents and not folder_rules:
            self.guides_read.add(name.lower())
            self.record["guides_read"] = sorted(self.guides_read)
            text = (
                f"{name} has no rules for contributors that could be found: no CONTRIBUTING, developer guide, PR template or "
                "AGENTS.md in the repo, and no link to one in its README. Go by its README and its CI config (.github/workflows/)."
            )
            return {"content": [{"type": "text", "text": text}]}
        # Each document as one block, cut at GUIDE_CHARS; all of them together at GUIDE_TOTAL_CHARS.
        blocks = []
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
            blocks.append(f"=== {title} ===\n{text}")
        # The blocks in parts of at most GUIDE_PART_CHARS, never splitting a document: one long answer is more than a
        # tool's answer may be, and the agent couldn't read it at all.
        parts = [[]]
        size = 0
        for block in blocks:
            if parts[-1] and size + len(block) > GUIDE_PART_CHARS:
                parts.append([])
                size = 0
            parts[-1].append(block)
            size += len(block)
        part = args.get("part")
        if part is None:
            part = self.guide_parts.get(name.lower(), 0) + 1
            if part > len(parts):
                part = 1
        if not isinstance(part, int) or part < 1 or part > len(parts):
            text = f"{name}'s rules for contributors come in {len(parts)} parts: part is 1 to {len(parts)}."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        lines = [
            f"The rules for contributors to {name}: {len(documents)} documents. Follow every rule in them, however long the "
            "checks they ask for take."
        ]
        if len(parts) > 1:
            lines[0] += f" They come in {len(parts)} parts; this is part {part}."
        for block in parts[part - 1]:
            lines.append("")
            lines.append(block)
        self.guide_parts[name.lower()] = part
        if part < len(parts):
            lines.append("")
            lines.append(
                f"End of part {part} of {len(parts)}: read on with contributing_guide again (it gives the next part), or with "
                f"part {part + 1}. run_tests and draft_pr wait until you read the last part."
            )
            return {"content": [{"type": "text", "text": "\n".join(lines)}]}

        # The last part: the guide is read.
        self.guides_read.add(name.lower())
        self.record["guides_read"] = sorted(self.guides_read)
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
        # No new PR on a repo that doesn't take AI-made contributions.
        no_ai = [name.lower() for name, each in self.agents.repo_signals.all().items() if (each.get("ai_policy") or {}).get("tag") == "no_ai"]
        if pr is None and job["kind"] == "fix_issue" and repo is not None and repo.lower() in no_ai:
            text = f"{repo} doesn't take AI-made contributions (its AI policy), and we only work as an AI agent. Don't draft a PR there: abandon {job['id']} with job_update cancelled."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # A rebase of that PR: its commits replace the PR's (rebased onto the newer main, or squashed, reworded or signed
        # off), and approving force-pushes them.
        rebase = args.get("rebase") is True
        if rebase and pr is None:
            return {"content": [{"type": "text", "text": "rebase is only for a new version of the user's open PR: give pr too."}], "is_error": True}
        # A fresh PR in place of one of its own that stalled: the old one is closed once this one is on GitHub. A remake
        # job's (Agents.remake_pr: a fix_issue job whose thread is that PR) does it by itself.
        replaces = (args.get("replaces") or "").strip() or None
        if replaces is None and job["kind"] == "fix_issue" and job["thread"] is not None:
            replaces = job["thread"]
        if replaces is not None and pr is not None:
            return {"content": [{"type": "text", "text": "replaces is for a new PR in place of an old one: leave pr and rebase out."}], "is_error": True}
        # A new version's body is posted below the PR: one comment of ours per round there (draft_comment). When ours
        # already speaks for it, with nothing anyone else wrote after it, the push goes without one. An older version
        # still waiting doesn't count: this one replaces it.
        since = None
        ours = []
        if pr is not None and args["body"].strip():
            since = self.threads_other_at.get(pr.lower())
            ours = self.agents.inbox.list()
        for each in ours:
            if since is not None and datetime.fromisoformat(each["created_at"]) <= datetime.fromisoformat(since):
                continue
            said = each["kind"] == "comment" and each["status"] in ["pending", "approved"] and each.get("reply_to") is None and (each["target"] or "").lower() == pr.lower()
            pushed = each["kind"] == "pr" and each["status"] == "approved" and (each["update_of"] or "").lower() == pr.lower() and each["body"].strip() != ""
            if said or pushed:
                text = (
                    f"{each['id']} ({each['status']}) already speaks for this round on {pr}: nobody else wrote there since. "
                    "One comment per round: leave body empty, so the push goes without a comment."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        # One new version of a PR waits at a time: approving two would push one and force-push the other onto the same
        # branch, and the work is done twice (openmed#5511: one agent's follow-up on its issue drafted a commit on top of
        # it while another agent's follow-up on the PR rebased that same commit, and both reached review together). Another
        # job's that waits (in review, in the Inbox, or approved and not sent yet) holds it; a newer one of this job's own
        # is the user's to pick.
        others = []
        if pr is not None:
            others = self.agents.inbox.list()
        for each in others:
            if each["kind"] != "pr" or (each["update_of"] or "").lower() != pr.lower() or each["job"] == job["id"]:
                continue
            if each["status"] == "pending" or (each["status"] == "approved" and each["sent"] is None):
                holder = each["agent"]
                if holder in self.agents.agents:
                    holder = self.agents.agents[holder].name
                if each["agent"] == self.agent_id:
                    holder = "you"
                where = "in its review or the user's Inbox"
                if each["status"] == "approved":
                    where = "approved, not sent yet"
                text = (
                    f"{each['id']} by {holder} ({each['job']}) is already the next version of {pr}, {where}. Don't draft "
                    "a second one from another job: two would push one and force-push the other onto the same branch. Leave "
                    f"it to that one (a change to it is drafted in its own job): put what yours would add in {job['id']}'s "
                    "notes and mark it done (job_update). A new follow-up comes with the PR's next change (that push, or a "
                    "review)."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        if replaces is not None:
            owned = []
            for each in self.agents.inbox.list():
                sent = each["sent"]
                if each["agent"] == self.agent_id and each["kind"] == "pr" and sent is not None and not sent.get("update"):
                    owned.append(f"{sent['repo']}#{sent['number']}".lower())
            if replaces.lower() not in owned and not (job["kind"] == "fix_issue" and job["thread"] == replaces):
                text = f"{replaces} isn't a PR of yours (one the app opened from your draft): only your own is made again fresh."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        # One of the Workflow tab's repositories (github_searcher/workflow.py), from its own worker: the pull request goes
        # there, to its review agent, not to the Inbox. Every change there is a new pull request.
        workflow = None
        if self.record.get("workflow") is not None and repo is not None and self.record["workflow"].lower() == repo.lower():
            workflow = self.agents.workflow.get(repo)
        if workflow is not None and pr is not None:
            text = "On the Workflow tab every change is a new pull request: leave pr and rebase out."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
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
        # Every point that was asked, done or not and how it was shown: the user sees the gaps before approving, and the
        # reviewer checks them against the issue and the thread. Maintainers shouldn't be the ones to find them.
        checklist = []
        for point in args.get("checklist") or []:
            if not isinstance(point, dict):
                return {"content": [{"type": "text", "text": "Each checklist point is an object with item, done and how."}], "is_error": True}
            item = str(point.get("item") or "").strip()
            how = str(point.get("how") or "").strip()
            if not item or not how or not isinstance(point.get("done"), bool):
                text = "Each checklist point needs item (the point), done (true or false) and how (what you ran that shows it, or why it isn't done)."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            if len(item) > CHECKLIST_ITEM_CHARS or len(how) > CHECKLIST_HOW_CHARS:
                text = f"Keep each checklist point's item under {CHECKLIST_ITEM_CHARS} characters and its how under {CHECKLIST_HOW_CHARS}."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            checklist.append({"item": item, "done": point["done"], "how": how})
        if not checklist or len(checklist) > CHECKLIST_MAX:
            text = (
                f"Give the checklist, 1 to {CHECKLIST_MAX} points: every point that was asked, one by one (each requirement of "
                "the issue, its acceptance criteria and every part of its spec; for a new version, each point the maintainers "
                "and reviewers raised), done or not, and how you showed it. Go through the issue and the thread again for it."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        also_tested = [str(case).strip() for case in (args.get("also_tested") or []) if str(case).strip()]
        if not also_tested or len(also_tested) > ALSO_TESTED_MAX:
            text = (
                f"Give also_tested, 1 to {ALSO_TESTED_MAX} cases of the same kind beyond the issue's or the reviewer's own example "
                "that you ran, each with what came out (other values, limits, types, inputs, platforms, drivers or backends). "
                "If you only tried the asked example, try the rest of its kind now, before you draft."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        for case in also_tested:
            if len(case) > ALSO_TESTED_CHARS:
                text = f"A case in also_tested is {len(case)} characters; keep each under {ALSO_TESTED_CHARS}."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        overview["checklist"] = checklist
        overview["also_tested"] = also_tested
        everything = [args["title"], args["body"], overview["project"], overview["problem"], overview["cause"], overview["fix"]] + risks + also_tested
        for point in checklist:
            everything += [point["item"], point["how"]]
        found = EMOJI.findall(" ".join(everything))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        # No word on AI helping unless the repo's AI policy asks for it (disclose).
        signals = self.agents.repo_signals.get(repo) if repo is not None else None
        policy = signals["ai_policy"]["tag"] if signals is not None else "none"
        note = AI_NOTE.search(args["title"] + "\n" + args["body"])
        if note is not None and policy != "disclose":
            text = (
                f"{repo}'s AI policy is {policy}, not disclose: its PRs say nothing about AI helping (no AI section, no line "
                f"that an AI or agent prepared it). Take out \"{note.group(0)}\" and what goes with it, then draft again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # A repo whose AI policy is disclose wants it said in every PR: one without it cost kestra's PRs a review round each.
        if note is None and policy == "disclose" and pr is None:
            text = (
                f"{repo}'s AI policy is disclose: its PRs say plainly that AI tools helped. Say so in the body, the way its "
                "rules or its PR template ask (its AI section or checkbox, else a short line such as 'AI-assisted: written "
                "with the help of Claude Code'), then draft again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # One of the user's projects (github_searcher/projects.py): its rules are its own files (CLAUDE.md, README, docs),
        # read in the VM, and its PR titles are Conventional Commits (its release notes and next version come from them).
        project = self.agents.projects.get(repo)
        if (project is not None or workflow is not None) and (TITLE.fullmatch(args["title"].strip()) is None or len(args["title"].strip()) > TITLE_CHARS):
            text = (
                f"{repo}'s PR titles are Conventional Commits: type(scope): summary, e.g. 'fix(search): keep the filter after a "
                f"reload'. type is feat, fix, refactor, docs, style, test, chore or perf; one scope, the area changed; the summary "
                f"lower case, imperative, no period, the whole title under {TITLE_CHARS} characters."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # Written from the project's rules and the way its own people write their PRs: the agent has to have read both.
        # A new version of an open PR keeps that PR's description, so only the rules (its commits follow them too).
        if project is None and workflow is None and repo is not None and repo.lower() not in self.guides_read:
            text = f"First read {repo}'s rules for contributors (contributing_guide), then write the PR the way they say."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if project is None and workflow is None and pr is None and repo is not None and repo.lower() not in self.pr_examples_read:
            text = f"First read how {repo}'s own people write their PRs (pr_examples), then write yours the same way."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # Someone may have taken the issue while the agent worked on it (repowise#5369: someone else's PR that closes it
        # was opened hours before the draft): a new PR's issue is read again first, and no PR goes while someone else's
        # open PR closes it. Not on the user's own repos.
        if project is None and workflow is None and pr is None and job["kind"] == "fix_issue" and job["issue"] is not None:
            read_at = self.threads_read.get(job["issue"].lower())
            if read_at is None or time.time() - read_at > READ_SECONDS:
                text = (
                    f"First read {job['issue']} again with read_issue (every new comment and PR): someone may have claimed it "
                    "or opened a PR for it while you worked. Then draft."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            if self.threads_taken.get(job["issue"].lower()):
                text = (
                    f"{self.threads_taken[job['issue'].lower()]}: someone else is on it now, and its maintainers don't want a "
                    "second fix. Don't draft it: close_issue with that link."
                )
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
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)

        # Commands run in the user's home, so ~/click and click are the same folder.
        folder = shlex.quote(args["path"].strip().removeprefix("~/"))
        base = shlex.quote(args["base"].strip())
        try:
            result = await asyncio.to_thread(vm.exec, f"cd {folder} && pwd && git rev-parse --abbrev-ref HEAD", 60)
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
            result = await asyncio.to_thread(vm.exec, command, 60)
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
            result = await asyncio.to_thread(vm.exec, command, 120)
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
        # (file, not path: path is the repo folder the draft keeps.)
        for chunk in diff.split("\ndiff --git "):
            file = chunk.split("\n")[0].split(" b/")[-1]
            changed = [line for line in chunk.split("\n")[1:] if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))]
            if file.startswith((".gitnexus/", ".claude/skills/gitnexus/")):
                tool_files.append(file)
            elif file.split("/")[-1] in ["AGENTS.md", "CLAUDE.md"] and any("gitnexus" in line.lower() for line in changed):
                tool_files.append(file)
        if tool_files:
            text = (
                f"The diff changes what GitNexus writes by itself when it builds its index: {', '.join(tool_files)}. That isn't "
                f"your fix and must not be in the PR: restore them (git checkout {args['base']} -- <file>; git clean for new "
                "files), keep them out of your commits (take them out of a commit that has them), check git status, then try again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # Finished means the project's tests pass with the change, on exactly this code (the main branch is trusted),
        # unless the user skipped the checks (Skip checks: backend/agents_api.py).
        after = job["tests"]["after"]
        if not job["skip_checks"] and (after is None or not after["passed"]):
            text = "No PR until the tests pass with your change: run_tests with when: after."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if not job["skip_checks"] and after["diff_hash"] != hashlib.sha256(diff.encode()).hexdigest():
            text = (
                "The code changed since the tests last passed (or the test run left new files behind: add those to "
                ".git/info/exclude). Run run_tests with when: after again on the code as it is now, then draft."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The commit the diff starts from, as it is now: sending the PR builds it on that commit (github_account.py),
        # wherever the base moves later.
        try:
            result = await asyncio.to_thread(vm.exec, f"cd {folder} && git rev-parse --verify {base}^{{commit}}", 60)
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
            if not rebase and newest != base_sha:
                text = (
                    f"base must be {pr}'s newest commit, {newest}, and {args['base']} is {base_sha}. Fetch its branch again, put "
                    "your work on top of that commit, run the tests again (when: after, base that commit), then draft. If you "
                    "rebased it or rewrote its commits, draft with rebase: true and base the commit your branch starts from."
                )
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            if rebase and newest == base_sha:
                text = f"{args['base']} is {pr}'s newest commit, so your commits go on top of it: that is a new version, not a rebase. Leave rebase out."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
        # What a rebase replaces: the PR's newest commit now. Sending refuses once the branch is anywhere else.
        rebase_of = None
        if rebase:
            rebase_of = newest

        # Every commit goes out with the user's GitHub name and noreply address (github_account.py), so it is made with
        # that identity in the VM too: never the user's own email, which agents see in their context (openmed's reviewer
        # sent a draft back for it), nor a made-up one ("OpenMed contributor <contributor@users.noreply.github.com>").
        account = self.agents.your_repositories.github_account.load()
        noreply = ""
        if account is not None:
            noreply = f"{account['id']}+{account['login']}@users.noreply.github.com"
        # Every commit must be the agent's own, by the VM's git address: never someone else's fix cherry-picked in, and no
        # co-authors (the user's rule). The first line printed is that address, possibly empty; the second how many
        # Co-authored-by lines the commit messages have; then each commit.
        command = (
            f"cd {folder} && echo \"$(git config user.email)\" && echo \"$(git log --format=%B {base}..HEAD | grep -ci '^co-authored-by:')\" && "
            f"git log --format=%ae%x1f%an%x1f%h%x1f%s {base}..HEAD"
        )
        try:
            result = await asyncio.to_thread(vm.exec, command, 60)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not reach the VM: {error}"}], "is_error": True}
        if result.returncode != 0:
            return {"content": [{"type": "text", "text": f"Could not read your branch's commits: {result.stderr.strip()}"}], "is_error": True}
        vm_email = result.stdout.split("\n")[0].strip()
        if noreply != "" and vm_email != noreply:
            text = (
                f"Your git address in {args['path']} is {vm_email or 'not set'}, but commits are made as the user, with their "
                f"GitHub name and noreply address: `git config user.name \"{account['name']}\" && git config user.email "
                f"\"{noreply}\"` there (and --global for your next repos). Then make your branch's commits with it: `git rebase "
                f"--exec 'git commit --amend --no-edit --reset-author' {args['base']}`, and draft again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if result.stdout.split("\n")[1:2] != ["0"]:
            text = "A commit message on your branch has a Co-authored-by line. Credit no co-author: reword it (git commit --amend or a rebase), then draft again."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # A rebase keeps the PR's own commits, which went out as the user's (their name and GitHub noreply address):
        # those are the user's too. Anyone else's still can't go out.
        own_emails = [vm_email]
        if rebase and noreply != "":
            own_emails.append(noreply)
        others = []
        for line in result.stdout.strip().split("\n")[2:]:
            fields = line.split("\x1f", 3)
            if len(fields) == 4 and fields[0] not in own_emails:
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
            result = await asyncio.to_thread(vm.exec, command, 120)
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
                    # The agent's own (by the VM's git address), as every one is now, or in a rebase the PR's own
                    # commits, the user's: they go out with the user's name.
                    "own": fields[3] in own_emails,
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

        # The Workflow tab: a pull request of the repository, for its review agent (backend/workflow_api.py hands it over).
        # Opened on GitHub at once when the repository's pull requests are there.
        if workflow is not None:
            issue_number = None
            for issue in workflow["issues"].values():
                if issue["job"] == job["id"]:
                    issue_number = issue["number"]
            files = []
            for chunk in ("\n" + diff).split("\ndiff --git ")[1:]:
                lines = chunk.split("\n")
                added = len([line for line in lines[1:] if line.startswith("+") and not line.startswith("+++")])
                removed = len([line for line in lines[1:] if line.startswith("-") and not line.startswith("---")])
                files.append({"path": lines[0].split(" b/")[-1], "added": added, "removed": removed})
            area = ""
            match = re.match(r"[a-z]+\(([^)]+)\)", args["title"].strip())
            if match is not None:
                area = match.group(1)
            fields = {
                "title": args["title"].strip(),
                "by": self.agent_id,
                "issue": issue_number,
                "job": job["id"],
                "agent": self.agent_id,
                "area": area,
                "files": files,
                "added": sum(item["added"] for item in files),
                "removed": sum(item["removed"] for item in files),
            }
            parts = {
                "body": args["body"],
                "overview": overview,
                "diff": diff,
                "commits": commits,
                "base": args["base"].strip(),
                "base_sha": base_sha,
                "branch": branch,
                "path": path,
                "vm": vm_name,
                "evidence": job["evidence"],
                "tests": job["tests"],
            }
            try:
                made = await asyncio.to_thread(self.agents.workflow.add_pr, repo, fields, parts)
            except (ValueError, KeyError, httpx.HTTPError) as error:
                return {"content": [{"type": "text", "text": f"Could not make the pull request: {error}"}], "is_error": True}
            fields = {"status": "waiting_on_user"}
            if "draft" in job["steps"]:
                fields["step"] = "draft"
            self.agents.jobs.update(job["id"], **fields)
            self.agents.workflow.wake()
            where = f"#{made['number']}"
            if made["url"] is not None:
                where = f"#{made['number']} on GitHub ({made['url']})"
            text = (
                f"Pull request {where} is made: {len(files)} files, +{made['added']} -{made['removed']}. The review agent reviews "
                "it next; then it waits for the decision, and you hear it: merged (your job is done) or rejected, with why (make it "
                f"again). {job['id']} waits meanwhile; move on to your next job (release_vm if none is left for {vm_name})."
            )
            return {"content": [{"type": "text", "text": text}]}

        target = job["issue"]
        if pr is not None:
            target = pr
        # Every PR draft goes to a reviewer first, and reaches the Inbox only when the review passes (Agents.give_review). A
        # project's one made again on the new main replaces the PR its job is about (Agents.redo_pr).
        review = {"state": "waiting", "agent": None, "job": None, "notes": "", "at": datetime.now(UTC).isoformat()}
        if project is not None:
            replaces = job["thread"]
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
            review=review,
            replaces=replaces,
            rebase_of=rebase_of,
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
        if rebase:
            what = f"a rebase of {pr} on {base_sha[:10]}, replacing its commits when it is sent"
        # The user skipped the checks: no reviewer, it is in their Inbox at once.
        if job["skip_checks"]:
            notes = "You skipped the checks, so nobody reviewed it, and its tests may not have passed."
            self.agents.inbox.set_review(draft["id"], {"state": "passed", "agent": None, "job": None, "notes": notes, "at": datetime.now(UTC).isoformat()})
            text = (
                f"{draft['id']} is in the user's Inbox now: {files} files, +{added} -{removed}, {what}. They skipped the checks, "
                f"so no reviewer looks at it first. Nothing was pushed or sent: it waits for their Approve. {job['id']} waits "
                "meanwhile."
            )
            return {"content": [{"type": "text", "text": text}]}
        self.agents.give_review(draft, desktop)
        text = (
            f"{draft['id']} goes to {repo}'s reviewer first: {files} files, +{added} -{removed}, {what}, with "
            f"{len(job['evidence'])} pieces of evidence. When the review passes it reaches the user's Inbox; when the reviewer "
            f"asks for changes you get a message with them. Nothing was pushed or sent. {job['id']} waits meanwhile; move on "
            f"to your next job (release_vm if none is left for {vm_name})."
        )
        if project is None:
            text = (
                f"{draft['id']} goes to {repo}'s reviewer first: {files} files, +{added} -{removed}, {what}, with "
                f"{len(job['evidence'])} pieces of evidence. It checks the draft in {path} on desktop {desktop} of {vm_name}, so "
                "leave that folder as it is until you hear back. When the review passes it reaches the user's Inbox; when the "
                f"reviewer asks for changes you get a message with them. Nothing was pushed or sent. {job['id']} waits meanwhile; "
                f"release_vm now unless you have other jobs for {vm_name}: the reviewer needs this desktop."
            )
        not_done = [point["item"] for point in checklist if not point["done"]]
        if not_done:
            text += f" Not done, as your checklist says (the user sees these first): {'; '.join(not_done)}."
        text += left_out
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
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)

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
            computer = Computer(vm, tag)
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
                result = await asyncio.to_thread(vm.exec, command, 60, None, tag)
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
                result = await asyncio.to_thread(vm.exec, capped, 600, None, tag)
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
        if vm_record.holding(self.agent_id) != desktop:
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
        if job["repo"] is not None and job["repo"].lower() not in self.guides_read and self.agents.projects.get(job["repo"]) is None and self.agents.workflow.get(job["repo"]) is None:
            text = f"First read {job['repo']}'s rules for contributors (contributing_guide): they say which checks to run before a PR, and how."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            text = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        # The desktop it holds: commands run as its user, in its home folder.
        vm = vm_record.desktop_vm(desktop)

        # The diff is read with the tag of the agent's VM tools (ComputerTools), so losing the VM stops that. The suite
        # itself is a run (long_runs.py) with a tag of its own: it goes on when the agent loses the VM.
        tag = f"sandbox-agent-{self.agent_id}"
        # Commands run in the user's home, so ~/click and click are the same folder.
        folder = shlex.quote(args["path"].strip().removeprefix("~/"))
        base = shlex.quote(args["base"].strip())

        # The code the suite runs on: its diff from base, read exactly the way draft_pr reads it, so the two can be compared.
        diff_command = f"set -o pipefail; cd {folder} && git add -A -N . && git diff {base} | head -c {DIFF_LIMIT + 1}"
        try:
            result = await asyncio.to_thread(vm.exec, diff_command, 120, None, tag)
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
            for value in sorted(list(vm_record.global_env.values()) + list(vm_record.env.values()), key=len, reverse=True):
                if len(value) >= HIDE_MIN_LENGTH:
                    text = text.replace(value, "[hidden]")
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if when == "before" and diff.strip():
            text = (
                f"when: before is for the unchanged code, but {args['path']} differs from {args['base']}: `git stash -u`, run it, "
                "then `git stash pop`."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if when == "after" and not diff.strip():
            text = f"{args['path']} doesn't differ from {args['base']} yet: there is no change to test."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # The step it is on shows in the user's progress view while the suite runs. A run on the unchanged code (the last
        # resort) leaves the step as it is.
        fields = {}
        if when == "after" and "test" in job["steps"]:
            fields["step"] = "test"
        if job["status"] == "queued":
            fields["status"] = "working"
        if fields:
            self.agents.jobs.update(job["id"], **fields)

        # The user follows the run live in a terminal window on the VM's desktop (long_runs.py). The newline in the label
        # would break the VM page's one line.
        label = f"{TESTS_TOPICS[scope].capitalize()}, {'before the change' if when == 'before' else 'with the change'}: {command}"
        try:
            run = await asyncio.to_thread(long_runs.start, vm_record, self.agent_id, desktop, "tests", command, label.replace("\n", " ")[:300], folder)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not start the tests: {error}"}], "is_error": True}
        # What finish_tests needs to keep the result, also after a backend restart.
        run["job"] = job["id"]
        run["when"] = when
        run["scope"] = scope
        run["command"] = command
        run["base"] = args["base"].strip()
        run["path"] = args["path"].strip()
        run["diff_hash"] = hashlib.sha256(diff.encode()).hexdigest()
        self.agents.queue.add_run(vm_name, run)

        later = (
            f"you get the result in a message when it ends, and it is kept on {job['id']} then. Leave {args['path']} alone "
            f"until then: the tests run on what is in it. If you have more to do in {vm_name}, do it; otherwise end your turn: "
            "you keep your desktop meanwhile."
        )
        if args.get("background"):
            return {"content": [{"type": "text", "text": f"Started the tests in the background as {run['id']}: " + later}]}
        ended = await long_runs.wait(vm_record, run, long_runs.FOREGROUND_SECONDS)
        if ended is None or not self.agents.queue.claim_run(run["id"]):
            text = f"Still running after {long_runs.FOREGROUND_SECONDS // 60} minutes, so the tests go on in the background as {run['id']}: " + later
            return {"content": [{"type": "text", "text": text}]}
        answer = await self.finish_tests(vm_record, run, ended)
        try:
            self.agents.queue.finish_run(vm_name, run["id"])
        except VMsError:
            # The VM was deleted meanwhile; its runs went with it.
            pass
        return answer

    async def finish_tests(self, vm_record, run: dict, ended: dict) -> dict:
        """Keep a test run that ended (long_runs.check's result) on its job, as its before or after and as evidence, and
        say what's next. Also for a run in the background, which agents.py collects: the agent may not hold the VM then."""
        when = run["when"]
        scope = run["scope"]
        command = run["command"]
        if ended["ended"] == "gone":
            # Why, as far as the VM shows it (long_runs.check): a restart, a full disk, or its processes killed.
            why = "the user stopped it" if run["stopped_by_user"] else ended["why"]
            if run.get("stopped_by_agent"):
                why = "you stopped it"
            text = f"The test run ended without finishing ({why}), so it doesn't count. Run it again."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            job = self.agents.jobs.get(run["job"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"{run['job']} is gone, so the run wasn't kept."}], "is_error": True}
        if job["status"] in CLOSED_STATUSES:
            text = f"{job['id']} is {job['status']} now (the user may have cancelled it): the run wasn't kept. Move on."
            return {"content": [{"type": "text", "text": text}], "is_error": True}

        # An after run counts only for the code it started on (draft_pr checks the drafted code against that), so that
        # code must still be there: it may have changed while the tests ran.
        if when == "after":
            folder = shlex.quote(run["path"].removeprefix("~/"))
            diff_command = f"set -o pipefail; cd {folder} && git add -A -N . && git diff {shlex.quote(run['base'])} | head -c {DIFF_LIMIT + 1}"
            try:
                # As the user of the desktop the run is on (runs from before desktops were on desktop 1).
                result = await asyncio.to_thread(vm_record.desktop_vm(run.get("desktop", 1)).exec, diff_command, 120)
            except Exception as error:
                text = f"Could not reach the VM to check the code the tests ran on ({error}), so the run doesn't count. Run it again."
                return {"content": [{"type": "text", "text": text}], "is_error": True}
            if hashlib.sha256(result.stdout.encode()).hexdigest() != run["diff_hash"]:
                text = f"{run['path']} changed while the tests ran, so the run doesn't count. Run them again, and leave the folder alone until they end."
                return {"content": [{"type": "text", "text": text}], "is_error": True}

        exit_code = ended["exit_code"]
        output = ended["output"][-OUTPUT_LIMIT:]
        seconds = ended["seconds"]
        for value in sorted(list(vm_record.global_env.values()) + list(vm_record.env.values()), key=len, reverse=True):
            if len(value) >= HIDE_MIN_LENGTH:
                output = output.replace(value, "[hidden]")
                command = command.replace(value, "[hidden]")
        passed = exit_code == 0
        if ended["ended"] == "timeout":
            output = f"Stopped after {TEST_TIMEOUT // 60} minutes.\n{output}"

        # The output goes to the user as evidence: this run's before or after of the suite.
        minutes = f"{seconds // 60}m {seconds % 60}s" if seconds >= 60 else f"{seconds}s"
        tests = "the tests that cover the change" if scope == "focused" else "the project's official checks"
        caption = f"{'Passed' if passed else 'Failed'}: {tests} {'on the code as it was' if when == 'before' else 'with the change'}, in {minutes}"
        if ended["ended"] == "timeout":
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

        tests_run = {
            "command": command,
            "scope": scope,
            "base": run["base"],
            "exit_code": exit_code,
            "passed": passed,
            "diff_hash": run["diff_hash"] if when == "after" else "",
            "evidence": evidence_id,
            "seconds": seconds,
            "at": datetime.now(UTC).isoformat(),
        }
        tests = {"before": job["tests"]["before"], "after": job["tests"]["after"]}
        tests[when] = tests_run
        self.agents.jobs.update(job["id"], tests=tests)
        # On the job's timeline in plain words, with the counts when the output ends with them ("12 passed", "2 failed":
        # pytest, jest, cargo and the like).
        said = caption
        counts = []
        found_passed = re.findall(r"\b(\d+) passed\b", output)
        found_failed = re.findall(r"\b(\d+) failed\b", output)
        if found_passed:
            counts.append(f"{found_passed[-1]} passed")
        if found_failed:
            counts.append(f"{found_failed[-1]} failed")
        if counts:
            said += f" ({', '.join(counts)})"
        self.agents.jobs.add_timeline(job["id"], "tests", said)

        if when == "before" and passed:
            advice = (
                "It passes on the unchanged code: what fails with your change is your change's doing. Fix it, then run_tests "
                "with when: after again."
            )
        elif when == "before":
            advice = (
                "It fails on the unchanged code too. Compare which tests fail here with the after run: the ones failing here as "
                "well aren't your change's doing (check your setup first: dependencies, services, settings the project's docs or "
                "CI ask for). Ask the user with draft_question about leaving out exactly those, and wait for the decision."
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
            desktops = []
            for number, line in vm_record.desktops.items():
                holder = line["holder"]
                if holder == self.agent_id:
                    holder = "you"
                if holder is not None and holder not in ["user", "you"]:
                    holder = names.get(holder, holder)
                desktops.append({"desktop": number, "holder": holder})
            notes = []
            for note in vm_record.notes:
                by = names.get(note["by"], note["by"])
                if note["by"] == self.agent_id:
                    by = "you"
                entry = {"id": note["id"], "text": note["text"], "by": by, "at": note["at"][:16]}
                if "desktop" in note:
                    entry["desktop"] = note["desktop"]
                notes.append(entry)
            disk_used_gb = vm_record.usage["disk_used_gb"]
            entry = {
                "name": vm_record.name,
                "status": vm_record.status,
                "cpus": vm_record.cpus,
                "memory_gb": vm_record.memory_gb,
                "disk_gb": vm_record.disk_gb,
                "disk_used_gb": round(disk_used_gb, 1) if disk_used_gb is not None else None,
                "full": self.agents.queue.full.get(vm_record.name),
                "internet": vm_record.internet,
                "desktops": desktops,
                "max_desktops": vm_record.max_desktops,
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
        # A desktop it asked for that was taken away (its notes may still name it): another one, with the project set up
        # there again. Not one the app took back from it in a full VM: it waits in line for that one.
        wanted = args.get("desktop") or None
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError:
            text = f"{vm_name} is gone. Pick another VM with vms_list and choose_vm, then queue again."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if wanted is not None and wanted not in vm_record.desktops and self.agent_id not in vm_record.queue:
            numbers = ", ".join(str(number) for number in vm_record.desktops)
            text = (
                f"{vm_name} has no desktop {wanted} anymore (its desktops are {numbers}): it was taken away, with what was set "
                "up on it. Queue for another desktop, or leave desktop out for the first free one (desktop_add when all are "
                "taken), and set your project up there again."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            place = self.agents.queue.join(vm_name, self.agent_id, wanted)
            vm_record = self.agents.vms.get(vm_name)
        except (ValueError, VMsError) as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        desktop = vm_record.desktop_of(self.agent_id)

        # Something on an open PR of the user's needs acting on (a follow_up job: a comment, a review, failing checks, a
        # conflict): it goes before new work, to the front of the line.
        following = [job for job in self.agents.jobs.for_agent(self.agent_id) if job["kind"] == "follow_up" and job["status"] in ["queued", "working"]]
        if place > 1 and following:
            try:
                self.agents.queue.move_to_front(vm_name, self.agent_id)
                place = 1
            except ValueError:
                pass
        if place > 0:
            which = f"desktop {desktop}" if desktop is not None else "the first desktop that frees up"
            text = f"You are number {place} in {vm_name}'s queue, for {which}. End your turn; you'll get a message when it's yours."
            if vm_name in self.agents.queue.full:
                text += f" {vm_name} is full right now ({self.agents.queue.full.get(vm_name)}): nobody new gets a desktop until there is room."
            if following:
                text += " You are at the front: a follow-up on an open PR goes before new work."
            return {"content": [{"type": "text", "text": text}]}
        jobs = [job for job in self.agents.jobs.for_agent(self.agent_id) if job["status"] in OPEN_STATUSES and job["vm"] == vm_name]
        titles = ", ".join(f"{job['id']} ({job['title']})" for job in jobs) or "none"
        text = f"Desktop {desktop} of {vm_name} is yours now. Your open jobs for it: {titles}. Do them all, then release_vm."
        if vm_record.status != "running":
            text += f" {vm_name} is {vm_record.status}: start it with vm_start."
        # Its notes come with it, so the agent always knows what earlier agents left in it.
        if vm_record.notes:
            agent_names = {}
            for agent in self.agents.agents.values():
                agent_names[agent.id] = agent.name
            text += "\nIts notes (check what is really there before you rely on them):"
            for note in vm_record.notes:
                on = f", on desktop {note['desktop']}" if "desktop" in note else ""
                text += f"\n- {note['id']} by {agent_names.get(note['by'], note['by'])}, {note['at'][:10]}{on}: {note['text']}"
        else:
            text += "\nIt has no notes yet: nobody wrote down what is set up in it."
        return {"content": [{"type": "text", "text": text}]}

    async def desktop_add(self, args: dict) -> dict:
        vm_name = self.record["target_vm"]
        if vm_name is None:
            text = "You have no target VM. Pick the VM that suits your jobs with vms_list and choose_vm first."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        if vm_name in self.agents.queue.full:
            text = (
                f"{vm_name} is full right now ({self.agents.queue.full.get(vm_name)}): no desktop is added until there is room. "
                "queue_for_vm and end your turn: you get a message when a desktop is yours."
            )
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
            number = await asyncio.to_thread(vm_record.add_desktop, self.agents.queue.lock)
            # The new desktop goes to the agents waiting, maybe this one.
            await asyncio.to_thread(self.agents.queue.fill, vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        holder = vm_record.desktops[number]["holder"]
        if holder == self.agent_id:
            text = f"{vm_name} has desktop {number} now, and it is yours: you get a message with your jobs for it."
        elif holder is not None:
            text = f"{vm_name} has desktop {number} now; the agent first in its queue got it. queue_for_vm for a desktop of your own."
        else:
            text = f"{vm_name} has desktop {number} now, and it is free: queue_for_vm to take it."
        return {"content": [{"type": "text", "text": text}]}

    async def vm_note_add(self, args: dict) -> dict:
        vm_name, place = self.agents.queue.place(self.agent_id)
        if place != 0:
            return {"content": [{"type": "text", "text": "You don't hold a VM. Notes go on the VM you hold."}], "is_error": True}
        if EMOJI.search(args["text"]):
            return {"content": [{"type": "text", "text": NO_EMOJI + ", ".join(EMOJI.findall(args["text"]))}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
            note = await asyncio.to_thread(vm_record.add_note, args["text"], self.agent_id, vm_record.holding(self.agent_id))
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
            desktop = vm_record.desktop_of(self.agent_id)
            if desktop is not None:
                status["you"] += f", desktop {desktop}"
            status["vm_status"] = vm_record.status
            status["desktops"] = [
                {"desktop": number, "holder": line["holder"]}
                for number, line in vm_record.desktops.items()
            ]
            status["queue"] = list(vm_record.queue)
            status["asked_for"] = dict(vm_record.wants)
            # The long runs going in it (yours and other agents'): leave their folders alone.
            status["runs"] = [
                {"id": run["id"], "by": run["agent"], "desktop": run.get("desktop", 1), "what": run["label"], "started_at": run["started_at"][:16]}
                for run in vm_record.runs
            ]
        return {"content": [{"type": "text", "text": json.dumps(status)}]}
