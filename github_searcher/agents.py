"""All agents: their worker loops, and the rules that tie them to jobs, the VM queue and the Inbox.

Each agent (agent/agent.py) is one Claude conversation with a record on disk,
DATA_DIR/agents/<id>.json:

    {"id": "agent_a1b2c3", "name": "agent-1", "target_vm": "vm1" | null, "claude_session_id",
     "history": [HistoryEntry, ...], "context_used", "context_max", "cost_usd", "compactions", "tokens_used", "created_at",
     "pending": [message, ...], "awake": bool, "archived_at": null | when it was archived,
     "name_by": "auto" | "user" | "agent", "priority": bool}

name_by says who gave the name. Every agent is called "agent-N", the first free number (auto): agents don't name
themselves, and the app gives its own agents (reviewers, workers, chat agents) no names either. Only the user renames
one (user). Agents from before that were named for their work got the next free number once, by age (numbered).

Any agent can be archived: it stops, its open jobs are cancelled and it leaves every VM queue, but its
conversation stays, so it can pick up where it left off (an update on its PR). The app's messages to an
archived agent wait without waking it; a message from the user, a job given to it, or a reply to one of
its drafts brings it back (unarchive), and those messages go in then. An agent that made PRs (a PR draft
that waits for the user or was approved: Inbox.pr_owners) can't be deleted, only archived.

Every agent has a worker (an asyncio task) that waits for messages, joins the waiting ones into
one prompt, each starting with [User] (the user typed it) or [System] (the app: a new job, a VM
that is its turn now, the user's decision on a draft, a reminder), and runs one turn with them.
A message sent while the agent works waits in a queue (the chat shows it as pending; MAX_QUEUED of
the user's at most). Each of the user's messages gets a turn of its own, in order, together with the
app's messages that came before it; interrupting a turn (Esc in the chat) starts the next one. The user can take
one of their queued messages out before it goes in (cancel_queued); the agent list carries their texts (queued).
A message from the user while the agent is in the middle of a job (status working) is not a stop: its turn's prompt
also says to answer, take it in, and carry on with the job in that same turn, unless the user said to stop or change
course. Only interrupting with nothing queued stops the agent until the user writes again.
When the user fills in empty env variables an agent added for a secret (env_var_add), that agent is told
(secrets_filled, from the env endpoints in backend/vms_api.py), so it never asks for them in the Inbox.
Waiting messages are saved with the record, so a backend restart (it reloads on every code
change) doesn't lose them. An agent with messages waiting is woken with them after the restart (not an archived one);
one cut off in the middle of a turn gets one more saying so.

After each turn the worker enforces the VM rule: an agent never holds a VM it has nothing to do in.
- Holding a VM with no queued or working job for it: the VM is released for it. Unless a job there waits only on a short
  timed question (a timer of QUESTION_HOLD_SECONDS at most): then it keeps its desktop and sleeps, and the answer (the
  user's, or the timer's pick) wakes it, so it doesn't wait in the VM's line again for minutes of asking.
- Holding one while its run goes there (a test suite or build it left going, sandbox/agent/long_runs.py): it keeps
  its desktop and sleeps; watch_runs wakes it when the run ends. An agent never gives up its desktop while it has work
  there: nobody steps aside. Only the user (Take over, Give, Remove) or a full VM (watch_room, below) takes it.
- Holding one with open jobs there: it is reminded to go on with them now, not to wait for an answer in chat. After
  MAX_NUDGES reminders in a row with no change to its jobs, the reminders stop; it keeps the desktop.
- In no queue but with queued jobs for a VM: it is reminded to queue_for_vm (MAX_NUDGES times at most).
An agent with open work never just stops: every HEARTBEAT_CHECK_SECONDS (keep_going), one with a job queued or working
that has been out of its turn for HEARTBEAT_SECONDS is told to carry on, whatever ended it (a turn that failed,
reminders that ran out, a VM released for it, a backend restart, a blocker it reported). Only a real wait is left alone:
its place in a VM's line (the grant wakes it), a run of its going (watch_runs wakes it), the user (waiting_on_user, a
draft of the job still waiting with its reviewer or in the Inbox whatever the job's status says, or the user stopped it),
or being archived. How long it has been out: since the newest entry in its history with a time
(its turn's end, an error, a message), so restarts don't put it off.
A VM steps down when it runs out of room (watch_room, every ROOM_CHECK_SECONDS, from the VM's load, free memory and free
disk). Full (the load of the last minute at its number of CPUs or more, less than ROOM_MEMORY_PERCENT of its memory free,
or less than ROOM_DISK_GB of its disk free), it takes nobody new (VMQueue.full, with why): agents wait in its line instead
of getting a free desktop or adding one, and are told why. When its disk runs low, the agents holding its desktops are
told once to free what they can in their own homes (the folders of jobs that are over, caches); nobody else can.
Overloaded (the load of the last 5 minutes at OVERLOAD_TIMES its CPUs, or less than OVERLOAD_MEMORY_PERCENT free), it
also takes one desktop back from its agent, at most every STEP_DOWN_SECONDS, and removes that desktop
(VMQueue.step_down): the agent goes to the front of the line asking for it (behind the work that goes first, below),
and nothing it runs is stopped (its runs, servers and files stay). Never an agent the user gave priority; one on a pull
request that needs action only when nobody else is left, one reviewing a PR draft only when nobody else but those is;
one out of its turn first, then the highest desktop.
With room again, whoever waits gets a free desktop, or the desktop they wait for is added back (one that was taken
back, or a new one for an agent that asked for none), one a check, up to the VM's max desktops.
The VM queue (sandbox/vm_queue.py: one line per desktop of each VM, and agents on different desktops work at
the same time) tells Agents when an agent's turn comes (on_grant: a message
that wakes it, with the user's GitHub name and noreply address to commit with, then the VM's notes on what earlier agents
set up in it for its jobs' repos and the whole VM (the other repos only by name, however many notes the VM has), or the VM
passes on at once
if it has no open jobs there anymore) and when the
user took the VM or its place away (on_kick: it is interrupted, and what it still ran in that
VM is killed, except its runs).

Runs nobody waits for anymore (the agent's turn ended, or the backend restarted) are checked every
RUN_CHECK_SECONDS (watch_runs). When one ends, its agent gets the result (bash: ComputerTools.bash_result; tests:
WorkTools.finish_tests, which keeps it on the job). An agent waiting in that VM's line (its desktop was taken back)
gets it together with the message that a desktop is its again; any other agent right away. Archiving or deleting an agent stops its runs.

The user's side: assign() turns an issue into a job for an agent, set_up_repo() a repo from the
Repos list (its Set up button) into a set_up_repo job: the agent reads the README and docs, sets an
app with a clear frontend up and leaves it running on the VM's desktop (a server in the VM's demo
service, so it outlives the agent's turn and VM restarts), or clones a library or other low-level
repo and opens it in VS Code there, then writes a short introduction to the repo in its chat and
the job's notes. reproduce_paper() turns a paper the user added on the Workspace tab's Papers page (a PDF, kept in the
agent's artifacts under papers/) into a reproduce_paper job: the agent reads it, rebuilds it in the VM, compares the
numbers, checks the claims and drafts a report (draft_report). decide() passes the user's decision on a draft back to its agent (with the link,
when Approve sent it to GitHub, or pushed a new version onto the user's PR). When the user edited the draft
before deciding, the agent also gets the final text, so it learns how they want it written.
A timed question (inbox.py: options, a recommended one and answer_by) that the user hasn't answered by its answer_by
is answered with the agent's recommendation: answer_questions() looks every QUESTION_CHECK_SECONDS and decides it as a
reply ("I pick: ..."), answered_by "timer", and the agent hears that the user didn't answer in time.

The GitHub tab's side: follow_up() is called when someone else wrote on a PR or issue of the user's that an
agent follows (agent mode Drafts), or the PR's checks failed (pr_tracking.needs_reply). The agent gets a
follow_up job for that thread (an open one it has for it hears the news instead; an open job whose next version of
that PR waits hears it, whoever's it is, so only one agent works on a PR at a time), and an archived agent comes
back for it. It reads the thread and suggests a reply (draft_comment), a new version of the user's own PR made
on that PR's branch (draft_pr with pr: Approve pushes it there and posts its text on the PR as a comment), or
nothing (it marks the job done). It never posts anything itself. It answers only the project's maintainers and the
PR's reviewers (anyone else, a bot too, only when the merge needs it), in one comment of ours per round
(agent/work_tools.py).

A repository's agent (the Workspace tab's Live, frontend/src/RepoLive.tsx) belongs to one of the user's own
repositories for good: its record's "repo" is that repo, and "live" how far its set-up is:

    "repo": "owner/name" | None, "live": {"state": "preparing" | "ready" | "failed", "error": why it failed | None} | None

set_up_live() makes it, aimed at the repo's own new VM (backend/repo_live_api.py makes the VM). prepare_live() then
waits for the VM, clones the repo here with the user's sign-in (your_repositories.clone) and copies it into desktop 1's
home, so the VM never gets a token, also for a private repo; then the agent gets a set_up_repo job for desktop 1, the
desktop the Live tab shows. A failure stays in "live" with why, and the Live tab's Try again runs it again
(retry_live). It reads its repo with its own tools (agent/repo_tools.py) and, when the user asks for a change, drafts
an issue (issue_drafts.py) instead of making it; issue_decided() tells it whether the user created or discarded it.

A project (github_searcher/projects.py: one of your repositories agents develop all the time, the Workspace tab repo
page's Development) has agents of its own. start_project() makes them: its chat agent (the repository's agent, made
with set_up_live when the repo has none: it sets the repo up on the project's VM), then project_agents() its workers
and reviewer (record "project": the repo, "role": "worker" | "reviewer"), as many workers as the project asks for, all
aimed at the project's VM. backend/projects_api.py runs the project: give_issue() hands a worker the next open issue as
a fix_issue job (it checks the issue and reproduces it first, and may deny it), give_review() hands the reviewer each PR
draft a worker makes (the draft reaches the Inbox only when review_finished() passes it; changes send it back),
redo_pr() asks a worker to make a PR that conflicts with main again on the new main, give_crashes() hands the chat
agent the app's errors (crashes.py) to turn into issues, and project_changed() tells it what the user changed (mode,
goals).

Every other repo's PR drafts are reviewed too, before they reach the Inbox: give_review() hands each to that repo's own
reviewer (record "role": "reviewer", "reviews": the repo, made the first time), which checks it the way the repo's
maintainers will, every point asked and the edge cases of its kind, on the author's desktop, so they don't find what
was missed one review round at a time.

When an issue an agent has a job for goes from free to assigned (someone else is on it now: the
tags say so, backend/issues_api.py), issue_taken() tells the agent who has it (the assignees' logins, or else the
tags' reason), once per job, and puts that on the job's timeline. When someone else's open pull request comes to be
tied to it (it says it closes it, or only mentions it: the tags' open_prs), the agent hears of it at once, once for
each, also when the issue stays free or the user's claim went out, and reads it to decide. The user isn't asked: the agent finds out who that is
(read_issue shows each person's role, search_issues their merged PRs there) and stops, cancelling its job with a note
on who took it, for a maintainer, a member or someone who often gets PRs merged there; for a new, unknown or bot-like
account it goes on. The Inbox's "taken" items from before that still decide as they did: Keep working tells the agent
to go on; Stop the agent cancels the job, and when the agent is busy with it right now, stops its turn and what it runs
in the VM.

Some repos ask contributors to claim an issue before they start: be assigned to it, often with a "/claim" comment.
There a fix_issue job's agent drafts that claim first (its one comment, WorkTools.draft_comment) and goes straight on
with the fix: neither the user's approval nor the maintainers' answer holds the job up (we assume nobody answers), so
the user finds the claim and the PR in the Inbox, to approve in that order. issue_taken() leaves the job alone when the
issue is assigned to the user (their claim went through); someone else assigned is taken, as for any job.

The user can give an agent priority (set_priority, the Give priority button on its page) until its tasks are over: no
open job, no run going and no turn (watch_runs then takes it back by itself). It joins a VM's waiting line ahead of
everyone without priority (VMQueue.prioritized), and in the VM its runs and the desktops it holds or runs on get ten
times the CPU share and its runs are ended last when memory runs out (long_runs.prioritize, set again by watch_runs
whenever that changes).

Agents work on the Issues board in its order: Needs action, then Review, then In progress and Catalog. The agents on a
pull request of the user's that needs action get priority like the user's (set_pr_priority); the agents reviewing a PR
draft (a review job queued or working, set_review_priority) come next in a VM's waiting line (VMQueue.reviewing), and
the rest after them. Both are worked out again by backend/github_api.py every few seconds.

Everything here runs in the backend's event loop. notify() and the queue callbacks may be called
from request threads, so they hand their work to the loop. version goes up on every change the
agent list shows (status, history, context, queue), for the live feed.

    agents = Agents(repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues, ..., artifacts, your_repositories, issue_drafts, projects, crashes)
    await agents.start()
    agents.send(agent_id, "find good first issues in Python CLI tools")
"""

import asyncio
import functools
import json
import os
import re
import secrets
import shlex
import tempfile
import threading
import traceback
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

from github_searcher import search
from github_searcher.agent.agent import AGENT_HOME, Agent
from github_searcher.agent.work_tools import QUESTION_HOLD_SECONDS, WorkTools
from sandbox.agent import long_runs
from sandbox.agent.tools import ComputerTools
from sandbox.file_transfer import to_vm
from sandbox.vms import VMsError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Reminders in a row, with no change to the agent's jobs or queue place, before the app stops reminding.
MAX_NUDGES = 2
# The user's messages that may wait for their turn at once.
MAX_QUEUED = 10
# Desktop 1's demo service (sandbox/image/base_layer.sh) runs DEMO_DIR/run.sh and keeps it running, also after a
# restart. Desktop n has its own, demo-<n> with /opt/demo-<n>/run.sh (sandbox/vm.py).
DEMO_DIR = os.environ["SANDBOX_VM_DEMO_DIR"]
# While an agent works, its record is saved this often (and after every turn).
SAVE_SECONDS = 5
# How often the runs nobody waits for are checked.
RUN_CHECK_SECONDS = 10
# The heartbeat: an agent with open work out of its turn this long, for no reason, is told to carry on; looked this often.
HEARTBEAT_SECONDS = 10 * 60
HEARTBEAT_CHECK_SECONDS = 60
# How often each running VM's load, free memory and free disk are read (watch_room). Full: the load of the last minute at
# its number of CPUs or more, less than ROOM_MEMORY_PERCENT of its memory free, or less than ROOM_DISK_GB of its disk free
# (a fresh clone and build of a big project, or a long test run's files, need about that). Overloaded: the load of the
# last 5 minutes at OVERLOAD_TIMES its CPUs or more, or less than OVERLOAD_MEMORY_PERCENT free; then a desktop is taken
# back from its agent, at most every STEP_DOWN_SECONDS, so the load has time to show it.
ROOM_CHECK_SECONDS = 60
ROOM_MEMORY_PERCENT = 20
ROOM_DISK_GB = 20
OVERLOAD_TIMES = 2
OVERLOAD_MEMORY_PERCENT = 10
STEP_DOWN_SECONDS = 15 * 60
# How often timed questions are checked for an answer_by that passed.
QUESTION_CHECK_SECONDS = 10
OPEN_STATUSES = ["queued", "working"]
# A repository's new VM is waited for this long (it takes about a minute), and looked at this often meanwhile.
LIVE_WAIT_SECONDS = 15 * 60
LIVE_CHECK_SECONDS = 5
# What an agent does when its job's issue was assigned to someone else (issue_taken): it decides itself,
# the user isn't asked.
TAKEN_ADVICE = (
    " Decide yourself whether to go on; the user isn't asked. Find out who that is: read_issue shows the assignees and "
    "each person's role (OWNER, MEMBER and COLLABORATOR are the project's own people; CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, "
    "NONE and BOT are not), and search_issues how often their PRs get merged there (`repo:{repo} is:pr is:merged "
    "author:LOGIN`). A maintainer, a member, or someone who often gets PRs merged there: stop. Cancel {job} with "
    "job_update (status cancelled) and a note in plain words on who took it and why you stopped, then go on with your "
    "other jobs. A new, unknown or bot-like account: keep going, and say why with job_progress. When it is someone else's "
    "open PR that closes it, stop whoever they are: close_issue with the PR's link, since nobody wants a second fix."
)
# What an agent does when someone else's open pull request came to be tied to its job's issue (issue_taken with prs: it
# says it closes it, or only mentions it): it reads it and decides, before any more long runs.
PR_ADVICE = (
    " This comes before everything else, also before a run of yours that is going: read_issue the issue and that pull "
    "request now. When it is a fix for this issue (it says it closes it, or makes the same change), someone else is on it: "
    "stop {job} whoever they are (run_stop what you run for it, then close_issue with the PR's link), since nobody wants "
    "a second fix. When it only mentions the issue for something else, keep going, and say why with job_progress."
)
# The same news about an issue we opened ourselves (as the user): we never give one of those up.
OURS_ADVICE = (
    " It is an issue we opened ourselves, as the user, and we never give one of those up: keep going with {job} whoever "
    "it is, and say so with job_progress. Don't cancel it or close the issue."
)


class Agents:
    def __init__(self, repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues, repo_signals, issue_tags, explore, artifacts, your_repositories, issue_drafts, projects, crashes):
        self.repos = repos
        # Your repositories agents develop all the time (projects.py), and the app's own errors (crashes.py): a turn
        # that fails with an exception is one.
        self.projects = projects
        self.crashes = crashes
        # The Workflow tab's repositories (workflow.py): backend/shared.py puts it here once both are made.
        self.workflow = None
        # What went wrong in how the app made agents work, as they report it (problems.py): backend/shared.py puts it here.
        self.problems = None
        # The user's repositories, read with their sign-in: a repository's agent reads its repo and gets its code through it.
        self.your_repositories = your_repositories
        # The issues repository agents drafted for the user (issue_drafts.py).
        self.issue_drafts = issue_drafts
        # Each agent's own folder (github_searcher/artifacts.py). A change in one shows in the agent list (artifacts_stamp).
        self.artifacts = artifacts
        artifacts.on_change = self.changed
        self.issues = issues
        # The Tracked list (a RepoList) and what each tracked repo's last check found on GitHub.
        self.tracked = tracked
        self.tracked_issues = tracked_issues
        # Each repo's signals (check_activity works them out the same way) and each issue's tags: free or assigned,
        # merge, kind.
        self.repo_signals = repo_signals
        self.issue_tags = issue_tags
        # Explore, for its profile's types of repo: the tags agents give the repos they add.
        self.explore = explore
        self.jobs = jobs
        self.inbox = inbox
        self.vms = vms
        self.queue = queue
        self.folder = DATA_DIR / "agents"
        self.version = 0
        self.agents: dict[str, Agent] = {}
        # Messages for each agent's next turn: {"from": "User" | "System", "text", "shown"}.
        # shown: already in the history (a kick), so it isn't added again when it is sent.
        self.pending: dict[str, list] = {}
        self.wake: dict[str, asyncio.Event] = {}
        self.workers: dict[str, asyncio.Task] = {}
        # VM rule reminders in a row: {"count", "state"}; state is what the jobs and queue place
        # looked like, and a change in it starts the count again.
        self.nudges: dict[str, dict] = {}
        # What long_runs.prioritize last set in each running VM (its runs and desktops, each with or without priority),
        # so it runs again only when that changed. Not saved: after a restart it is set once more.
        self.priority_set: dict[str, list] = {}
        # The agents with priority because they work on a pull request of the user's that needs action (set_pr_priority).
        # Not saved: the backend works it out again a moment after a restart.
        self.pr_priority: set[str] = set()
        # The running VMs whose disk is low (watch_room), whose holders were told to free room. Not saved: after a restart
        # they are told once more.
        self.disk_low: set[str] = set()
        self.loop = None
        self.loop_thread = None
        self.saver = None
        self.run_watcher = None
        self.question_timer = None
        self.heartbeat = None
        self.room_watcher = None
        queue.on_grant = self.on_grant
        queue.on_kick = self.on_kick
        # Every place in a queue shows in the agent list.
        queue.on_change = self.changed

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.loop_thread = threading.get_ident()
        self.folder.mkdir(parents=True, exist_ok=True)
        # "*.json" leaves out a "*.json.tmp" a crash may have left behind.
        for path in sorted(self.folder.glob("*.json")):
            record = json.loads(path.read_text())
            # Agents from before compactions and tokens were counted: the compactions from the history, the tokens from
            # Claude Code's own file of the conversation it has now (each reply once: its blocks come in lines of their
            # own, each with the reply's usage).
            if "compactions" not in record:
                record["compactions"] = len([entry for entry in record["history"] if entry["type"] == "system" and entry["text"] == "Context compacted"])
            if "tokens_used" not in record:
                transcript = Path.home() / ".claude" / "projects" / re.sub(r"[^a-zA-Z0-9]", "-", str(AGENT_HOME)) / f"{record['claude_session_id']}.jsonl"
                lines = transcript.read_text().splitlines() if record["claude_session_id"] is not None and transcript.exists() else []
                replies = {}
                for line in lines:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = entry.get("message")
                    if entry.get("type") != "assistant" or not isinstance(message, dict) or not message.get("usage"):
                        continue
                    usage = message["usage"]
                    replies[message.get("id")] = (
                        (usage.get("input_tokens") or 0)
                        + (usage.get("cache_creation_input_tokens") or 0)
                        + (usage.get("cache_read_input_tokens") or 0)
                        + (usage.get("output_tokens") or 0)
                    )
                record["tokens_used"] = sum(replies.values())
            # partial, not a lambda: the target VM is read from this record each time, not from the loop variable.
            computer_tools = ComputerTools(self.vms, self.queue, record["id"], functools.partial(record.get, "target_vm"), record["history"])
            agent = Agent(record, computer_tools, WorkTools(self, record), self.changed)
            self.agents[agent.id] = agent
            # Messages that waited when the backend stopped: it wakes for them, as it would have without the restart (a
            # message always wakes an agent that isn't archived). Not by "awake": a turn that failed while the backend
            # stopped saved it as False, and the agent never woke again (agent-89).
            self.pending[agent.id] = record.get("pending", [])
            self.wake[agent.id] = asyncio.Event()
            # Agents from before archiving, and from before name_by (an "agent-N" name was the automatic one).
            record.setdefault("archived_at", None)
            record.setdefault("name_by", "auto" if re.fullmatch(r"agent-\d+", record["name"]) else "user")
            # And from before repository agents (Live).
            record.setdefault("repo", None)
            record.setdefault("live", None)
            # And from before projects.
            record.setdefault("project", None)
            record.setdefault("role", None)
            # And from before the Workflow tab.
            record.setdefault("workflow", None)
            record.setdefault("workflow_role", None)
            # And from before priority.
            record.setdefault("priority", False)
            if record["priority"]:
                self.queue.prioritized.add(record["id"])
            if self.pending[agent.id] and record["archived_at"] is None:
                self.wake[agent.id].set()
            self.nudges[agent.id] = {"count": 0, "state": None}
            self.workers[agent.id] = asyncio.create_task(self.work(agent))

        # Every agent is called agent-N: older ones named for their work (by themselves or the app) get the next free
        # number, oldest first, once.
        names = [agent.name for agent in self.agents.values()]
        for agent in sorted(self.agents.values(), key=lambda each: each.record.get("created_at", "")):
            if agent.record.get("numbered"):
                continue
            if not re.fullmatch(r"agent-\d+", agent.name):
                number = 1
                while f"agent-{number}" in names:
                    number += 1
                agent.name = f"agent-{number}"
                agent.record["name"] = agent.name
                agent.record["name_by"] = "auto"
                names.append(agent.name)
            agent.record["numbered"] = True
            self.save(agent)

        # The queues are saved with the VMs: take out agents whose record is gone.
        for vm_record in self.vms.list():
            waiting = list(vm_record.queue)
            for line in vm_record.desktops.values():
                waiting.append(line["holder"])
            for agent_id in waiting:
                if agent_id is None or agent_id == "user" or agent_id in self.agents:
                    continue
                self.queue.leave_all(agent_id)

        # A VM an agent held when the backend stopped is still its own: it carries on.
        for agent_id in self.agents:
            vm_name, place = self.queue.place(agent_id)
            if place != 0:
                continue
            self.notify(agent_id, f"The backend restarted; you still hold {vm_name}. Check where your jobs for it stand (my_jobs), finish them, then release_vm.")

        # A repository's set-up the restart cut off goes on.
        for agent in self.agents.values():
            if agent.record["live"] is not None and agent.record["live"]["state"] == "preparing":
                asyncio.create_task(self.prepare_live(agent.id))

        # No tool call waits for a run anymore after a restart: they are all collected by watch_runs now.
        self.queue.to_background()
        self.saver = asyncio.create_task(self.autosave())
        self.run_watcher = asyncio.create_task(self.watch_runs())
        self.question_timer = asyncio.create_task(self.answer_questions())
        self.heartbeat = asyncio.create_task(self.keep_going())
        self.room_watcher = asyncio.create_task(self.watch_room())

    async def stop(self) -> None:
        if self.saver is not None:
            self.saver.cancel()
        if self.run_watcher is not None:
            self.run_watcher.cancel()
        if self.question_timer is not None:
            self.question_timer.cancel()
        if self.heartbeat is not None:
            self.heartbeat.cancel()
        if self.room_watcher is not None:
            self.room_watcher.cancel()
        for worker in self.workers.values():
            worker.cancel()
        for agent in self.agents.values():
            # Its turn is cut off here: after the restart it is woken with this (start()).
            if agent.busy:
                text = "The backend restarted in the middle of your turn; check my_jobs and carry on."
                # Its runs go on in the VM through a restart (long_runs.py), but a log file of its own may still be empty
                # then: it is told, so it doesn't take them for lost and start them again (reticle#1525).
                runs = []
                for vm_record in self.vms.list():
                    for run in vm_record.runs:
                        if run["agent"] == agent.id:
                            runs.append(f"{run['id']} in {vm_record.name} (`{run['label'][:120]}`)")
                if runs:
                    text += (
                        " A restart doesn't stop your runs: these go on in the VM until they end, and you get each one's result "
                        "in a message then (a file it writes may stay empty until it ends), so don't start them again: "
                        + "; ".join(runs) + "."
                    )
                self.pending[agent.id].insert(0, {"from": "System", "text": text, "shown": False})
            self.save(agent)
            await agent.stop()

    def changed(self) -> None:
        self.version += 1

    def save(self, agent: Agent) -> None:
        record = agent.record
        record["claude_session_id"] = agent.session_id
        record["context_used"] = agent.context_used
        record["context_max"] = agent.context_max
        record["cost_usd"] = agent.cost_usd
        record["compactions"] = agent.compactions
        record["tokens_used"] = agent.tokens_used
        record["pending"] = self.pending[agent.id]
        record["awake"] = agent.busy or self.wake[agent.id].is_set()
        # Write, then rename: a crash never leaves half a record.
        temporary = self.folder / f"{agent.id}.json.tmp"
        temporary.write_text(json.dumps(record))
        temporary.replace(self.folder / f"{agent.id}.json")

    async def autosave(self) -> None:
        while True:
            await asyncio.sleep(SAVE_SECONDS)
            for agent in list(self.agents.values()):
                if agent.busy:
                    self.save(agent)

    async def work(self, agent: Agent) -> None:
        """The agent's worker: wait for messages, run a turn with them, then apply the VM rule."""
        while True:
            await self.wake[agent.id].wait()
            self.wake[agent.id].clear()
            messages = self.pending[agent.id]
            if not messages:
                continue

            # "/compact" (the Compact button) is a command for Claude Code itself: it goes alone and as it is.
            batch = messages[:1]
            prompt = messages[0]["text"]
            if not prompt.startswith("/compact"):
                batch = []
                for message in messages:
                    if message["text"].startswith("/compact"):
                        break
                    batch.append(message)
                    # One of the user's messages per turn: the ones after it wait for the next turns.
                    if message["from"] == "User":
                        break
                prompt = "\n\n".join(f"[{message['from']}] {message['text']}" for message in batch)
                # The user wrote in the middle of a job (often stopping the turn to get it in): it answers, then goes on
                # with the job, unless they told it to stop or change course. Only in the prompt, not in the chat.
                working = [job for job in self.jobs.for_agent(agent.id) if job["status"] == "working"]
                if batch[-1]["from"] == "User" and working:
                    titles = ", ".join(f"{job['id']} ({job['title']})" for job in working)
                    prompt += (
                        f"\n\n[System] You are in the middle of {titles}. Answer the user and take in what they said, then "
                        "carry on with that work in this same turn, from where you were. Don't end your turn to ask whether "
                        "to go on, and don't release the VM to wait for their answer. Stop, wait or change course only when "
                        "they tell you to."
                    )
            self.pending[agent.id] = messages[len(batch):]
            if self.pending[agent.id]:
                self.wake[agent.id].set()

            now = datetime.now(UTC).isoformat()
            for message in batch:
                if message["shown"]:
                    continue
                kind = "user" if message["from"] == "User" else "system"
                agent.history.append({"type": kind, "text": message["text"], "time": now})
            agent.busy = True
            agent.last_event_at = now
            self.version += 1
            # Fresh GitHub answers every turn: an issue may have been taken or fixed since the last one.
            search.CACHE.clear()
            try:
                await agent.run(prompt)
            except Exception as error:
                agent.history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
                self.crashes.add("agent", f"{agent.name}'s turn failed: {type(error).__name__}: {error}", traceback.format_exc())
                # Start over with a fresh connection next time; the conversation is resumed.
                await agent.stop()
            finally:
                # A desktop lock the agent set ends with its turn, also one that failed or was cancelled.
                agent.computer_tools.end_turn()
            agent.busy = False
            self.save(agent)
            self.version += 1
            # Runs it left going have no tool call waiting for them anymore: watch_runs collects them.
            self.queue.to_background(agent.id)

            # The VM rule. Reminders count again from 0 whenever its place in a queue or a job's status
            # changes. Not on new notes: rewriting them is not progress.
            vm_name, place = self.queue.place(agent.id)
            jobs = self.jobs.for_agent(agent.id)
            state = [vm_name, place] + [[job["id"], job["status"]] for job in jobs]
            nudge = self.nudges[agent.id]
            if state != nudge["state"]:
                nudge["count"] = 0
                nudge["state"] = state
            open_jobs = [job for job in jobs if job["status"] in OPEN_STATUSES]
            jobs_here = [job for job in open_jobs if vm_name is not None and job["vm"] == vm_name]
            titles = ", ".join(f"{job['id']} ({job['title']})" for job in jobs_here)
            # A job here that waits only on a short timed question (draft_question with options, its timer at most
            # QUESTION_HOLD_SECONDS; the newest draft of the job): it keeps its desktop and sleeps, and the answer (the
            # user's, or the timer's pick) wakes it. Released, a claimed fix waited two days in a full vm1's line for its
            # last test run after a 10-minute question, and the owner merged their own fix meanwhile (opencodex#8319).
            asking = []
            for job in jobs:
                if place != 0 or job["vm"] != vm_name or job["status"] != "waiting_on_user" or not job["drafts"]:
                    continue
                try:
                    draft = self.inbox.get(job["drafts"][-1])
                except KeyError:
                    continue
                if draft["kind"] != "question" or draft["status"] != "pending" or draft["answer_by"] is None:
                    continue
                timer = datetime.fromisoformat(draft["answer_by"]) - datetime.fromisoformat(draft["created_at"])
                if timer <= timedelta(seconds=QUESTION_HOLD_SECONDS):
                    asking.append(job)

            if place == 0 and not jobs_here and not asking:
                try:
                    self.queue.release(vm_name, agent.id)
                except (ValueError, VMsError):
                    # The user took it, or deleted the VM, in the meantime.
                    continue
                agent.history.append({"type": "system", "text": f"Released {vm_name}: no jobs left", "time": datetime.now(UTC).isoformat()})
                self.save(agent)
                self.version += 1
                continue
            # Only a short timed question waits: it keeps its desktop and sleeps until the answer comes.
            if place == 0 and not jobs_here:
                continue
            # Interrupted by the user: it waits for them. More messages waiting: it goes on anyway.
            if agent.stopped or self.wake[agent.id].is_set():
                continue

            # Its run goes in the VM: it keeps its desktop and sleeps; watch_runs wakes it when the run ends.
            runs = []
            for vm_record in self.vms.list():
                if place == 0 and vm_record.name == vm_name:
                    runs = [run for run in vm_record.runs if run["agent"] == agent.id]
            if runs:
                continue
            # Reminded enough: it keeps the desktop anyway (the heartbeat wakes it later).
            if place == 0 and nudge["count"] >= MAX_NUDGES:
                continue
            if place == 0:
                nudge["count"] += 1
                text = (
                    f"You still hold {vm_name} and have open jobs: {titles}. Carry on with them now; don't wait for an answer "
                    "in chat. release_vm only when they are done, wait on a draft in the Inbox, or the user told you to stop."
                )
                self.pending[agent.id].append({"from": "System", "text": text, "shown": False})
                self.wake[agent.id].set()
                continue

            waiting = [job for job in open_jobs if job["status"] == "queued" and job["vm"] is not None]
            if place is not None or not waiting or nudge["count"] >= MAX_NUDGES:
                continue
            nudge["count"] += 1
            titles = ", ".join(f"{job['id']} ({job['title']})" for job in waiting)
            text = f"You have queued jobs for {waiting[0]['vm']}: {titles}. Use queue_for_vm when you are ready to work on them."
            self.pending[agent.id].append({"from": "System", "text": text, "shown": False})
            self.wake[agent.id].set()

    def summaries(self) -> list[dict]:
        summaries = []
        prs = self.inbox.pr_owners()
        for agent in sorted(self.agents.values(), key=lambda agent: agent.record["created_at"]):
            vm_name, place = self.queue.place(agent.id)
            status = "idle"
            if agent.busy:
                status = "working"
            if place is not None and place > 0:
                status = "in_queue"
            desktop = None
            for vm_record in self.vms.list():
                if vm_record.name == vm_name:
                    desktop = vm_record.desktop_of(agent.id)
            if place == 0:
                status = "using_vm"
            # The last thing it did, for the one-line activity column.
            recent = [entry for entry in agent.history[-50:] if entry["type"] in ["tool", "system"]]
            activity = ""
            if recent:
                activity = recent[-1].get("summary") or recent[-1].get("text") or ""
            # How far its todo list is, from the latest one it wrote (TodoWrite always sends the whole list).
            # Only the recent history: this runs on every change, and an old list doesn't matter anymore.
            todo_done = 0
            todo_total = 0
            for entry in reversed(agent.history[-3000:]):
                if entry["type"] != "tool" or entry["name"] != "TodoWrite":
                    continue
                todos = entry["input"].get("todos")
                if isinstance(todos, list):
                    todo_total = len(todos)
                    todo_done = len([todo for todo in todos if isinstance(todo, dict) and todo.get("status") == "completed"])
                break
            summaries.append(
                {
                    "id": agent.id,
                    "name": agent.name,
                    "target_vm": agent.record["target_vm"],
                    "status": status,
                    "busy": agent.busy,
                    "vm": vm_name,
                    # The desktop of that VM it holds or asked for (None: it waits for any).
                    "desktop": desktop,
                    "place": place,
                    "context_used": agent.context_used,
                    "context_max": agent.context_max,
                    "cost_usd": agent.cost_usd,
                    "compactions": agent.compactions,
                    "tokens_used": agent.tokens_used,
                    "history_length": len(agent.history),
                    "pending": len([message for message in self.pending[agent.id] if message["from"] == "User"]),
                    "queued": [message["text"] for message in self.pending[agent.id] if message["from"] == "User"],
                    "activity": activity,
                    "last_event_at": agent.last_event_at,
                    # A tool call without its result yet: a command or the test suite is running, so a long quiet
                    # spell is that tool working (each has a time limit), not the agent being stuck.
                    "in_tool": agent.busy and len(agent.history) > 0 and agent.history[-1]["type"] == "tool",
                    "todo_done": todo_done,
                    "todo_total": todo_total,
                    "created_at": agent.record["created_at"],
                    "archived_at": agent.record["archived_at"],
                    # PR drafts that wait for the user or were approved: then it can only be archived, not deleted.
                    "prs": prs.get(agent.id, 0),
                    # Goes up on every change to its artifacts, so an open Artifacts tab reads its folder again.
                    "artifacts_stamp": self.artifacts.stamps.get(agent.id, 0),
                    # A repository's agent (Live): its repo, and how far its set-up is.
                    "repo": agent.record["repo"],
                    "live": agent.record["live"],
                    # A project's worker or reviewer: its project, and which of the two it is.
                    "project": agent.record["project"],
                    "role": agent.record["role"],
                    # One of the Workflow tab's agents (workflow.py): its repository, and what it is there.
                    "workflow": agent.record["workflow"],
                    "workflow_role": agent.record["workflow_role"],
                    # The user gave it priority until its tasks are over (set_priority).
                    "priority": agent.record["priority"],
                }
            )
        return summaries

    def create(self, name: str = "") -> dict:
        """A new agent with no target VM. Without a name it gets the first free "agent-N"."""
        names = [agent.name for agent in self.agents.values()]
        name = name.strip()
        name_by = "user" if name else "auto"
        if name in names:
            raise ValueError(f"There is already an agent named {name}")
        if not name:
            number = 1
            while f"agent-{number}" in names:
                number += 1
            name = f"agent-{number}"
        agent_id = "agent_" + secrets.token_hex(3)
        while agent_id in self.agents:
            agent_id = "agent_" + secrets.token_hex(3)

        record = {
            "id": agent_id,
            "name": name,
            "target_vm": None,
            "claude_session_id": None,
            "history": [],
            "context_used": 0,
            "context_max": 0,
            "cost_usd": 0.0,
            "compactions": 0,
            "tokens_used": 0,
            "created_at": datetime.now(UTC).isoformat(),
            "archived_at": None,
            "name_by": name_by,
            "numbered": True,
            "repo": None,
            "live": None,
            "project": None,
            "role": None,
            "workflow": None,
            "workflow_role": None,
            "priority": False,
        }
        computer_tools = ComputerTools(self.vms, self.queue, agent_id, functools.partial(record.get, "target_vm"), record["history"])
        agent = Agent(record, computer_tools, WorkTools(self, record), self.changed)
        self.agents[agent_id] = agent
        self.pending[agent_id] = []
        self.wake[agent_id] = asyncio.Event()
        self.nudges[agent_id] = {"count": 0, "state": None}
        self.workers[agent_id] = self.loop.create_task(self.work(agent))
        self.save(agent)
        self.version += 1
        created = dict(record)
        del created["history"]
        del created["pending"]
        del created["awake"]
        return created

    def rename(self, agent_id: str, new_name: str, by: str = "user") -> None:
        """The user (or the agent itself, by "agent") renamed the agent. Jobs, drafts and the VM queue know it by its
        id, so nothing else changes."""
        agent = self.agents[agent_id]
        new_name = new_name.strip()
        if not new_name:
            raise ValueError("The name is empty")
        if new_name == agent.name:
            return
        if new_name in [other.name for other in self.agents.values()]:
            raise ValueError(f"There is already an agent named {new_name}")
        agent.name = new_name
        agent.record["name"] = new_name
        agent.record["name_by"] = by
        self.save(agent)
        self.version += 1

    def set_priority(self, agent_id: str, on: bool) -> None:
        """The user gives the agent priority (on) or takes it back. With it, the agent goes first: to the front of the
        VM's waiting line, and for the VM's CPU and memory (watch_runs). Only for an agent with tasks going (an open
        job, a run or a turn): it ends by itself once they are over (watch_runs)."""
        agent = self.agents[agent_id]
        if agent.record["priority"] == on:
            return
        text = "Priority taken back by the user"
        if on:
            open_jobs = [job for job in self.jobs.for_agent(agent_id) if job["status"] in OPEN_STATUSES]
            runs = []
            for vm_record in self.vms.list():
                runs += [run for run in vm_record.runs if run["agent"] == agent_id]
            if not open_jobs and not runs and not agent.busy:
                raise ValueError(f"{agent.name} has no tasks going (no open job, run or turn)")
            text = "Given priority by the user, until its tasks are over"
        agent.record["priority"] = on
        if on:
            self.queue.prioritized.add(agent_id)
        elif agent_id not in self.pr_priority:
            # Still on a pull request that needs action: it keeps that priority (set_pr_priority).
            self.queue.prioritized.discard(agent_id)
        # Waiting for a VM: to the front of the line now.
        vm_name, place = self.queue.place(agent_id)
        if on and place is not None and place > 0:
            try:
                self.queue.move_to_front(vm_name, agent_id)
            except (ValueError, VMsError):
                # It left the line meanwhile.
                pass
        agent.history.append({"type": "system", "text": text, "time": datetime.now(UTC).isoformat()})
        self.save(agent)
        self.version += 1

    def set_pr_priority(self, agent_ids: set[str]) -> None:
        """The agents working on a pull request of the user's that needs action now (backend/github_api.py, after every
        look at the pull requests): they get priority like the user's (VMQueue.prioritized: ahead in a VM's line, more
        CPU; an overloaded VM takes their desktop back only when nobody without priority is left), until their pull request no longer needs action or their job on it is over. An agent the
        user gave priority keeps it either way."""
        for agent_id in agent_ids:
            if agent_id not in self.agents or agent_id in self.pr_priority:
                continue
            self.pr_priority.add(agent_id)
            if agent_id in self.queue.prioritized:
                continue
            self.queue.prioritized.add(agent_id)
            # Waiting for a VM: ahead of everyone without priority now.
            vm_name, place = self.queue.place(agent_id)
            if place is not None and place > 0:
                try:
                    self.queue.move_up(vm_name, agent_id)
                except (ValueError, VMsError):
                    # It left the line meanwhile.
                    pass
            self.version += 1
        for agent_id in list(self.pr_priority):
            if agent_id in agent_ids:
                continue
            self.pr_priority.discard(agent_id)
            agent = self.agents.get(agent_id)
            if agent is None or not agent.record["priority"]:
                self.queue.prioritized.discard(agent_id)
            self.version += 1

    def set_review_priority(self, agent_ids: set[str]) -> None:
        """The agents with a review job queued or working, a PR draft's check before the Inbox (the Issues board's Review;
        backend/github_api.py, every few seconds): they go next in a VM's line, behind everyone with priority (the user's,
        a pull request that needs action) and ahead of the rest (In progress and Catalog), and an overloaded VM takes their
        desktop back only after the rest's (watch_room), until their review jobs are over."""
        for agent_id in agent_ids:
            if agent_id not in self.agents or agent_id in self.queue.reviewing:
                continue
            self.queue.reviewing.add(agent_id)
            if agent_id in self.queue.prioritized:
                continue
            # Waiting for a VM: ahead of everyone without priority now.
            vm_name, place = self.queue.place(agent_id)
            if place is not None and place > 0:
                try:
                    self.queue.move_up(vm_name, agent_id)
                except (ValueError, VMsError):
                    # It left the line meanwhile.
                    pass
            self.version += 1
        for agent_id in list(self.queue.reviewing):
            if agent_id in agent_ids:
                continue
            self.queue.reviewing.discard(agent_id)
            self.version += 1

    async def delete(self, agent_id: str) -> None:
        """Stop the agent and delete it. Its open jobs become cancelled; its drafts stay in the Inbox.
        Not an agent that made PRs: it keeps its conversation for updates on them (archive it instead)."""
        agent = self.agents[agent_id]
        prs = self.inbox.pr_owners().get(agent_id, 0)
        if prs > 0:
            raise ValueError(f"{agent.name} made {prs} PR{'s' if prs > 1 else ''}. Archive it instead, so it keeps its conversation for updates on them.")
        await agent.interrupt()
        # The VM it holds or waits for, read before it leaves the queue.
        vm_name, place = self.queue.place(agent_id)
        # Out of the dicts first, so nothing (a grant, a save) reaches it anymore.
        del self.agents[agent_id]
        self.workers.pop(agent_id).cancel()
        del self.pending[agent_id]
        del self.wake[agent_id]
        del self.nudges[agent_id]
        self.queue.leave_all(agent_id)
        self.queue.prioritized.discard(agent_id)
        self.queue.reviewing.discard(agent_id)
        self.pr_priority.discard(agent_id)
        self.jobs.delete_for_agent(agent_id)
        self.version += 1
        await agent.stop()
        await self.stop_runs(agent_id)
        # Its desktop lock and whatever it still runs in the VM end with it.
        agent.computer_tools.end_turn()
        if vm_name is not None:
            await asyncio.to_thread(agent.computer_tools.cancel, vm_name)
        (self.folder / f"{agent_id}.json").unlink(missing_ok=True)
        # Its artifacts go with it (an archived agent keeps them), and so do its issue drafts, which only its chat shows.
        await asyncio.to_thread(self.artifacts.delete_all, agent_id)
        await asyncio.to_thread(self.issue_drafts.delete_for_agent, agent_id)

    async def archive(self, agent_id: str) -> None:
        """Put the agent away: it stops, its open jobs become cancelled and it leaves every VM queue (what it still
        ran in the VM is killed). Its conversation stays; unarchive() brings it back."""
        agent = self.agents[agent_id]
        if agent.record["archived_at"] is not None:
            return
        await agent.interrupt()
        vm_name, place = self.queue.place(agent_id)
        self.queue.leave_all(agent_id)
        self.jobs.delete_for_agent(agent_id)
        # The user's messages that still waited are dropped; the app's wait for when it is back.
        self.pending[agent_id] = [message for message in self.pending[agent_id] if message["from"] != "User"]
        self.wake[agent_id].clear()
        agent.record["archived_at"] = datetime.now(UTC).isoformat()
        agent.history.append({"type": "system", "text": "Archived: its open jobs were cancelled", "time": agent.record["archived_at"]})
        agent.computer_tools.end_turn()
        await self.stop_runs(agent_id)
        if vm_name is not None:
            await asyncio.to_thread(agent.computer_tools.cancel, vm_name)
        self.save(agent)
        self.version += 1

    def unarchive(self, agent_id: str) -> None:
        """Bring an archived agent back. Messages that waited for it go in now."""
        agent = self.agents[agent_id]
        if agent.record["archived_at"] is None:
            return
        agent.record["archived_at"] = None
        agent.history.append({"type": "system", "text": "Back from the archive", "time": datetime.now(UTC).isoformat()})
        if self.pending[agent_id]:
            self.wake[agent_id].set()
        self.save(agent)
        self.version += 1

    def history(self, agent_id: str, since: int) -> list[dict]:
        return self.agents[agent_id].history[since:]

    def send(self, agent_id: str, text: str) -> None:
        """A chat message from the user. It waits while the agent works, then goes with its next turn."""
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        if not text.strip():
            raise ValueError("The message is empty")
        # Talking to an archived agent brings it back.
        self.unarchive(agent_id)
        waiting = [message for message in self.pending[agent_id] if message["from"] == "User"]
        if len(waiting) >= MAX_QUEUED:
            raise ValueError(f"{MAX_QUEUED} messages already wait; send more when one has gone in")
        self.pending[agent_id].append({"from": "User", "text": text.strip(), "shown": False})
        self.wake[agent_id].set()
        self.version += 1

    def cancel_queued(self, agent_id: str, index: int, text: str) -> None:
        """Take one of the user's queued messages out before it goes in: the index-th of theirs, when it still has that
        text (one may have gone in meanwhile, moving the others up), or else the first of theirs with that text."""
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        users = [message for message in self.pending[agent_id] if message["from"] == "User"]
        chosen = None
        if 0 <= index < len(users) and users[index]["text"] == text:
            chosen = users[index]
        for message in users:
            if chosen is None and message["text"] == text:
                chosen = message
        if chosen is None:
            raise ValueError("That message isn't waiting anymore: it went in, or was taken out already.")
        self.pending[agent_id].remove(chosen)
        self.save(self.agents[agent_id])
        self.version += 1

    def notify(self, agent_id: str, text: str) -> None:
        """A message from the app that wakes the agent. Safe to call from any thread."""
        if threading.get_ident() != self.loop_thread:
            self.loop.call_soon_threadsafe(self.notify, agent_id, text)
            return
        # An agent deleted in the meantime.
        if agent_id not in self.agents:
            return
        self.pending[agent_id].append({"from": "System", "text": text, "shown": False})
        # An archived agent hears it once it is back.
        if self.agents[agent_id].record["archived_at"] is None:
            self.wake[agent_id].set()
        self.version += 1

    def secrets_filled(self, names: list[str], where: str) -> None:
        """The user gave a value to empty env variables (where: "for all VMs" or "on vm2"). Each agent that added
        one of them (env_var_add in its history) is told, so it carries on with what waited for it. Any thread."""
        if threading.get_ident() != self.loop_thread:
            self.loop.call_soon_threadsafe(self.secrets_filled, names, where)
            return
        for agent in self.agents.values():
            added = [entry.get("input", {}).get("name") for entry in agent.history if entry["type"] == "tool" and entry["name"] == "env_var_add"]
            filled = [name for name in names if name in added]
            if filled:
                self.notify(agent.id, f"The user filled in {', '.join(filled)} ({where}). Carry on with what waited for it.")

    async def interrupt(self, agent_id: str) -> None:
        await self.agents[agent_id].interrupt()

    async def pause_job(self, job_id: str) -> None:
        """The user paused the issue the job is for (Pause on the Dashboard's Issues board): the job stops as it is
        (paused, with paused_from), and when its agent was working on it, so does the agent: its turn, its desktop lock
        and what it runs in the VM. The agent hears it with its next turn; this doesn't wake it."""
        job = self.jobs.get(job_id)
        if job["status"] not in ("queued", "working", "waiting_on_user"):
            return
        self.jobs.update(job_id, status="paused", paused_from=job["status"])
        self.jobs.add_timeline(job_id, "status", "Paused by you")
        agent_id = job["agent"]
        if agent_id not in self.agents:
            return
        text = f"The user paused {job_id} ({job['title']}). Don't work on it at all until they resume it; you will be told."
        self.pending[agent_id].append({"from": "System", "text": text, "shown": False})
        if job["status"] == "working":
            agent = self.agents[agent_id]
            await agent.interrupt()
            agent.computer_tools.end_turn()
            await self.stop_runs(agent_id)
            vm_name, place = self.queue.place(agent_id)
            if vm_name is not None:
                await asyncio.to_thread(agent.computer_tools.cancel, vm_name)
        self.version += 1

    def resume_job(self, job_id: str) -> None:
        """Resume on the board: the paused job gets its status back, and its agent is woken to go on with it."""
        job = self.jobs.get(job_id)
        if job["status"] != "paused":
            return
        self.jobs.update(job_id, status=job.get("paused_from") or "queued", paused_from=None)
        self.jobs.add_timeline(job_id, "status", "Resumed by you")
        self.notify(job["agent"], f"The user resumed {job_id} ({job['title']}): go on with it where you left off.")

    def set_target_vm(self, agent_id: str, vm_name: str | None, by_agent: bool = False) -> None:
        """The VM the agent works in. Its unfinished jobs move along. Not while it waits for or holds a VM.

        The user sets it, or the agent picks one itself (choose_vm, by_agent=True: then it isn't told).
        """
        agent = self.agents[agent_id]
        if vm_name == agent.record["target_vm"]:
            return
        queued_vm, place = self.queue.place(agent_id)
        if place == 0:
            raise ValueError(f"{agent.name} holds {queued_vm}; change its target VM after it releases it")
        if place is not None:
            raise ValueError(f"{agent.name} waits for {queued_vm}; change its target VM after it leaves the queue")
        if vm_name is not None and vm_name not in [vm_record.name for vm_record in self.vms.list()]:
            raise ValueError(f"No VM named {vm_name}")

        agent.record["target_vm"] = vm_name
        moved = []
        for job in self.jobs.for_agent(agent_id):
            if job["status"] in ["done", "cancelled"]:
                continue
            self.jobs.update(job["id"], vm=vm_name)
            moved.append(job)
        self.save(agent)
        self.version += 1
        if by_agent:
            return

        # Queued jobs can start now, so that wakes it; otherwise it hears with its next message.
        text = f"The user set your target VM to {vm_name}."
        if vm_name is None:
            text = "The user took your target VM away; pick another with vms_list and choose_vm when you need one."
        if any(job["status"] == "queued" for job in moved) and vm_name is not None:
            self.notify(agent_id, text + " Your open jobs moved to it. Use queue_for_vm when you are ready to work on them.")
            return
        self.pending[agent_id].append({"from": "System", "text": text, "shown": False})
        self.save(agent)

    def rename_vm(self, name: str, new_name: str) -> None:
        """The user renamed a VM: agents aimed at it and the jobs on it follow. Those agents hear with their next message."""
        if new_name == name:
            return
        self.jobs.rename_vm(name, new_name)
        for agent in self.agents.values():
            if agent.record["target_vm"] != name:
                continue
            agent.record["target_vm"] = new_name
            self.pending[agent.id].append({"from": "System", "text": f"The user renamed {name} to {new_name}. It is still your target VM.", "shown": False})
            self.save(agent)
        self.version += 1

    def assign(self, issue_id: str, agent_id: str | None, vm_name: str | None, instructions: str = "") -> dict:
        """The user gives an issue to an agent (a new one when agent_id is None): a fix_issue job."""
        matches = [item for item in self.issues.items() if item["id"] == issue_id]
        if not matches:
            raise KeyError(f"{issue_id} is not in the Issues list")
        issue = matches[0]
        if vm_name is not None and vm_name not in [vm_record.name for vm_record in self.vms.list()]:
            raise ValueError(f"No VM named {vm_name}")
        if agent_id is None:
            agent_id = self.create()["id"]
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        agent = self.agents[agent_id]
        # Raises ValueError while the agent waits for or holds another VM.
        if vm_name is not None:
            self.set_target_vm(agent_id, vm_name)
        self.unarchive(agent_id)

        title = f"Fix {issue_id}: {issue['title']}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("fix_issue", title, agent_id, "user", issue=issue_id, repo=issue["repo"], vm=vm_name, instructions=instructions, agent_name=agent.name)
        text = f"New job {job['id']}: {title}"
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        # The user's own words on the issue (an earlier claim of theirs, an issue we opened as them) are ours, never someone
        # else on it (QwenPaw#8698: the user's claim, taken for someone else's).
        login = self.your_repositories.github_account.status().get("login")
        if login:
            text += (
                f"\nThe user's GitHub login is {login}: whatever {login} wrote or opened on the issue is ours (an earlier claim "
                "of theirs too; read_issue marks it by_user), never someone else on it."
            )
        if vm_name is None:
            text += "\nYou have no target VM: pick the VM that suits the job with vms_list and choose_vm, then queue_for_vm when ready."
        else:
            text += f"\nIt is for {vm_name}. Use queue_for_vm when ready."
        self.notify(agent_id, text)
        return job

    def create_job(self, title: str, instructions: str, agent_id: str | None, vm_name: str | None, agent_name: str = "") -> dict:
        """The user makes a job of their own (a "task", not tied to an issue) for an agent, or a new one when agent_id is None.

        agent_name names that new agent; empty gives it the first free "agent-N".
        """
        title = title.strip()
        if not title:
            raise ValueError("A job needs a title")
        if vm_name is not None and vm_name not in [vm_record.name for vm_record in self.vms.list()]:
            raise ValueError(f"No VM named {vm_name}")
        if agent_id is None:
            agent_id = self.create(agent_name)["id"]
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        agent = self.agents[agent_id]
        # Raises ValueError while the agent waits for or holds another VM.
        if vm_name is not None:
            self.set_target_vm(agent_id, vm_name)
        self.unarchive(agent_id)

        vm_name = agent.record["target_vm"]
        job = self.jobs.create("task", title, agent_id, "user", vm=vm_name, instructions=instructions, agent_name=agent.name)
        text = f"New job {job['id']}: {title}"
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        if vm_name is None:
            text += "\nYou have no target VM. If the job needs one, pick the one that suits it with vms_list and choose_vm."
        else:
            text += f"\nYour VM is {vm_name}. If the job needs it, use queue_for_vm when ready; if it doesn't, just do it and mark it done."
        self.notify(agent_id, text)
        return job

    def set_up_repo(self, repo: str, agent_id: str | None, vm_name: str | None, instructions: str = "") -> dict:
        """The user gives a repo from the Repos list to an agent (a new one when agent_id is None) to set up in a VM: a
        set_up_repo job (see "Setting up a repo" in agent/prompt.md)."""
        if repo not in [item["full_name"] for item in self.repos.items()]:
            raise KeyError(f"{repo} is not in the Repos list")
        if vm_name is not None and vm_name not in [vm_record.name for vm_record in self.vms.list()]:
            raise ValueError(f"No VM named {vm_name}")
        if agent_id is None:
            agent_id = self.create()["id"]
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        agent = self.agents[agent_id]
        # Raises ValueError while the agent waits for or holds another VM.
        if vm_name is not None:
            self.set_target_vm(agent_id, vm_name)
        self.unarchive(agent_id)

        title = f"Set up {repo}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("set_up_repo", title, agent_id, "user", repo=repo, vm=vm_name, instructions=instructions, agent_name=agent.name)
        text = f"New job {job['id']}: {title}"
        text += (
            "\nRead its README and docs first. If it has a clear frontend, set it up the way they say and leave it running on "
            "the desktop; if it is a library or other low-level building block, clone it and open it in VS Code. Either way, "
            "end with a short introduction to the repo (see Setting up a repo)."
            f"\nA server you leave running goes in your desktop's demo service. On desktop 1: its start command in "
            f"{DEMO_DIR}/run.sh, then `sudo systemctl enable demo` and `sudo systemctl restart demo` (logs: "
            "`journalctl -u demo`). On desktop n: the same with /opt/demo-n/run.sh and the service demo-n."
        )
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        if vm_name is None:
            text += "\nYou have no target VM: pick the VM that suits the job with vms_list and choose_vm, then queue_for_vm when ready."
        else:
            text += f"\nIt is for {vm_name}. Use queue_for_vm when ready."
        self.notify(agent_id, text)
        return job

    def reproduce_paper(self, title: str, file_name: str, data: bytes, agent_id: str | None, vm_name: str | None,
                        instructions: str = "", agent_name: str = "") -> dict:
        """The user adds a paper (a PDF) on the Papers page for an agent (a new one when agent_id is None) to reproduce: a
        reproduce_paper job (see "Reproducing a paper" in agent/prompt.md). The PDF goes in the agent's artifacts, under
        papers/, where the agent reads it (paper_read). agent_name names that new agent; empty gives it "agent-N"."""
        if not data.startswith(b"%PDF"):
            raise ValueError("That file is not a PDF.")
        if vm_name is not None and vm_name not in [vm_record.name for vm_record in self.vms.list()]:
            raise ValueError(f"No VM named {vm_name}")
        if agent_id is None:
            agent_id = self.create(agent_name)["id"]
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        agent = self.agents[agent_id]
        # Raises ValueError while the agent waits for or holds another VM.
        if vm_name is not None:
            self.set_target_vm(agent_id, vm_name)
        self.unarchive(agent_id)

        # papers/<name>.pdf, with a number when the agent has a paper by that name already.
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(file_name).stem).strip("-.")
        if stem == "":
            stem = "paper"
        path = f"papers/{stem}.pdf"
        number = 2
        while self.artifacts.resolve(agent_id, path).exists():
            path = f"papers/{stem}-{number}.pdf"
            number += 1
        self.artifacts.save(agent_id, path, data)

        title = title.strip()
        if title == "":
            title = stem
        title = f"Reproduce {title}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("reproduce_paper", title, agent_id, "user", vm=vm_name, instructions=instructions, paper=path)
        text = f"New job {job['id']}: {title}"
        text += (
            f"\nThe paper is {path} in your artifacts. Read all of it with paper_read first, a few pages at a time, then "
            "reproduce it as in Reproducing a paper: rebuild it from the paper alone, compare the numbers, check the claims, "
            "and end with draft_report."
        )
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        if vm_name is None:
            text += "\nYou have no target VM: pick the VM that suits the job with vms_list and choose_vm, then queue_for_vm when you have read the paper."
        else:
            text += f"\nIt is for {vm_name}. Use queue_for_vm when you have read the paper."
        self.notify(agent_id, text)
        return job

    def live_agent(self, repo: str) -> dict | None:
        """The record of the repository's agent (Live), or None when it has none yet."""
        for agent in self.agents.values():
            if agent.record["repo"] == repo:
                return agent.record
        return None

    def set_up_live(self, repo: str, vm_name: str) -> dict:
        """The Live tab's Set up for one of the user's repositories: a new agent that belongs to it, aimed at its new VM
        vm_name (made by backend/repo_live_api.py). It is named after the repo. prepare_live() goes on from there."""
        if self.live_agent(repo) is not None:
            raise ValueError(f"{repo} has its agent already")
        created = self.create()
        agent = self.agents[created["id"]]
        agent.record["repo"] = repo
        agent.record["live"] = {"state": "preparing", "error": None}
        # Not told: its first message (prepare_live) says it all.
        self.set_target_vm(agent.id, vm_name, by_agent=True)
        self.save(agent)
        self.version += 1
        self.loop.create_task(self.prepare_live(agent.id))
        return created

    def retry_live(self, agent_id: str, vm_name: str) -> None:
        """The Live tab's Try again, after prepare_live failed: once more, on vm_name (the same VM, or a new one when the
        old one is gone)."""
        agent = self.agents[agent_id]
        if agent.record["live"] is None or agent.record["live"]["state"] != "failed":
            raise ValueError(f"{agent.name} isn't waiting for a new try")
        self.set_target_vm(agent_id, vm_name, by_agent=True)
        agent.record["live"] = {"state": "preparing", "error": None}
        self.save(agent)
        self.version += 1
        self.loop.create_task(self.prepare_live(agent_id))

    async def prepare_live(self, agent_id: str) -> None:
        """A repository's agent gets its repo's code in its VM: once the VM is up (started if it is off), the repo is
        cloned here with the user's sign-in and copied into desktop 1's home (copy_repo). Then the agent gets its
        set_up_repo job. A failure is kept in record["live"], with why, and shows in its chat."""
        agent = self.agents.get(agent_id)
        if agent is None:
            return
        repo = agent.record["repo"]
        error = None
        vm_record = None
        started = False
        waited = 0
        while error is None:
            # It may be deleted meanwhile, or its VM renamed (its target VM follows) or deleted.
            if agent_id not in self.agents:
                return
            vm_name = agent.record["target_vm"]
            vm_record = None
            for each in self.vms.list():
                if each.name == vm_name:
                    vm_record = each
            if vm_record is None:
                error = "Its VM is gone. Try again to make a new one."
            elif vm_record.status == "running" and vm_record.usage["responding"]:
                break
            elif vm_record.status in ["failed", "missing"]:
                error = f"{vm_name} could not be made: {vm_record.error}. Delete it on the VMs page, then Try again."
            elif vm_record.status == "stopped" and started:
                error = f"{vm_name} didn't start: {vm_record.error}"
            elif vm_record.status == "stopped":
                started = True
                try:
                    self.vms.start_in_background(vm_name)
                except VMsError:
                    # Busy with something else: look again next round.
                    pass
            elif waited > LIVE_WAIT_SECONDS:
                error = f"{vm_name} wasn't up after {LIVE_WAIT_SECONDS // 60} minutes."
            if error is None:
                await asyncio.sleep(LIVE_CHECK_SECONDS)
                waited += LIVE_CHECK_SECONDS

        if error is None:
            try:
                await asyncio.to_thread(self.copy_repo, repo, vm_record)
            except Exception as failure:
                # Not signed in, a clone or copy that failed, a VM that stopped answering: all said the same way.
                error = f"Could not put the code in {vm_record.name}: {failure}"
        if agent_id not in self.agents:
            return
        now = datetime.now(UTC).isoformat()
        if error is not None:
            agent.record["live"] = {"state": "failed", "error": error}
            agent.history.append({"type": "system", "text": error, "time": now})
            self.save(agent)
            self.version += 1
            return

        vm_name = vm_record.name
        folder = repo.split("/")[1]
        agent.record["live"] = {"state": "ready", "error": None}
        agent.history.append({"type": "system", "text": f"The code is in {vm_name}, in ~/{folder} on desktop 1", "time": now})
        title = f"Set up {repo}"
        job = self.jobs.create("set_up_repo", title, agent_id, "user", repo=repo, vm=vm_name, agent_name=agent.name)
        text = (
            f"You are the agent of {repo}, one of the user's own repositories (see Your repository). Its VM is {vm_name}: "
            "the user tries the repo out on its desktop 1, next to this chat, on the Workspace tab's Live.\n"
            f"New job {job['id']}: {title}\n"
            f"The app copied the code into desktop 1's home folder: ~/{folder}, the default branch with its history. The VM has "
            "no GitHub access, so you can't fetch or push there for a private repo, and that is fine. Read its README and docs "
            "first, with your repo_* tools. If it has a clear frontend, set it up the way they say and leave it running on the "
            "desktop; if it is a library or other low-level building block, open it in VS Code. Either way, end with a short "
            "introduction to the repo (see Setting up a repo).\n"
            f"A server you leave running goes in desktop 1's demo service: its start command in {DEMO_DIR}/run.sh, then "
            "`sudo systemctl enable demo` and `sudo systemctl restart demo` (logs: `journalctl -u demo`).\n"
            f"It is for {vm_name}, on desktop 1, where the code is and where the user looks: queue_for_vm with desktop 1 when ready."
        )
        self.save(agent)
        self.notify(agent_id, text)

    def copy_repo(self, repo: str, vm_record) -> None:
        """Clone repo here with the user's sign-in and copy it into desktop 1's home in the VM (prepare_live, in a thread).
        A folder of that name already there (an earlier try) is kept as it is."""
        folder = repo.split("/")[1]
        vm = vm_record.desktop_vm(1)
        result = vm.exec("cd && pwd", 30)
        home = result.stdout.strip()
        if result.returncode != 0 or not home.startswith("/"):
            raise ValueError(f"the VM didn't say where desktop 1's home is: {result.stderr.strip()}")
        if vm.exec(f"test -e {shlex.quote(folder)}", 30).returncode == 0:
            return
        # On this computer's disk, not in /tmp (memory): a big repo can take gigabytes.
        with tempfile.TemporaryDirectory(dir=DATA_DIR) as temporary:
            target = Path(temporary) / folder
            self.your_repositories.clone(repo, str(target))
            to_vm(vm, str(target), home)

    def start_project(self, repo: str, vm_name: str) -> None:
        """Development's Start (backend/projects_api.py made the project and its VM, vm_name): its chat agent is the
        repository's agent (a new one when the repo has none: set_up_live, which sets the repo up on the VM's desktop
        1), then its workers and reviewer come (project_agents). The chat agent hears what it is now."""
        chat = self.live_agent(repo)
        if chat is None:
            chat = self.set_up_live(repo, vm_name)
        self.projects.update(repo, chat=chat["id"])
        self.project_agents(repo)
        text = (
            f"The user started development of {repo}: agents develop it all the time now (see Developing a project), and "
            "you are its chat agent. It is in Drafts mode: what the user asks for, you write as issue drafts for them to "
            "create. project_status shows where it stands."
        )
        self.pending[chat["id"]].append({"from": "System", "text": text, "shown": False})
        self.save(self.agents[chat["id"]])
        self.version += 1

    def project_agents(self, repo: str) -> None:
        """A project's workers, as many as it asks for, and its reviewer, aimed at its VM: missing ones are made, archived
        ones come back, extra workers are archived (their issues go back, for the others to take). Every round of
        backend/projects_api.py, while the project is on."""
        project = self.projects.get(repo)
        if project is None:
            return
        vm_names = [vm_record.name for vm_record in self.vms.list()]
        workers = [agent_id for agent_id in project["workers"] if agent_id in self.agents]
        for agent_id in workers:
            self.unarchive(agent_id)
        while len(workers) < project["agents"]:
            created = self.create()
            agent = self.agents[created["id"]]
            agent.record["project"] = project["repo"]
            agent.record["role"] = "worker"
            if project["vm"] in vm_names:
                self.set_target_vm(agent.id, project["vm"], by_agent=True)
            self.save(agent)
            workers.append(agent.id)
        while len(workers) > project["agents"]:
            agent_id = workers.pop()
            for issue in project["issues"].values():
                if issue["agent"] == agent_id and issue["state"] == "working":
                    self.projects.drop_issue(repo, issue["number"])
            self.loop.create_task(self.archive(agent_id))

        reviewer = project["reviewer"]
        if reviewer in self.agents:
            self.unarchive(reviewer)
        else:
            created = self.create()
            agent = self.agents[created["id"]]
            agent.record["project"] = project["repo"]
            agent.record["role"] = "reviewer"
            if project["vm"] in vm_names:
                self.set_target_vm(agent.id, project["vm"], by_agent=True)
            self.save(agent)
            reviewer = agent.id
        self.projects.update(repo, workers=workers, reviewer=reviewer)

    def give_issue(self, repo: str, issue: dict, agent_id: str, again: bool) -> dict:
        """A project's next open issue ({"number", "title"}) for one of its workers (backend/projects_api.py): a fix_issue
        job. again: it was denied, closed or done before and is open again (reopened, or Try again)."""
        agent = self.agents[agent_id]
        self.unarchive(agent_id)
        project = self.projects.get(repo)
        issue_id = f"{repo}#{issue['number']}"
        title = f"Fix {issue_id}: {issue['title']}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("fix_issue", title, agent_id, "user", issue=issue_id, vm=vm_name, agent_name=agent.name)
        text = (
            f"New job {job['id']}: {title}\n"
            f"{repo} is a project the user has agents develop all the time, and this is its next open issue: work on it as in "
            f"Developing a project. Check it first (repo_thread {issue['number']}, the code it is about, the other issues and pull "
            f"requests), then reproduce it on the newest code in the VM (sync_code puts it in ~/{agent.name}). When it isn't worth "
            "doing or can't be reproduced, deny it with deny_issue. Otherwise fix it, test it, show it, and draft_pr: the "
            "project's reviewer reviews it before the user sees it."
        )
        if again:
            text += "\nIt was denied, closed or done before and is open again: the user wants it. Don't deny it again for the same reason."
        if project is not None and project["goals"]:
            text += f"\nThe user's goals for {repo}:\n{project['goals']}"
        if vm_name is None:
            text += "\nYou have no target VM: pick the VM that suits the job with vms_list and choose_vm, then queue_for_vm when ready."
        else:
            text += f"\nIt is for {vm_name}. Use queue_for_vm when you are ready to reproduce it."
        self.notify(agent_id, text)
        return job

    def give_review(self, draft: dict, desktop: int) -> None:
        """A PR draft (work_tools.py draft_pr, made on desktop of draft["vm"]) for a reviewer: a review job. The draft waits
        out of the Inbox until review_finished(). A project's draft goes to the project's reviewer; a project with no
        reviewer lets it through at once. Any other repo's draft goes to that repo's own reviewer (record "role":
        "reviewer", "reviews": the repo), made the first time, aimed at the draft's VM: it checks the draft the way the
        repo's maintainers will, in the author's folder on the author's desktop, where the project is set up and built."""
        now = datetime.now(UTC).isoformat()
        if draft["repo"] is None:
            self.inbox.set_review(draft["id"], {"state": "passed", "agent": None, "job": None, "notes": "It names no repo, so nobody reviewed it.", "at": now})
            return
        project = self.projects.get(draft["repo"])
        reviewer = None
        if project is not None:
            reviewer = project["reviewer"]
            if reviewer not in self.agents:
                self.inbox.set_review(draft["id"], {"state": "passed", "agent": None, "job": None, "notes": "The project has no reviewer, so nobody reviewed it.", "at": now})
                return
        else:
            for agent in self.agents.values():
                if agent.record.get("role") == "reviewer" and agent.record.get("reviews") == draft["repo"].lower():
                    reviewer = agent.id
            if reviewer is None:
                created = self.create()
                agent = self.agents[created["id"]]
                agent.record["role"] = "reviewer"
                agent.record["reviews"] = draft["repo"].lower()
                self.save(agent)
                reviewer = agent.id
        self.unarchive(reviewer)
        # It checks the draft where it was made. While it holds or waits for another VM it keeps that one, and its
        # message says where to go next.
        if project is None and draft["vm"] is not None:
            try:
                self.set_target_vm(reviewer, draft["vm"], by_agent=True)
            except ValueError:
                pass
        author = draft["agent"]
        if author in self.agents:
            author = self.agents[author].name
        vm_name = self.agents[reviewer].record["target_vm"]
        title = f"Review {draft['id']}: {draft['title']}"
        job = self.jobs.create("review", title, reviewer, "user", issue=draft["target"], repo=draft["repo"], vm=vm_name, agent_name=self.agents[reviewer].name)
        self.inbox.set_review(draft["id"], {"state": "waiting", "agent": reviewer, "job": job["id"], "notes": "", "at": now})
        if project is not None:
            text = (
                f"New job {job['id']}: {title}\n{author} drafted this PR for {draft['target']}. Review it as in Reviewing a pull "
                f"request: review_read {draft['id']}, then check it in the VM on its own code (sync_code, then apply its diff on its "
                "base_sha), run its tests, look at its pictures, and end with review_done."
            )
            if vm_name is not None:
                text += f"\nIt is for {vm_name}: queue_for_vm once you have read it."
            self.notify(reviewer, text)
            return
        what = "a new PR"
        if draft["update_of"] is not None:
            what = f"the next version of the user's PR {draft['update_of']}"
        text = (
            f"New job {job['id']}: {title}\n{author} drafted {what} for {draft['target']} in {draft['repo']}, someone else's "
            "project. Before it reaches the user's Inbox, check it the way that project's maintainers will, as in Reviewing a "
            f"PR before it goes out: review_read {draft['id']}, read the whole thread it is for, go through every point that was "
            "asked, then try to break it in the VM, and end with review_done.\n"
            f"It was made in {draft['path']} on desktop {desktop} of {draft['vm']}, where the project is set up and built: "
            f"queue_for_vm with desktop {desktop} once you have read it, check in that folder, and leave it as you found it."
        )
        # What the user wrote on the thread is ours (the author's claim, an earlier version, a reply the app sent as them):
        # on QwenPaw#8698 the reviewer took the user's own claim for someone else's and sent the PR back.
        login = self.your_repositories.github_account.status().get("login")
        if login:
            text += (
                f"\nThe user's GitHub login is {login}: whatever {login} wrote or opened there is ours (the author's claim, "
                "an earlier version, a reply the app sent as the user; read_issue marks it by_user), never someone else on it."
            )
        if vm_name != draft["vm"]:
            text += f"\nYour target VM is {vm_name}: once you hold none, choose_vm {draft['vm']} for this one."
        self.notify(reviewer, text)

    def review_finished(self, draft_id: str, passed: bool, notes: str) -> None:
        """The reviewer's verdict on a project PR draft (project_tools.py review_done). Passed: it shows in the Inbox, and
        its author hears so with its next message. Changes: it is rejected with the notes, so it never shows, and its
        author's job is open again, to fix and draft again."""
        draft = self.inbox.get(draft_id)
        review = dict(draft["review"])
        review["state"] = "passed" if passed else "changes"
        review["notes"] = notes
        review["at"] = datetime.now(UTC).isoformat()
        self.inbox.set_review(draft_id, review)
        if review["job"] is not None:
            verdict = "Passed" if passed else "Asked for changes"
            self.jobs.update(review["job"], status="done", notes=f"{verdict}: {notes}")
        author = self.agents.get(draft["agent"])
        if author is None:
            return
        if passed:
            text = f"Your PR draft {draft_id} ({draft['title']}) passed review and is in the user's Inbox now. The reviewer's notes: {notes}"
            self.pending[author.id].append({"from": "System", "text": text, "shown": False})
            self.save(author)
            self.version += 1
            return
        self.inbox.decide(draft_id, "rejected", notes)
        job_name = "your work"
        if draft["job"] is not None:
            job = self.jobs.get(draft["job"])
            job_name = job["id"]
            if job["status"] == "waiting_on_user":
                self.jobs.update(job["id"], status="queued")
        text = (
            f"The reviewer asked for changes on your PR draft {draft_id} ({draft['title']}) for {job_name}:\n{notes}\n"
            "Make them (queue_for_vm when you need the VM), run the tests again with when: after, and draft_pr again: the new "
            "draft is reviewed again."
        )
        self.notify(author.id, text)

    def redo_pr(self, repo: str, pr: dict) -> None:
        """A project's open PR conflicts with main now (backend/projects_api.py): its agent makes it again on the new main,
        as a fix_issue job whose thread is that PR. Its draft replaces the PR, which is closed once the new one is on
        GitHub."""
        agent = self.agents.get(pr["agent"])
        if agent is None:
            return
        self.unarchive(agent.id)
        thread = f"{repo}#{pr['number']}"
        issue_id = None
        if pr["issue"] is not None:
            issue_id = f"{repo}#{pr['issue']}"
        branch = "your old branch"
        try:
            branch = f"your old branch {self.inbox.get(pr['draft'])['branch']}"
        except KeyError:
            pass
        title = f"Redo #{pr['number']} on the new main: {pr['title']}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("fix_issue", title, agent.id, "user", issue=issue_id, repo=repo, vm=vm_name, thread=thread, agent_name=agent.name)
        text = (
            f"New job {job['id']}: {title}\n"
            f"Your PR {thread} ({pr['url']}) conflicts with {repo}'s main now: other work was merged first. Make it again on the "
            f"newest main: sync_code, a new branch from origin/HEAD, and your change on top again ({branch} in your folder has "
            "it: cherry-pick your own commits, or redo it by hand), with the conflicts resolved the way the new code wants. Then "
            "as for any fix: the tests on the new main (when: before) and with your change (when: after), the before and after "
            f"pictures again, and draft_pr. Its draft replaces {thread}: once the user opens the new PR, the old one is closed."
        )
        if vm_name is not None:
            text += f"\nIt is for {vm_name}: queue_for_vm when ready."
        self.notify(agent.id, text)

    def remake_pr(self, pr: dict, days: int) -> dict | None:
        """One of the user's PRs that an agent owns had no update on GitHub for days (backend/issues_api.py
        keep_stale_prs): its agent makes it again as a fresh PR, all its changes on the newest base with a clean history
        and a fresh description, as a fix_issue job whose thread is that PR. Its draft replaces the PR, which is closed
        once the new one is on GitHub. pr is pr_tracking's entry. Returns the job, or None when its agent is gone."""
        agent = self.agents.get(pr["agent"])
        if agent is None:
            return None
        self.unarchive(agent.id)
        issue_id = None
        if pr["job"] is not None:
            try:
                issue_id = self.jobs.get(pr["job"])["issue"]
            except KeyError:
                pass
        if issue_id is None and pr["issues"]:
            issue_id = f"{pr['repo']}#{pr['issues'][0]['number']}"
        title = f"Remake #{pr['number']} fresh: {pr['title']}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("fix_issue", title, agent.id, "user", issue=issue_id, repo=pr["repo"], vm=vm_name, thread=pr["id"], agent_name=agent.name)
        text = (
            f"New job {job['id']}: {title}\n"
            f"Your PR {pr['id']} ({pr['url']}) has had no update on GitHub for {days} days: it stalled. Make it again as a "
            "fresh PR with a clean history. read_issue on it first: every review point and comment there must be done in "
            "the new one. Then sync_code, a new branch from the newest default branch, all of its changes on top again "
            "(squashed into one commit, or a few clean ones the way the project's rules want), with every point the "
            "reviewers made done. Then as for any fix: the tests on the newest code (when: before) and with your change "
            "(when: after), the before and after pictures again, and draft_pr: a fresh title and description written to "
            f"the project's rules, with 'Supersedes #{pr['number']}' in it. Its draft replaces {pr['id']}: once the new PR is "
            "on GitHub, the old one is closed."
        )
        if vm_name is not None:
            text += f"\nIt is for {vm_name}: queue_for_vm when ready."
        self.notify(agent.id, text)
        return job

    def give_crashes(self, repo: str, items: list[dict]) -> None:
        """The app's new errors (crashes.py) for the chat agent of the app's own repo (backend/projects_api.py), to turn
        into issues with crash_report."""
        project = self.projects.get(repo)
        if project is None or project["chat"] not in self.agents:
            return
        lines = []
        for item in items:
            line = f"- {item['id']} ({item['source']}, {item['count']} times, last {item['last_at'][:16]}, version {item['version']}): {item['message']}"
            if item["issue"] is not None:
                line += f" [it made #{item['issue']} before, and came back]"
            if item["detail"]:
                line += "\n  " + item["detail"][-1500:].replace("\n", "\n  ")
            lines.append(line)
        text = f"New errors in the app, {len(items)} of them. Deal with each with crash_report, as in The app's errors:\n" + "\n".join(lines)
        self.notify(project["chat"], text)

    def project_changed(self, repo: str, text: str) -> None:
        """What the user changed on a project's Development page (its mode, goals), for its chat agent; it hears with its
        next message, no turn of its own just for this."""
        project = self.projects.get(repo)
        if project is None or project["chat"] not in self.agents:
            return
        agent = self.agents[project["chat"]]
        self.pending[agent.id].append({"from": "System", "text": text, "shown": False})
        self.save(agent)
        self.version += 1

    def issue_decided(self, draft: dict) -> None:
        """The user created one of the agent's issue drafts on GitHub, or discarded it, from its chat. It hears with its
        next message: no turn of its own just for this."""
        agent = self.agents.get(draft["agent"])
        if agent is None:
            return
        text = f"The user discarded your issue draft {draft['id']} ({draft['title']})."
        if draft["status"] == "created":
            text = f"The user created your issue draft {draft['id']} on GitHub: {draft['repo']}#{draft['number']} ({draft['title']}), {draft['url']}."
        self.pending[agent.id].append({"from": "System", "text": text, "shown": False})
        self.save(agent)
        self.version += 1

    def issue_taken(self, issue_id: str, reason: str, assignees: list[str], prs: list[str] | None = None) -> None:
        """The issue went from free to assigned: someone else is on it now. The agent of every open job on it is told
        who, and decides itself whether to stop (TAKEN_ADVICE): the user isn't asked. On an issue our agents opened as the
        user it is told to keep going instead (OURS_ADVICE): we never give one of those up. assignees are their GitHub logins
        (issue_facts.py); without any, the tags' reason says who seems to be on it. Once per job at most: a job told
        before has the notice on its timeline (the only notice the app puts there).
        prs: other people's open pull requests that came to be tied to it since its last read ("owner/name#n by login",
        the tags' open_prs, issue_tags.py: one that says it closes it, or only mentions it). Then the agent is told of
        those (PR_ADVICE), once each, whatever it heard before, whoever is assigned and whether its claim went out:
        DeskcommCRM#4511 only said "Refs #4495", the issue stayed free, and our agent ran five more hours of checks before
        it found the PR at its draft."""
        # Inbox items from before agents decided this themselves: a job with one still pending isn't told as well.
        asked = [draft["job"] for draft in self.inbox.list() if draft["kind"] == "taken" and draft["status"] == "pending"]
        # Assigned to the user is never someone else taking it (often their claim going through). Without the user's
        # sign-in the app can't tell who they are: for a job whose claim the user approved, any assignee counts as them.
        claimed = [draft["job"] for draft in self.inbox.list() if draft["kind"] == "comment" and draft["status"] == "approved"]
        account = self.your_repositories.github_account.status()
        login = None
        if account["connected"]:
            login = account["login"]
        you = login is not None and login.lower() in [name.lower() for name in assignees]
        # reason is the tags' sentence on who has it, then one on its merge ("Merge: ..."); only the first part matters here.
        why = re.split(r"\sMerge: ", reason)[0]
        who = ", ".join(f"@{login}" for login in assignees)
        ours = [f"{action['sent']['repo']}#{action['sent']['number']}".lower() for action in self.inbox.actions() if action["kind"] == "issue"]
        for job in self.jobs.list():
            if job["issue"] != issue_id or job["status"] in ["done", "cancelled"] or job["id"] in asked:
                continue
            if you and not prs:
                continue
            if job["kind"] == "fix_issue" and job["id"] in claimed and (login is None or not assignees) and not prs:
                continue
            if job["agent"] not in self.agents:
                continue
            notices = [entry for entry in job["timeline"] if entry["kind"] == "notice"]
            # Once per job. A pull request tied to it is news of its own: once for each, whatever the job heard before, and
            # it doesn't count as having heard of an assignment.
            told = [entry for entry in notices if not entry["text"].startswith("Someone else's pull request")]
            if told and not prs:
                continue
            fresh = []
            for pr in prs or []:
                if not [entry for entry in notices if pr in entry["text"]]:
                    fresh.append(pr)
            if prs and not fresh:
                continue
            text = f"{issue_id} isn't free anymore on GitHub: someone else seems to be on it. {why}"
            notice = "Someone else seems to be on the issue on GitHub; told the agent"
            if who:
                text = f"{issue_id} isn't free anymore on GitHub: it is assigned to {who}."
                notice = f"Issue was assigned to {who} on GitHub; told the agent"
            advice = TAKEN_ADVICE.format(job=job["id"], repo=job["repo"])
            if fresh:
                text = f"Someone else's open pull request is tied to {issue_id} on GitHub now: {', '.join(fresh)}."
                notice = f"Someone else's pull request {', '.join(fresh)} is tied to the issue on GitHub; told the agent"
                advice = PR_ADVICE.format(job=job["id"])
            if issue_id.lower() in ours:
                advice = OURS_ADVICE.format(job=job["id"])
            text += f" You have {job['id']} ({job['title']}) on it." + advice
            self.jobs.add_timeline(job["id"], "notice", notice)
            self.notify(job["agent"], text)

    def stop_job(self, job_id: str, why: str) -> None:
        """The app no longer wants this job done (backend/issues_api.py: its issue was deleted on GitHub, its repo left
        Repos, or its repo doesn't take AI-made contributions). Its agent is told to stop and cancel it itself, once:
        the notice on its timeline says so."""
        job = self.jobs.get(job_id)
        told = [entry for entry in job["timeline"] if entry["kind"] == "notice" and entry["text"].endswith("told the agent to stop")]
        if told or job["agent"] not in self.agents or job["status"] in ["done", "cancelled"]:
            return
        self.jobs.add_timeline(job_id, "notice", f"{why.rstrip('.')}; told the agent to stop")
        text = (
            f"{why} Stop {job_id} ({job['title']}) now: cancel it with job_update (status cancelled) and a note saying "
            "why, tidy up what you left for it in the VM, and release the VM if nothing else needs it. Draft nothing more "
            "for it."
        )
        self.notify(job["agent"], text)

    def follow_up(self, entry: dict) -> dict | None:
        """Someone else wrote on a PR or issue an agent follows for the user (agent mode Drafts on the GitHub tab), the
        PR's checks failed, or anything else changed on the user's own PR (merged, closed, a push, a conflict, ...): an
        entry of pr_tracking.needs_reply ({"id", "kind", "relation", "state", "title", "url", "agent", "reason", "at",
        "failed_sha", "head", "base", "signals"}; only the user's own open PR, relation author, gets offered a new version
        or a rebase, and only the user's own PR or issue a new title or description). The agent's open follow_up job for
        that thread hears about it; else a new one is made. When an open job of any agent has the PR's next version waiting
        (draft_pr with pr), that job hears it instead: one agent per PR at a time. Returns the job, or None when the agent
        is gone. Any thread."""
        # One agent per PR at a time: when an open job's next version of this PR waits (in review, in the Inbox, or
        # approved and not sent yet), the news goes to that job and its agent, which hold the work, instead of a second
        # agent starting on it (openmed#5511: a follow-up on the PR went to its owner while another agent's version, drafted
        # from a follow-up on its issue, waited, and both drafted one). draft_pr refuses a second one from another job too.
        agent_id = entry["agent"]
        holder_job = None
        for draft in self.inbox.list():
            waiting = draft["status"] == "pending" or (draft["status"] == "approved" and draft["sent"] is None)
            if draft["kind"] != "pr" or not waiting or (draft["update_of"] or "").lower() != entry["id"].lower():
                continue
            if draft["job"] is None or draft["agent"] not in self.agents:
                continue
            open_jobs = [job["id"] for job in self.jobs.for_agent(draft["agent"]) if job["status"] not in ["done", "cancelled"]]
            if draft["job"] in open_jobs:
                agent_id = draft["agent"]
                holder_job = draft["job"]
        agent = self.agents.get(agent_id)
        if agent is None:
            return None
        thread = entry["id"]
        repo = thread.split("#")[0]
        number = thread.split("#")[1]
        head = entry["head"]
        what = "issue"
        if entry["kind"] == "pr":
            what = "PR"
        # A new version goes on the PR's own branch, which only the user's own open PR has (not one they only commented on).
        own = entry.get("relation", "author") == "author"
        ended = entry.get("state", "open") != "open"
        own_pr = entry["kind"] == "pr" and head is not None and own and not ended
        # It comes back from the archive for it, as for a job the user gives it. unarchive() wakes it: on the loop.
        if threading.get_ident() == self.loop_thread:
            self.unarchive(agent.id)
        else:
            self.loop.call_soon_threadsafe(self.unarchive, agent.id)

        for job in self.jobs.for_agent(agent.id):
            if job["status"] in ["done", "cancelled"]:
                continue
            if holder_job is not None and job["id"] != holder_job:
                continue
            if holder_job is None and (job["kind"] != "follow_up" or job["thread"] != thread):
                continue
            text = (
                f"More on {thread} ({entry['title']}) for {job['id']}: {entry['reason']}. Read it again with read_issue and take "
                "it into account: reproduce anything new it reports or asks about in the VM before you act on it."
            )
            if entry["failed_sha"]:
                text += f" Its checks failed on {entry['failed_sha'][:10]}: see which and why on {entry['url']}/checks."
            if own_pr:
                text += (
                    f" Its branch {head['branch']} in {head['repo']} is at {head['sha']} now: a new version goes on top of that "
                    "commit. When it conflicts with the branch it goes into, adding commits doesn't settle that: rebase it "
                    "onto the newest one (with your change, if you have one) and draft_pr with rebase: true."
                )
            if ended:
                text += (
                    f" It is {entry['state']} now, so nothing more goes there: mark {job['id']} done with a note, and tidy up "
                    "what you left for it in a VM (its branch's note)."
                )
            if job["status"] == "waiting_on_user":
                text += " Your draft for it still waits in the user's Inbox; if it no longer fits, draft a new one and say why in it."
            self.notify(agent.id, text)
            return job

        title = f"Follow up on {thread}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("follow_up", title, agent.id, "user", repo=repo, vm=vm_name, thread=thread, agent_name=agent.name)
        text = f"New job {job['id']}: {title}\n{entry['reason']} on the {what} {thread} ({entry['title']}): {entry['url']}"
        # Merged or closed: only its end to take in.
        if ended:
            text += (
                f"\nIt is {entry['state']} now, so nothing more goes there. You own it for the user: read it with read_issue, "
                f"then mark {job['id']} done (job_update) with a note on how it ended, and tidy up what you left for it in a "
                "VM (its branch's note) the next time you hold that VM. If a maintainer asked something on the way out, a short "
                f"reply is still fine: draft_comment with target {thread}."
            )
            self.notify(agent.id, text)
            return job
        # The user's own pull request that is out there waits on it: that comes before new work.
        if own_pr:
            text += (
                "\nThis goes first: before your other jobs (at a good point in the one you are on, e.g. once a run you "
                "started ends). While the pull request needs something from us, you also go ahead in the VM's line."
            )
        if entry["failed_sha"]:
            text += (
                f"\nIts checks failed on {entry['failed_sha'][:10]}: see which and why on its checks page ({entry['url']}/checks, "
                "with browser_open), and reproduce the failure in the VM before you fix it. A failure that isn't the PR's fault "
                "(a flaky test, a broken main branch) needs no new version: a short reply saying so, or nothing."
            )
        text += (
            "\nYou follow it for the user: whatever the project's maintainers and the PR's reviewers write there (a question, a review, a request, a "
            "bug report) or when its checks fail, you do the work it needs yourself and draft it, and the user approves every "
            "push and comment before it goes out (Approve sends it as them). Never ask the user to do any of it by hand: no "
            "push, rebase, conflict or edit for them to do. You never post, push or send anything yourself.\n"
            "Only maintainers and reviewers get answers (read_issue's maintainer: OWNER, MEMBER, COLLABORATOR, or someone who "
            "merges its PRs; and the PR's reviewers, people who reviewed it). Anyone else, even when they ask something, and "
            "every review bot (CodeRabbit, Copilot) get no reply, no thanks and no 'fixed', unless the merge needs one (a CLA bot's sign line, a claim, a bot command or a resolved conversation the project's rules "
            "require). Their code points only when one is a real bug in what the PR changes that a maintainer would send back, "
            "and then silently in the next version, never style, nitpicks, tests they want or corner cases beyond the issue: "
            "a bot reviews every push again and always finds a next one. One comment of ours per round (until someone else "
            "writes): the new version's comment when you push one, else one draft_comment; never both, never one per point.\n"
            "First read the whole thread with read_issue: every comment and review, the mentions, the related PRs and the checks. Then reproduce what it reports or asks about, in the VM, before "
            "you change code or answer: the bug a reviewer saw, the failing check, the conflict with main, whether something "
            "works. Never act on reading alone; add what you saw as evidence. When it doesn't happen, change nothing and say "
            "so in a reply, with what you ran. A reviewer's case is one example of a kind: once it reproduces, find and test "
            "the rest of that kind too (other values, types, inputs, drivers, platforms, the same mistake elsewhere in the PR) "
            "and fix the kind, not the example. Before a new version, go through every point a maintainer or reviewer raised "
            "on the thread and every requirement of the issue again (draft_pr's checklist). Then do one of these (see Following up on PRs and "
            "issues):\n"
            f"- A reply, when a maintainer or reviewer asked something or waits for an answer: draft_comment with target {thread}. Short, "
            "friendly, in the project's tone, the way the user would write it. Never ask them or anyone else for anything, "
            "and never wait for an answer: assume nobody replies. When their point leaves a choice, make it and say what "
            "you did."
        )
        if entry["kind"] == "pr":
            text += (
                "\n- A reviewer's comment on a line of code (a person's, not a bot's): answer it in its conversation, draft_comment with reply_to (the "
                "comment's id from read_issue's conversations), not below the PR, unless the organization doesn't let the app "
                "answer there (draft_comment says so): then in the round's one comment. On the user's own PR, add resolve: true "
                "once the change it asked for is pushed there, when the project wants every conversation resolved before a "
                "merge or lets the author resolve them. A bot's conversation gets no answer."
            )
        if own_pr:
            text += (
                "\n- A new version of the PR, when a maintainer or reviewer asked for changes, its checks failed, or a bot found a real bug "
                "in the change. Its branch is "
                f"{head['branch']} in the user's fork {head['repo']}, newest commit {head['sha']}. In the VM, in the project's "
                f"folder (~/{repo.split('/')[1]}; clone it if it isn't there): `git fetch https://github.com/{head['repo']} "
                f"{head['branch']} && git switch -C pr-{number} {head['sha']}`, and work on top of that commit. Commit your "
                f"change on pr-{number} in the project's style, then run the tests once, with your change: run_tests with "
                f"when: after, base {head['sha']}, and the checks the project's rules ask for before a PR, however long. No "
                "when: before run on the main branch: the PR's first version already had one. Then draft_pr with pr "
                f"{thread} and "
                f"base {head['sha']}: its title is the commit message's subject, its body the comment posted on the PR with "
                "the push (what changed, in a line or two, and your answers to the maintainers and reviewers this round); "
                "leave the body empty when none of them asked for it."
                "\n- A rebase of the PR, when a maintainer asks for one, it conflicts with main, or a reviewer asks to squash, "
                f"reword or sign off its commits. Fetch its branch the same way, then on pr-{number} `git fetch origin && git "
                "rebase origin/<the branch it goes into>` (or rewrite the commits as asked), settle each conflict keeping what "
                "both sides meant, commit, and run the checks the project's rules ask for before a PR, however long: run_tests "
                "with when: after and base the commit your branch now starts from (e.g. origin/main). Then draft_pr with pr "
                f"{thread}, that base and rebase: true; Approve force-pushes it. Its body is the comment posted with the push "
                "(what it is rebased onto, and how each conflict was settled)."
            )
        if own:
            text += (
                f"\n- A new title or description, when someone asks for one on the user's own {what}, or its text no longer "
                f"matches what it does: draft_edit with target {thread}. Approve changes them on GitHub as the user."
            )
        text += (
            f"\n- Nothing, when nothing needs an answer (a thank-you, a bot's note with no findings, checks that passed, a "
            f"label, an approval without questions, anything from someone who is neither a maintainer nor a reviewer, or "
            f"from a bot, that the merge doesn't need), or when only the maintainers or the project's gate can move it on "
            f"(a draft its gate keeps until their label or their OK to run the workflows; no tool of yours marks a PR "
            f"ready for review, changes labels or approves checks): job_update {job['id']} with status done and a note on "
            "why. You own it for the user: you hear about every change there, and a new job comes with the next one."
        )
        if entry["kind"] == "pr" and not own_pr:
            text += "\nThe PR's code isn't the user's to change: a reply or nothing."
        # The user's own words there are ours, not someone else's to answer or step aside for (QwenPaw#8698).
        login = self.your_repositories.github_account.status().get("login")
        if login:
            text += (
                f"\nThe user's GitHub login is {login}: whatever {login} wrote there is ours (read_issue marks it by_user): "
                "never answer it, and never take it for someone else."
            )
        if vm_name is None:
            text += (
                "\nYou have no target VM. Reproducing and a new version need one: pick it with vms_list and choose_vm, then "
                "queue_for_vm. Only a reply with nothing to reproduce (a thank-you, a question about plans) needs none."
            )
        else:
            text += (
                f"\nIt is for {vm_name}: queue_for_vm to reproduce and for a new version. Only a reply with nothing to reproduce "
                "(a thank-you, a question about plans) needs no VM."
            )
        self.notify(agent.id, text)
        return job

    def decide(self, draft_id: str, decision: str, reply: str = "", answered_by: str = "user") -> dict:
        """The user's decision on a draft (approved, rejected or replied) goes to its agent, and its job is open again,
        unless another draft of it still waits (a PR draft with its reviewer or in the Inbox, a question). answered_by is
        "timer" when the app answers a timed question with the agent's recommendation (answer_questions), "automation"
        when the repo's or issue's Level of automation does, at once (backend/repo_automation_api.py)."""
        if decision == "replied" and self.inbox.get(draft_id)["kind"] == "taken":
            raise ValueError("Keep working or stop the agent; this one takes no reply")
        draft = self.inbox.decide(draft_id, decision, reply, answered_by)
        job = None
        if draft["job"] is not None:
            job = self.jobs.get(draft["job"])

        # An Inbox item from before agents decided this themselves (issue_taken): whether the agent keeps working on an
        # issue someone else took. approved: keep working, rejected: stop. A job that ended in the meantime has nothing
        # left to decide.
        if draft["kind"] == "taken":
            if job is None or job["status"] in ["done", "cancelled"]:
                return draft
            note = ""
            if reply:
                note = f" Their note: {reply}"
            # Waiting on the maintainers, from when an approved claim held its job up: it goes on without the assignment.
            waited = job["status"] == "waiting_on_maintainers"
            if decision == "approved" and waited:
                self.jobs.update(job["id"], status="queued")
                self.notify(draft["agent"], f"{draft['target']} was assigned to someone else, but the user wants you to go on with {job['id']} without being assigned. It is queued again.{note}")
                return draft
            if decision == "approved":
                self.notify(draft["agent"], f"{draft['target']} isn't free anymore on GitHub, but the user wants you to keep working on {job['id']}.{note}")
                return draft
            was_working = job["status"] == "working"
            self.jobs.add_timeline(job["id"], "status", "Stopped by you")
            self.jobs.update(job["id"], status="cancelled")
            self.notify(draft["agent"], f"{draft['target']} isn't free anymore on GitHub, so the user cancelled {job['id']}. Stop working on it and go on with your other jobs.{note}")
            # Busy with that job right now: its turn stops, and so does what it still runs in the VM.
            agent = self.agents.get(draft["agent"])
            if agent is not None and agent.busy and was_working:
                self.loop.create_task(agent.interrupt())
                vm_name, place = self.queue.place(agent.id)
                if place == 0:
                    self.loop.create_task(asyncio.to_thread(agent.computer_tools.cancel, vm_name))
            return draft

        # A fix_issue job's one comment is its claim (WorkTools.draft_comment). It never held the job up, so deciding it
        # leaves the job as it is (it may wait on the user for its PR by now).
        claim = draft["kind"] == "comment" and job is not None and job["kind"] == "fix_issue"
        # Another draft of the job still waits (a PR draft with its reviewer or in the Inbox, a question): the job keeps
        # waiting on the user until that one is decided too (openmed#5511: an approved new description put the job back
        # in the queue while its PR draft was still with the reviewer, so the heartbeat and the VM's reminders woke it
        # over and over, and job_progress made it working). A claim waits for nothing.
        others = []
        if job is not None:
            for other_id in job["drafts"]:
                try:
                    other = self.inbox.get(other_id)
                except KeyError:
                    # Deleted from the Inbox.
                    continue
                if other_id != draft_id and other["status"] == "pending" and not (other["kind"] == "comment" and job["kind"] == "fix_issue"):
                    others.append(other_id)
        if job is not None and job["status"] == "waiting_on_user" and not claim and not others:
            job = self.jobs.update(job["id"], status="queued")

        kinds = {"pr": "PR", "comment": "comment", "question": "question", "report": "report", "edit": "title and description"}
        about = f"your {kinds.get(draft['kind'], draft['kind'])} draft {draft_id} ({draft['title']})"
        job_name = job["id"] if job is not None else "your work"
        # Approve sends a PR or comment first when the user's GitHub account is connected (inbox_api.py): then it is on GitHub.
        sent = draft["sent"]
        # A new version of the user's open PR (update_of): pushed onto its branch, and the body posted there as a comment.
        if decision == "approved" and draft["kind"] == "pr" and sent is not None and sent.get("update"):
            text = (
                f"The user approved {about}, and it is pushed onto their PR {sent['url']} (branch {sent['branch']} of "
                f"{sent['fork']}, now at {sent['commit'][:10]})."
            )
            if sent.get("rebase_of"):
                text = (
                    f"The user approved {about}, and it is force-pushed onto their PR {sent['url']}: branch {sent['branch']} of "
                    f"{sent['fork']} is now your rebased commits, at {sent['commit'][:10]}, instead of {sent['rebase_of'][:10]}."
                )
            if sent["comment_url"]:
                text += f" Your text is posted there as their comment: {sent['comment_url']}."
            if sent["comment_error"]:
                text += f" The comment couldn't be posted ({sent['comment_error']}); tell the user in one line."
            text += f" Put the link in the job's notes. If it finishes {job_name}, mark the job done with job_update."
        elif decision == "approved" and draft["kind"] == "pr" and sent is not None:
            text = (
                f"The user approved {about}, and it is on GitHub now, as their PR: {sent['url']} (branch {sent['branch']} of "
                f"{sent['fork']}). Put the link in the job's notes. If it finishes {job_name}, mark the job done with job_update."
            )
        elif decision == "approved" and draft["kind"] == "pr" and draft["update_of"]:
            text = f"The user approved {about}. They push it onto {draft['update_of']} themselves. If it finishes {job_name}, mark the job done with job_update."
            if draft["rebase_of"]:
                text = f"The user approved {about}. They force-push it onto {draft['update_of']} themselves. If it finishes {job_name}, mark the job done with job_update."
        elif decision == "approved" and draft["kind"] == "pr":
            text = f"The user approved {about}. They send it to GitHub themselves. If it finishes {job_name}, mark the job done with job_update."
        elif decision == "approved" and draft["kind"] == "edit" and sent is not None:
            text = f"The user approved {about}, and {sent['repo']}#{sent['number']} has the new text on GitHub now: {sent['url']}. Carry on with {job_name}."
        elif decision == "approved" and draft["kind"] == "edit":
            text = f"The user approved {about}. They change it on GitHub themselves. Carry on with {job_name}."
        elif decision == "approved" and claim and sent is not None:
            text = (
                f"The user approved {about}, and it is posted: {sent['url']}. Nothing else to do for it: nobody waits for the "
                f"maintainers to assign the user, so {job_name} goes on as it is."
            )
        elif decision == "approved" and claim:
            text = (
                f"The user approved {about}. They post it themselves. Nothing else to do for it: nobody waits for the "
                f"maintainers to assign the user, so {job_name} goes on as it is."
            )
        elif decision == "approved" and draft["kind"] == "comment" and sent is not None:
            text = f"The user approved {about}, and it is posted: {sent['url']}."
            if sent.get("resolved"):
                text += " Its conversation is resolved now."
            if sent.get("resolve_error"):
                text += f" Its conversation couldn't be resolved ({sent['resolve_error']}); tell the user in one line."
            text += f" Carry on with {job_name}."
        elif decision == "approved" and draft["kind"] == "comment":
            text = f"The user approved {about}. They post it themselves. Carry on with {job_name}."
        elif decision == "approved" and draft["kind"] == "report":
            text = f"The user approved {about}. It finishes {job_name}: mark the job done with job_update."
        elif decision == "approved":
            text = f"The user approved {about}. Carry on with {job_name}."
        elif decision == "rejected" and claim:
            text = f"The user rejected {about}: no claim."
            if reply:
                text += f" Their note: {reply}"
            text += f" Go on with {job_name} without one, unless their note says otherwise."
        elif decision == "rejected":
            text = f"The user rejected {about}."
            if reply:
                text += f" Their note: {reply}"
            text += f" Don't draft it again as it is: change course, or cancel {job_name} with job_update if it no longer makes sense. Ask with draft_question if unsure."
        elif answered_by == "automation":
            # Its repo's (or issue's) Level of automation answers questions at once (backend/repo_automation_api.py).
            text = (
                f"The user lets the app answer questions there for them, so it picked your recommendation for {about}: "
                f"{draft['recommended']}. Go on with that on {job_name}, and say in its progress that you did."
            )
        elif answered_by == "timer":
            # A timed question nobody answered: its deadline was set when it was asked (inbox.py answer_by).
            timer = datetime.fromisoformat(draft["answer_by"]) - datetime.fromisoformat(draft["created_at"])
            minutes = round(timer.total_seconds() / 60)
            text = (
                f"The user didn't answer {about} within {minutes} minutes, so the app picked your recommendation: "
                f"{draft['recommended']}. Go on with that on {job_name}, and say in its progress that you did."
            )
        else:
            text = f"The user replied to {about}:\n{reply}\nDo what they say and keep working on {job_name}; draft again when it's ready."
            # The user wants work done: an archived agent comes back for it.
            if draft["agent"] in self.agents:
                self.unarchive(draft["agent"])
        # A follow-up's reply that went out often answers everything there was.
        if decision == "approved" and draft["kind"] == "comment" and job is not None and job["kind"] == "follow_up":
            text += f" If that answers everything on {job['thread']} for now, mark {job['id']} done; the app makes a new job when someone writes there again."
        # The user changed the text before deciding: the agent sees how they wanted it, to write it that way next time.
        if draft["edited"]:
            final = draft["body"]
            if draft["kind"] in ["pr", "edit"]:
                final = f"{draft['title']}\n\n{draft['body']}"
            text += f"\nThe user edited your draft before deciding. The final text:\n{final}\nSee what they changed, and write it their way next time."
        # An agent that kept its desktop through a short timed question (the VM rule in work) goes on there at once.
        held_vm, place = self.queue.place(draft["agent"])
        if job is not None and job["status"] == "queued" and job["vm"] is not None and held_vm == job["vm"] and place == 0:
            text += f"\n{job['id']} is queued again, and you still hold your desktop of {job['vm']}: go on with it there now."
        elif job is not None and job["status"] == "queued" and job["vm"] is not None:
            text += f"\n{job['id']} is queued again; use queue_for_vm if you need {job['vm']} for it."
        if job is not None and job["status"] == "waiting_on_user" and others:
            text += (
                f"\n{job['id']} still waits on your other draft {', '.join(others)}: nothing to do for it until that one is "
                "decided (you hear it then). Go on with your other jobs."
            )
        self.notify(draft["agent"], text)
        return draft

    def on_grant(self, vm_name: str, agent_id: str) -> None:
        """The VM queue made the agent the holder (its turn came, or the user gave it the VM). Any thread.

        An agent with nothing left to do there (its jobs were cancelled or finished while it waited)
        passes the VM on at once: it never holds a VM with nothing to do, even while busy with other work.
        """
        if threading.get_ident() != self.loop_thread:
            self.loop.call_soon_threadsafe(self.on_grant, vm_name, agent_id)
            return
        agent = self.agents.get(agent_id)
        if agent is None:
            return
        jobs = [job for job in self.jobs.for_agent(agent_id) if job["status"] in OPEN_STATUSES and job["vm"] == vm_name]
        if jobs:
            titles = ", ".join(f"{job['id']} ({job['title']})" for job in jobs)
            # Its notes come with it, so the agent always knows what earlier agents left in it.
            try:
                vm_record = self.vms.get(vm_name)
                notes = vm_record.notes
                desktop = vm_record.holding(agent_id)
            except VMsError:
                notes = []
                desktop = None
            text = f"Desktop {desktop} of {vm_name} is yours now. Your open jobs for it: {titles}. Do them all, then release_vm."
            # Commits are made as the user, the way they go out (github_account.py): draft_pr refuses any other address.
            account = self.your_repositories.github_account.load()
            if account is not None:
                text += (
                    f"\nCommit as the user, with their GitHub name and noreply address: `git config --global user.name "
                    f"\"{account['name']}\" && git config --global user.email \"{account['id']}+{account['login']}@users.noreply.github.com\"` "
                    "(a repo's own git config wins over it, so fix that too where one is set). Never another address, and never "
                    "the email address in your own context: it is private."
                )
            # In full only the notes for the repos of its open jobs here and the VM-wide ones (the user's, and those naming
            # no repo any job was for); the other repos only by name. All of vm1's 108 notes made this 53,000 characters,
            # and agents missed the git identity above under them.
            known = set(job["repo"].lower() for job in self.jobs.list() if job["repo"])
            own = set(job["repo"].lower() for job in jobs if job["repo"])
            shown = []
            others = set()
            for note in notes:
                # The repos it names, as owner/name (vm_note_add asks for that).
                named = set(name.rstrip(".") for name in re.findall(r"[\w.-]+/[\w.-]+", note["text"].lower()))
                if note["by"] != "user" and named & known and not named & own:
                    others.update(named & known)
                    continue
                shown.append(note)
            if shown:
                text += "\nIts notes for your jobs' repos and the whole VM (check what is really there before you rely on them):"
            for note in shown:
                by = self.agents[note["by"]].name if note["by"] in self.agents else note["by"]
                on = f", on desktop {note['desktop']}" if "desktop" in note else ""
                text += f"\n- {note['id']} by {by}, {note['at'][:10]}{on}: {note['text']}"
            if others:
                text += "\nOther repos with notes here (vms_list with repo shows a repo's notes): " + ", ".join(sorted(others)) + "."
            if not notes:
                text += "\nIt has no notes yet: nobody wrote down what is set up in it."
            self.notify(agent_id, text)
            return
        agent.history.append({"type": "system", "text": f"Passed {vm_name} on: no open jobs for it", "time": datetime.now(UTC).isoformat()})
        self.version += 1
        try:
            self.queue.release(vm_name, agent_id)
        except (ValueError, VMsError):
            # The user took it, or deleted the VM, in the meantime.
            pass

    async def keep_going(self) -> None:
        """The heartbeat (module docstring), every HEARTBEAT_CHECK_SECONDS: an agent with a job queued or working, out of
        its turn for HEARTBEAT_SECONDS, is woken to carry on, unless it waits in a VM's line, a run of its goes, the user
        stopped it, or it is archived. A job waiting on the user isn't open work here: the user's answer wakes it. Nor is
        one with a draft that still waits (a PR draft with its reviewer or in the Inbox, a question), whatever its status
        says: the reviewer's verdict or the user's decision wakes it. A fix_issue job's claim holds nothing up."""
        while True:
            await asyncio.sleep(HEARTBEAT_CHECK_SECONDS)
            now = datetime.now(UTC)
            running = []
            for vm_record in self.vms.list():
                running += [run["agent"] for run in vm_record.runs]
            # The open jobs with a draft that still waits (openmed#5511: woken again and again while its PR draft was with
            # the reviewer; itsaplan#826: while its question waited for the user, after the agent set the job working).
            waiting = []
            for job in self.jobs.list():
                if job["status"] not in OPEN_STATUSES:
                    continue
                for draft_id in job["drafts"]:
                    try:
                        draft = self.inbox.get(draft_id)
                    except KeyError:
                        # Deleted from the Inbox.
                        continue
                    if draft["status"] == "pending" and not (draft["kind"] == "comment" and job["kind"] == "fix_issue"):
                        waiting.append(job["id"])
            for agent in list(self.agents.values()):
                if agent.record["archived_at"] is not None or agent.busy or agent.stopped or self.wake[agent.id].is_set():
                    continue
                open_jobs = [job for job in self.jobs.for_agent(agent.id) if job["status"] in OPEN_STATUSES and job["id"] not in waiting]
                # A run of its goes: watch_runs wakes it when it ends.
                if not open_jobs or agent.id in running:
                    continue
                # Its place in a VM's line: the grant wakes it.
                vm_name, place = self.queue.place(agent.id)
                if place is not None and place > 0:
                    continue
                # Out of its turn long enough.
                times = [entry["time"] for entry in agent.history[-500:] if entry.get("time")]
                if times and now - datetime.fromisoformat(times[-1]) < timedelta(seconds=HEARTBEAT_SECONDS):
                    continue
                titles = ", ".join(f"{job['id']} ({job['title']})" for job in open_jobs)
                text = (
                    f"Heartbeat: you have open jobs and nothing is running: {titles}. Carry on with them now, from where you "
                    "left off (queue_for_vm when you need the VM). Don't stop or wait without a reason. When one is truly "
                    "blocked on something only the user can give, ask with draft_question; when it can't be done, cancel it "
                    "with job_update and say why. A blocker in the app you reported may be fixed by now: try again first."
                )
                self.pending[agent.id].append({"from": "System", "text": text, "shown": False})
                self.wake[agent.id].set()

    async def watch_room(self) -> None:
        """A VM steps down when it runs out of room (module docstring), every ROOM_CHECK_SECONDS: each running VM's load,
        free memory and free disk are read in it. Full: nobody new gets a desktop (VMQueue.full, with why). Overloaded: one
        desktop is taken back from its agent and removed. Low on disk: its holders are told once to free room in their
        homes. Room again: whoever waits gets a desktop, one a check."""
        while True:
            await asyncio.sleep(ROOM_CHECK_SECONDS)
            for vm_record in self.vms.list():
                if vm_record.status != "running":
                    self.queue.full.pop(vm_record.name, None)
                    self.disk_low.discard(vm_record.name)
                    continue
                # The load of the last 1 and 5 minutes, the number of CPUs, the memory in all and free (kB), then the disk
                # the desktops' homes are on, in all and free (kB).
                script = (
                    "cut -d ' ' -f 1,2 /proc/loadavg; nproc; awk '/^MemTotal:|^MemAvailable:/ {print $2}' /proc/meminfo; "
                    "df -Pk /home | awk 'NR == 2 {print $2, $4}'"
                )
                try:
                    result = await asyncio.to_thread(vm_record.vm.exec_root, script, 30)
                    numbers = result.stdout.split()
                    load = float(numbers[0])
                    load_5 = float(numbers[1])
                    cpus = int(numbers[2])
                    free = int(numbers[4]) * 100 / int(numbers[3])
                    disk_gb = int(numbers[5]) / 1024 / 1024
                    disk_free_gb = int(numbers[6]) / 1024 / 1024
                except Exception:
                    # The VM doesn't answer right now: look again next time.
                    continue

                # The disk running low: the agents holding its desktops are told once, to free what they can in their own
                # homes now (nobody else can: each home is its desktop's). vm1's disk sat at 98 to 100% for days, full of
                # agents' old clones and caches, and broke 2-hour test runs (ENOSPC, SQLITE_FULL: prb_69d8c4, prb_c4dd4b).
                # Only the agents holding its desktops can free it, so with nobody on it a low disk holds nobody back:
                # otherwise nobody would ever get in to free it. The next one in is told at the next check.
                holders = [line["holder"] for line in vm_record.desktops.values() if line["holder"] in self.agents]
                disk_short = disk_free_gb < ROOM_DISK_GB and len(holders) > 0
                if disk_free_gb >= ROOM_DISK_GB:
                    self.disk_low.discard(vm_record.name)
                if disk_short and vm_record.name not in self.disk_low:
                    self.disk_low.add(vm_record.name)
                    text = (
                        f"{vm_record.name}'s disk is nearly full: {disk_free_gb:.1f} GB free of {disk_gb:.0f} GB. Nobody new "
                        f"gets a desktop there until {ROOM_DISK_GB} GB are free, and runs fail for lack of room. Free what you "
                        "can in your own home now, then go on: the folders of jobs that are over (a PR merged or closed, a job "
                        "cancelled, or a repo vms_list marks with no open job: the clone, its builds and environments), with "
                        "their notes (vm_note_remove), and caches that fill again by themselves (~/.cache/pip, ~/.cache/uv, "
                        "~/.npm/_cacache, ~/.local/share/pnpm/store, ~/.cache/go-build, ~/.cargo/registry/cache). Never "
                        "another desktop's home, a folder a run works in, ~/.cache/sandbox-runs (the app's), Docker's images, "
                        "or an app a set_up_repo job left running for the user."
                    )
                    for holder in holders:
                        self.notify(holder, text)

                if load < cpus and free >= ROOM_MEMORY_PERCENT and not disk_short:
                    self.queue.full.pop(vm_record.name, None)
                    # Room: a free desktop goes to whoever waits.
                    try:
                        await asyncio.to_thread(self.queue.fill, vm_record.name)
                    except VMsError:
                        continue
                    # Then a desktop the VM lacks is added for the first one waiting for it (taken back from it) or for
                    # any desktop, up to the VM's max desktops.
                    add = False
                    number = None
                    for agent_id in list(vm_record.queue):
                        wanted = vm_record.wants.get(agent_id)
                        if not add and (wanted is None or wanted not in vm_record.desktops):
                            add = True
                            number = wanted
                    if not add or len(vm_record.desktops) >= vm_record.max_desktops:
                        continue
                    try:
                        await asyncio.to_thread(vm_record.add_desktop, self.queue.lock, number)
                        await asyncio.to_thread(self.queue.fill, vm_record.name)
                    except VMsError:
                        # The VM is busy (a start, a stop, another desktop) or gone: again next time.
                        pass
                    continue

                # Full, with why, for the agents that wait (queue_for_vm, desktop_add). A full disk alone takes no desktop
                # back: that frees no room.
                why = []
                if load >= cpus:
                    why.append(f"a load of {load:g} on {cpus} CPUs")
                if free < ROOM_MEMORY_PERCENT:
                    why.append(f"{free:.0f}% of its memory free")
                if disk_short:
                    why.append(f"{disk_free_gb:.1f} GB of its disk free")
                self.queue.full[vm_record.name] = ", ".join(why)
                if load_5 < cpus * OVERLOAD_TIMES and free >= OVERLOAD_MEMORY_PERCENT:
                    continue
                last = vm_record.stepped_down_at
                if last is not None and datetime.now(UTC) - datetime.fromisoformat(last) < timedelta(seconds=STEP_DOWN_SECONDS):
                    continue
                if len(vm_record.desktops) < 2:
                    continue
                # Overloaded: a desktop is taken back. Never from an agent the user gave priority; from one on a pull
                # request that needs action only when nobody else is left, from one reviewing a PR draft only when
                # nobody but those is. From one out of its turn first (nothing is cut off), then from the highest desktop.
                chosen = None
                for line in vm_record.desktops.values():
                    agent = self.agents.get(line["holder"])
                    if agent is None or agent.id in self.queue.prioritized or agent.id in self.queue.reviewing:
                        continue
                    if chosen is None or chosen.busy or not agent.busy:
                        chosen = agent
                reviewer = None
                for line in vm_record.desktops.values():
                    agent = self.agents.get(line["holder"])
                    if agent is None or agent.id in self.queue.prioritized:
                        continue
                    if reviewer is None or reviewer.busy or not agent.busy:
                        reviewer = agent
                fallback = None
                for line in vm_record.desktops.values():
                    agent = self.agents.get(line["holder"])
                    if agent is None or agent.record["priority"]:
                        continue
                    if fallback is None or fallback.busy or not agent.busy:
                        fallback = agent
                if chosen is None:
                    chosen = reviewer
                if chosen is None:
                    chosen = fallback
                if chosen is None:
                    continue
                try:
                    number = self.queue.step_down(vm_record.name, chosen.id)
                except (ValueError, VMsError):
                    continue
                text = (
                    f"{vm_record.name} ran out of room (a load of {load_5:g} on {cpus} CPUs, {free:.0f}% of its memory free), so "
                    f"the app took desktop {number} back for now. Nothing you started there was stopped: your runs, servers and "
                    "files are all still there. You are at the front of its queue (behind the work that goes first) and get the "
                    "desktop back, with a message, once there is room. End your turn now."
                )
                chosen.history.append({"type": "system", "text": text, "time": datetime.now(UTC).isoformat()})
                # It hears it with its next message (the one giving the desktop back), or now if it is in a turn: the turn
                # stops, since its VM tools refuse without a desktop.
                self.pending[chosen.id].append({"from": "System", "text": text, "shown": True})
                self.save(chosen)
                self.version += 1
                await chosen.interrupt()
                try:
                    await asyncio.to_thread(vm_record.remove_desktop, number, self.queue.lock, True)
                except VMsError:
                    # The VM is busy: the desktop stays, free, until its agent gets it back.
                    pass

    async def answer_questions(self) -> None:
        """Every QUESTION_CHECK_SECONDS: a timed question (inbox.py) still pending after its answer_by is answered with
        the agent's recommendation, as the reply "I pick: ..." with answered_by "timer". The deadline is in the draft,
        so a backend restart doesn't move it."""
        while True:
            await asyncio.sleep(QUESTION_CHECK_SECONDS)
            now = datetime.now(UTC)
            for draft in self.inbox.list():
                if draft["kind"] != "question" or draft["status"] != "pending" or draft["answer_by"] is None:
                    continue
                if datetime.fromisoformat(draft["answer_by"]) > now:
                    continue
                try:
                    self.decide(draft["id"], "replied", f"I pick: {draft['recommended']}", answered_by="timer")
                except (KeyError, ValueError):
                    # The user decided it, or deleted it, in the meantime.
                    continue

    async def watch_runs(self) -> None:
        """Every RUN_CHECK_SECONDS: the runs no tool call waits for. One that ended goes to its agent (run_ended).
        Then priority: it ends for an agent whose tasks are over, and each running VM gets it set again when its runs,
        its desktops' holders or who has priority changed (long_runs.prioritize)."""
        while True:
            await asyncio.sleep(RUN_CHECK_SECONDS)
            runs = []
            for vm_record in self.vms.list():
                runs += [(vm_record, run) for run in vm_record.runs if run["background"]]
            for vm_record, run in runs:
                try:
                    ended = await asyncio.to_thread(long_runs.check, vm_record, run)
                except Exception:
                    # The VM doesn't answer right now: look again next time.
                    continue
                if ended is None or not self.queue.claim_run(run["id"]):
                    continue
                try:
                    await self.run_ended(vm_record, run, ended)
                except Exception as error:
                    # Never lose the run: it is gone from the VM either way, and the agent hears why.
                    self.notify(run["agent"], f"Your run {run['id']} in {vm_record.name} ended, but its result couldn't be read: {error}")
                try:
                    self.queue.finish_run(vm_record.name, run["id"])
                except VMsError:
                    # The VM was deleted meanwhile.
                    pass

            # Tasks over: no open job, no run going and no turn.
            running = []
            for vm_record in self.vms.list():
                running += [run["agent"] for run in vm_record.runs]
            for agent in list(self.agents.values()):
                if not agent.record["priority"] or agent.busy or agent.id in running:
                    continue
                if [job for job in self.jobs.for_agent(agent.id) if job["status"] in OPEN_STATUSES]:
                    continue
                agent.record["priority"] = False
                if agent.id not in self.pr_priority:
                    self.queue.prioritized.discard(agent.id)
                agent.history.append({"type": "system", "text": "Priority ended: its tasks are over", "time": datetime.now(UTC).isoformat()})
                self.save(agent)
                self.version += 1

            for vm_record in self.vms.list():
                if vm_record.status != "running":
                    # Set again once it runs: a restart starts it over.
                    self.priority_set.pop(vm_record.name, None)
                    continue
                state = [[run["id"], run["agent"] in self.queue.prioritized] for run in vm_record.runs]
                state += [[number, line["holder"] in self.queue.prioritized] for number, line in vm_record.desktops.items()]
                if self.priority_set.get(vm_record.name) == state:
                    continue
                try:
                    await asyncio.to_thread(long_runs.prioritize, vm_record, set(self.queue.prioritized))
                except Exception:
                    # The VM doesn't answer right now: again next time.
                    continue
                self.priority_set[vm_record.name] = state

    async def run_ended(self, vm_record, run: dict, ended: dict) -> None:
        """A run in the background ended: its agent gets the result. One that waits in a VM's line (its desktop was taken
        back from a full VM, or the user took it) gets it with the message that a desktop is its again (finish_run,
        right after this, may give it one at once), so it starts one turn with both; any other agent is woken now."""
        agent = self.agents.get(run["agent"])
        if agent is None:
            return
        if run["kind"] == "tests":
            answer = await agent.work_tools.finish_tests(vm_record, run, ended)
            text = f"Your test run {run['id']} for {run['job']} ended. " + answer["content"][0]["text"]
        else:
            text = f"Your run {run['id']} in {vm_record.name} ended: `{run['label'][:200]}`, " + agent.computer_tools.bash_result(vm_record, run, ended)
        agent.history.append({"type": "system", "text": f"Its run in {vm_record.name} ended: {run['label'][:120]}", "time": datetime.now(UTC).isoformat()})
        vm_name, place = self.queue.place(agent.id)
        if place is None or place == 0:
            self.notify(agent.id, text)
            return
        text += f"\nYou get a desktop of {vm_name} back, with a message, as soon as one is yours; until then end your turn."
        self.pending[agent.id].append({"from": "System", "text": text, "shown": False})
        self.save(agent)
        self.version += 1

    async def stop_runs(self, agent_id: str) -> None:
        """The agent was archived or deleted: its runs end too (watch_runs then takes them off their VMs)."""
        self.queue.to_background(agent_id)
        for vm_record in self.vms.list():
            for run in [run for run in vm_record.runs if run["agent"] == agent_id]:
                try:
                    await asyncio.to_thread(long_runs.stop, vm_record, run)
                except Exception:
                    # The VM is off or doesn't answer: the run isn't going there then.
                    pass

    def on_kick(self, vm_name: str, agent_id: str, reason: str) -> None:
        """The user took the VM or the agent's queue place away. It is interrupted, not woken. Any thread."""
        if threading.get_ident() != self.loop_thread:
            self.loop.call_soon_threadsafe(self.on_kick, vm_name, agent_id, reason)
            return
        agent = self.agents.get(agent_id)
        if agent is None:
            return
        agent.history.append({"type": "system", "text": reason, "time": datetime.now(UTC).isoformat()})
        # It hears about it with its next message.
        self.pending[agent_id].append({"from": "System", "text": reason, "shown": True})
        self.version += 1
        self.loop.create_task(agent.interrupt())
        # Its commands still running in the VM (a long bash, typing) would go on under the new holder.
        self.loop.create_task(asyncio.to_thread(agent.computer_tools.cancel, vm_name))
