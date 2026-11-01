"""All agents: their worker loops, and the rules that tie them to jobs, the VM queue and the Inbox.

Each agent (agent/agent.py) is one Claude conversation with a record on disk,
DATA_DIR/agents/<id>.json:

    {"id": "agent_a1b2c3", "name": "agent-1", "target_vm": "vm1" | null, "claude_session_id",
     "history": [HistoryEntry, ...], "context_used", "context_max", "cost_usd", "created_at",
     "pending": [message, ...], "awake": bool, "archived_at": null | when it was archived,
     "name_by": "auto" | "user" | "agent"}

name_by says who gave the name. An agent made without one gets the first free "agent-N" (auto); while it
has that, it may name itself once, for the work it does (WorkTools.name_yourself), and the app tells it so
with its first message or job. A name the user gave (user) is never changed by the agent, and one it gave
itself (agent) stays too; the user can always rename it.

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
change) doesn't lose them. An agent that was in a turn or about to start one (awake) is woken
with them after the restart; one cut off in the middle of a turn gets one more saying so.

After each turn the worker enforces the VM rule: an agent never holds a VM it has nothing to do in.
- Holding a VM with no queued or working job for it: the VM is released for it.
- Holding one while only its run goes there (a test suite or build it left going, sandbox/agent/long_runs.py): it
  steps aside (VMQueue.step_aside). The next one gets the VM, and the agent waits in the VM's priority line, which
  comes before its waiting line: it gets the VM back as soon as its run is over and the VM is free.
- Holding one with open jobs there: it is reminded to go on with them now, not to wait for an answer in chat. After
  MAX_NUDGES reminders in a row with no change to its jobs, the VM is released for it.
- In no queue but with queued jobs for a VM: it is reminded to queue_for_vm (MAX_NUDGES times at most).
The VM queue (sandbox/vm_queue.py: one line per desktop of each VM, and agents on different desktops work at
the same time) tells Agents when an agent's turn comes (on_grant: a message
that wakes it, with the VM's notes on what earlier agents set up in it, or the VM passes on at once
if it has no open jobs there anymore) and when the
user took the VM or its place away (on_kick: it is interrupted, and what it still ran in that
VM is killed, except its runs).

Runs nobody waits for anymore (the agent's turn ended, or the backend restarted) are checked every
RUN_CHECK_SECONDS (watch_runs). When one ends, its agent gets the result (bash: ComputerTools.bash_result; tests:
WorkTools.finish_tests, which keeps it on the job). An agent in that VM's priority line gets it together with the
message that the VM is its again; any other agent right away. Archiving or deleting an agent stops its runs.

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

The GitHub tab's side: follow_up() is called when someone else wrote on a PR or issue of the user's that an
agent follows (agent mode Drafts), or the PR's checks failed (pr_tracking.needs_reply). The agent gets a
follow_up job for that thread (an open one it has for it hears the news instead), and an archived agent comes
back for it. It reads the thread and suggests a reply (draft_comment), a new version of the user's own PR made
on that PR's branch (draft_pr with pr: Approve pushes it there and posts its text on the PR as a comment), or
nothing (it marks the job done). It never posts anything itself.

A repository's agent (the Workspace tab's Live, frontend/src/RepoLive.tsx) belongs to one of the user's own
repositories for good: its record's "repo" is that repo, and "live" how far its set-up is:

    "repo": "owner/name" | None, "live": {"state": "preparing" | "ready" | "failed", "error": why it failed | None} | None

set_up_live() makes it, aimed at the repo's own new VM (backend/repo_live_api.py makes the VM). prepare_live() then
waits for the VM, clones the repo here with the user's sign-in (your_repositories.clone) and copies it into desktop 1's
home, so the VM never gets a token, also for a private repo; then the agent gets a set_up_repo job for desktop 1, the
desktop the Live tab shows. A failure stays in "live" with why, and the Live tab's Try again runs it again
(retry_live). It reads its repo with its own tools (agent/repo_tools.py) and, when the user asks for a change, drafts
an issue (issue_drafts.py) instead of making it; issue_decided() tells it whether the user created or discarded it.

When an issue an agent has a job for goes from free to assigned (someone else is on it now: the
tags say so, backend/issues_api.py), issue_taken() asks the user in the Inbox ("taken", one pending
per job): Keep working tells the agent to go on; Stop the agent cancels the job, and when the agent
is busy with it right now, stops its turn and what it runs in the VM. The agent itself never stops
for it on its own.

Everything here runs in the backend's event loop. notify() and the queue callbacks may be called
from request threads, so they hand their work to the loop. version goes up on every change the
agent list shows (status, history, context, queue), for the live feed.

    agents = Agents(repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues, ..., artifacts, your_repositories, issue_drafts)
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
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher import search
from github_searcher.agent.agent import Agent
from github_searcher.agent.work_tools import WorkTools
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
OPEN_STATUSES = ["queued", "working"]
# A repository's new VM is waited for this long (it takes about a minute), and looked at this often meanwhile.
LIVE_WAIT_SECONDS = 15 * 60
LIVE_CHECK_SECONDS = 5


class Agents:
    def __init__(self, repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues, repo_signals, issue_tags, explore, artifacts, your_repositories, issue_drafts):
        self.repos = repos
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
        # level, kind.
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
        self.loop = None
        self.loop_thread = None
        self.saver = None
        self.run_watcher = None
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
            # partial, not a lambda: the target VM is read from this record each time, not from the loop variable.
            computer_tools = ComputerTools(self.vms, self.queue, record["id"], functools.partial(record.get, "target_vm"), record["history"])
            agent = Agent(record, computer_tools, WorkTools(self, record), self.changed)
            self.agents[agent.id] = agent
            # Messages that waited when the backend stopped. Only an agent that had a turn to run
            # wakes for them; the others (e.g. interrupted by the user) keep waiting for a message.
            self.pending[agent.id] = record.get("pending", [])
            self.wake[agent.id] = asyncio.Event()
            # Agents from before archiving, and from before name_by (an "agent-N" name was the automatic one).
            record.setdefault("archived_at", None)
            record.setdefault("name_by", "auto" if re.fullmatch(r"agent-\d+", record["name"]) else "user")
            # And from before repository agents (Live).
            record.setdefault("repo", None)
            record.setdefault("live", None)
            if record.get("awake") and self.pending[agent.id] and record["archived_at"] is None:
                self.wake[agent.id].set()
            self.nudges[agent.id] = {"count": 0, "state": None}
            self.workers[agent.id] = asyncio.create_task(self.work(agent))

        # The queues are saved with the VMs: take out agents whose record is gone.
        for vm_record in self.vms.list():
            waiting = list(vm_record.queue)
            for line in vm_record.desktops:
                waiting += [line["holder"]] + list(line["priority"])
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

    async def stop(self) -> None:
        if self.saver is not None:
            self.saver.cancel()
        if self.run_watcher is not None:
            self.run_watcher.cancel()
        for worker in self.workers.values():
            worker.cancel()
        for agent in self.agents.values():
            # Its turn is cut off here: after the restart it is woken with this (start()).
            if agent.busy:
                text = "The backend restarted in the middle of your turn; check my_jobs and carry on."
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

            if place == 0 and not jobs_here:
                try:
                    self.queue.release(vm_name, agent.id)
                except (ValueError, VMsError):
                    # The user took it, or deleted the VM, in the meantime.
                    continue
                agent.history.append({"type": "system", "text": f"Released {vm_name}: no jobs left", "time": datetime.now(UTC).isoformat()})
                self.save(agent)
                self.version += 1
                continue
            # Interrupted by the user: it waits for them. More messages waiting: it goes on anyway.
            if agent.stopped or self.wake[agent.id].is_set():
                continue

            # Only its run goes in the VM now: it steps aside, so whoever waits gets the VM meanwhile.
            runs = []
            for vm_record in self.vms.list():
                if place == 0 and vm_record.name == vm_name:
                    runs = [run for run in vm_record.runs if run["agent"] == agent.id]
            if runs:
                try:
                    self.queue.step_aside(vm_name, agent.id)
                except (ValueError, VMsError):
                    continue
                text = f"Stepped aside from {vm_name} while its run goes; it gets the VM back first once the run is over"
                agent.history.append({"type": "system", "text": text, "time": datetime.now(UTC).isoformat()})
                self.save(agent)
                self.version += 1
                continue

            if place == 0 and nudge["count"] >= MAX_NUDGES:
                try:
                    self.queue.release(vm_name, agent.id)
                except (ValueError, VMsError):
                    continue
                text = f"Released {vm_name}: open jobs, but no progress after {MAX_NUDGES} reminders"
                agent.history.append({"type": "system", "text": text, "time": datetime.now(UTC).isoformat()})
                self.save(agent)
                self.version += 1
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
            # In a VM's priority line: it stepped aside while its run goes, and gets the VM back first.
            desktop = None
            for vm_record in self.vms.list():
                if vm_record.name == vm_name:
                    desktop = vm_record.desktop_of(agent.id)
                for line in vm_record.desktops:
                    if agent.id in line["priority"]:
                        status = "in_priority"
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
                    # The desktop of that VM it holds, stepped aside from or asked for (None: it waits for any).
                    "desktop": desktop,
                    "place": place,
                    "context_used": agent.context_used,
                    "context_max": agent.context_max,
                    "cost_usd": agent.cost_usd,
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
            "created_at": datetime.now(UTC).isoformat(),
            "archived_at": None,
            "name_by": name_by,
            "repo": None,
            "live": None,
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
        # Its very first message: an agent with the automatic name hears it may name itself.
        agent = self.agents[agent_id]
        if agent.record["name_by"] == "auto" and not agent.history and not self.pending[agent_id]:
            hint = f"You have the automatic name {agent.name}. Once you know what the user wants, give yourself a short name for that work with name_yourself."
            self.pending[agent_id].append({"from": "System", "text": hint, "shown": False})
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
        job = self.jobs.create("fix_issue", title, agent_id, "user", issue=issue_id, repo=issue["repo"], vm=vm_name, instructions=instructions)
        text = f"New job {job['id']}: {title}"
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        if agent.record["name_by"] == "auto":
            text += f"\nYou still have the automatic name {agent.name}: give yourself a short name for your work with name_yourself."
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
        job = self.jobs.create("task", title, agent_id, "user", vm=vm_name, instructions=instructions)
        text = f"New job {job['id']}: {title}"
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        if agent.record["name_by"] == "auto":
            text += f"\nYou still have the automatic name {agent.name}: give yourself a short name for your work with name_yourself."
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
        job = self.jobs.create("set_up_repo", title, agent_id, "user", repo=repo, vm=vm_name, instructions=instructions)
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
        if agent.record["name_by"] == "auto":
            text += f"\nYou still have the automatic name {agent.name}: give yourself a short name for your work with name_yourself."
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
        if agent.record["name_by"] == "auto":
            text += f"\nYou still have the automatic name {agent.name}: give yourself a short name for your work with name_yourself."
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
        names = [agent.name for agent in self.agents.values()]
        name = repo.split("/")[1]
        number = 2
        while name in names:
            name = f"{repo.split('/')[1]}-{number}"
            number += 1
        created = self.create(name)
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
        job = self.jobs.create("set_up_repo", title, agent_id, "user", repo=repo, vm=vm_name)
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

    def issue_taken(self, issue_id: str, reason: str) -> None:
        """The issue went from free to assigned: someone else is on it now. Every open job on it gets an item in the
        Inbox, so the user decides whether its agent keeps working or stops. One pending item per job at most."""
        asked = [draft["job"] for draft in self.inbox.list() if draft["kind"] == "taken" and draft["status"] == "pending"]
        # reason is the tags' sentence on who has it, then one on how hard it is ("Easy: ..."); only the first part matters here.
        why = re.split(r"\s(?:Easy|Medium|Hard|Out of scope): ", reason)[0]
        for job in self.jobs.list():
            if job["issue"] != issue_id or job["status"] in ["done", "cancelled"] or job["id"] in asked:
                continue
            agent = self.agents.get(job["agent"])
            if agent is None:
                continue
            body = (
                f"Your agent {agent.name} has this issue as {job['id']} ({job['title']}). It was free, but someone else "
                f"seems to be on it now: {why}\n\n"
                "- **Keep working**: the agent carries on; you still decide on its PR.\n"
                "- **Stop the agent**: the job is cancelled, and the agent stops working on it right away."
            )
            self.inbox.create("taken", job["agent"], f"{issue_id} isn't free anymore", body, job=job["id"], repo=job["repo"], target=issue_id, vm=job["vm"])

    def follow_up(self, entry: dict) -> dict | None:
        """Someone else wrote on a PR or issue an agent follows for the user (agent mode Drafts on the GitHub tab), or the
        PR's checks failed: an entry of pr_tracking.needs_reply ({"id", "kind", "relation", "title", "url", "agent", "reason",
        "at", "failed_sha", "head"}; only the user's own PR, relation author, gets offered a new version). The agent's open follow_up job for that thread hears about it; else a new one is made.
        Returns the job, or None when the agent is gone. Any thread."""
        agent = self.agents.get(entry["agent"])
        if agent is None:
            return None
        thread = entry["id"]
        repo = thread.split("#")[0]
        number = thread.split("#")[1]
        head = entry["head"]
        what = "issue"
        if entry["kind"] == "pr":
            what = "PR"
        # A new version goes on the PR's own branch, which only the user's own PR has (not one they only commented on).
        own_pr = entry["kind"] == "pr" and head is not None and entry.get("relation", "author") == "author"
        # It comes back from the archive for it, as for a job the user gives it. unarchive() wakes it: on the loop.
        if threading.get_ident() == self.loop_thread:
            self.unarchive(agent.id)
        else:
            self.loop.call_soon_threadsafe(self.unarchive, agent.id)

        for job in self.jobs.for_agent(agent.id):
            if job["kind"] != "follow_up" or job["thread"] != thread or job["status"] in ["done", "cancelled"]:
                continue
            text = f"More on {thread} ({entry['title']}) for {job['id']}: {entry['reason']}. Read it again with read_thread and take it into account."
            if entry["failed_sha"]:
                text += f" Its checks failed on {entry['failed_sha'][:10]}: see which and why on {entry['url']}/checks."
            if own_pr:
                text += f" Its branch {head['branch']} in {head['repo']} is at {head['sha']} now: a new version goes on top of that commit."
            if job["status"] == "waiting_on_user":
                text += " Your draft for it still waits in the user's Inbox; if it no longer fits, draft a new one and say why in it."
            self.notify(agent.id, text)
            return job

        title = f"Follow up on {thread}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("follow_up", title, agent.id, "user", repo=repo, vm=vm_name, thread=thread)
        text = f"New job {job['id']}: {title}\n{entry['reason']} on the {what} {thread} ({entry['title']}): {entry['url']}"
        if entry["failed_sha"]:
            text += (
                f"\nIts checks failed on {entry['failed_sha'][:10]}: see which and why on its checks page ({entry['url']}/checks, "
                "with browser_open), and reproduce the failure in the VM before you fix it. A failure that isn't the PR's fault "
                "(a flaky test, a broken main branch) needs no new version: a short reply saying so, or nothing."
            )
        text += (
            "\nYou follow it for the user: when someone else writes there or its checks fail, you suggest what to do, and the "
            "user decides. You never post, push or send anything yourself; only the user's Approve does, as them.\n"
            "First read the whole thread with read_thread. Then do one of these (see Following up on PRs and issues):\n"
            f"- A reply, when someone asked something or waits for an answer: draft_comment with target {thread}. Short, "
            "friendly, in the project's tone, the way the user would write it."
        )
        if own_pr:
            text += (
                "\n- A new version of the PR, when a reviewer asked for changes or its checks failed. Its branch is "
                f"{head['branch']} in the user's fork {head['repo']}, newest commit {head['sha']}. In the VM, in the project's "
                f"folder (~/{repo.split('/')[1]}; clone it if it isn't there): `git fetch https://github.com/{head['repo']} "
                f"{head['branch']} && git switch -C pr-{number} {head['sha']}`, and work on top of that commit. Commit your "
                f"change on pr-{number} in the project's style, then run the tests once, with your change: run_tests with "
                f"when: after, base {head['sha']}, and the checks the project's rules ask for before a PR, however long. No "
                "when: before run on the main branch: the PR's first version already had one. Then draft_pr with pr "
                f"{thread} and "
                f"base {head['sha']}: its title is the commit message's subject, its body the comment posted on the PR with "
                "the push (what changed, in a line or two)."
            )
        text += (
            f"\n- Nothing, when nothing needs an answer (a thank-you, a bot's note, an approval without questions): job_update "
            f"{job['id']} with status done and a note on why."
        )
        if entry["kind"] == "pr" and not own_pr:
            text += "\nThe PR's code isn't the user's to change: a reply or nothing."
        if agent.record["name_by"] == "auto":
            text += f"\nYou still have the automatic name {agent.name}: give yourself a short name for your work with name_yourself."
        if vm_name is None:
            text += "\nYou have no target VM. A reply needs none; for a new version, pick one with vms_list and choose_vm, then queue_for_vm."
        else:
            text += f"\nIt is for {vm_name}: queue_for_vm only when you need the VM (a new version does, a reply doesn't)."
        self.notify(agent.id, text)
        return job

    def decide(self, draft_id: str, decision: str, reply: str = "") -> dict:
        """The user's decision on a draft (approved, rejected or replied) goes to its agent, and its job is open again."""
        if decision == "replied" and self.inbox.get(draft_id)["kind"] == "taken":
            raise ValueError("Keep working or stop the agent; this one takes no reply")
        draft = self.inbox.decide(draft_id, decision, reply)
        job = None
        if draft["job"] is not None:
            job = self.jobs.get(draft["job"])

        # The app asked whether the agent keeps working on an issue someone else took (issue_taken). approved: keep
        # working, rejected: stop. A job that ended in the meantime has nothing left to decide.
        if draft["kind"] == "taken":
            if job is None or job["status"] in ["done", "cancelled"]:
                return draft
            note = ""
            if reply:
                note = f" Their note: {reply}"
            if decision == "approved":
                self.notify(draft["agent"], f"{draft['target']} isn't free anymore on GitHub, but the user wants you to keep working on {job['id']}.{note}")
                return draft
            was_working = job["status"] == "working"
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

        if job is not None and job["status"] == "waiting_on_user":
            job = self.jobs.update(job["id"], status="queued")

        kinds = {"pr": "PR", "comment": "comment", "question": "question", "report": "report"}
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
        elif decision == "approved" and draft["kind"] == "pr":
            text = f"The user approved {about}. They send it to GitHub themselves. If it finishes {job_name}, mark the job done with job_update."
        elif decision == "approved" and draft["kind"] == "comment" and sent is not None:
            text = f"The user approved {about}, and it is posted: {sent['url']}. Carry on with {job_name}."
        elif decision == "approved" and draft["kind"] == "comment":
            text = f"The user approved {about}. They post it themselves. Carry on with {job_name}."
        elif decision == "approved" and draft["kind"] == "report":
            text = f"The user approved {about}. It finishes {job_name}: mark the job done with job_update."
        elif decision == "approved":
            text = f"The user approved {about}. Carry on with {job_name}."
        elif decision == "rejected":
            text = f"The user rejected {about}."
            if reply:
                text += f" Their note: {reply}"
            text += f" Don't draft it again as it is: change course, or cancel {job_name} with job_update if it no longer makes sense. Ask with draft_question if unsure."
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
            if draft["kind"] == "pr":
                final = f"{draft['title']}\n\n{draft['body']}"
            text += f"\nThe user edited your draft before deciding. The final text:\n{final}\nSee what they changed, and write it their way next time."
        if job is not None and job["status"] == "queued" and job["vm"] is not None:
            text += f"\n{job['id']} is queued again; use queue_for_vm if you need {job['vm']} for it."
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
            if notes:
                text += "\nIts notes (check what is really there before you rely on them):"
                for note in notes:
                    by = self.agents[note["by"]].name if note["by"] in self.agents else note["by"]
                    on = f", on desktop {note['desktop']}" if "desktop" in note else ""
                    text += f"\n- {note['id']} by {by}, {note['at'][:10]}{on}: {note['text']}"
            else:
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

    async def watch_runs(self) -> None:
        """Every RUN_CHECK_SECONDS: the runs no tool call waits for. One that ended goes to its agent (run_ended)."""
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

    async def run_ended(self, vm_record, run: dict, ended: dict) -> None:
        """A run in the background ended: its agent gets the result. One that stepped aside from this VM gets it with
        the message that the VM is its again (finish_run, right after this, may give it the VM at once), so it starts
        one turn with both; any other agent is woken now."""
        agent = self.agents.get(run["agent"])
        if agent is None:
            return
        if run["kind"] == "tests":
            answer = await agent.work_tools.finish_tests(vm_record, run, ended)
            text = f"Your test run {run['id']} for {run['job']} ended. " + answer["content"][0]["text"]
        else:
            text = f"Your run {run['id']} in {vm_record.name} ended: `{run['label'][:200]}`, " + agent.computer_tools.bash_result(vm_record, run, ended)
        agent.history.append({"type": "system", "text": f"Its run in {vm_record.name} ended: {run['label'][:120]}", "time": datetime.now(UTC).isoformat()})
        if not [line for line in vm_record.desktops if agent.id in line["priority"]]:
            self.notify(agent.id, text)
            return
        text += f"\nYou get {vm_record.name} back first, with a message, as soon as it is free; until then end your turn."
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
