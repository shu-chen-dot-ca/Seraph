"""All agents: their worker loops, and the rules that tie them to jobs, the VM queue and the Inbox.

Each agent (agent/agent.py) is one Claude conversation with a record on disk,
DATA_DIR/agents/<id>.json:

    {"id": "agent_a1b2c3", "name": "agent-1", "target_vm": "vm1" | null, "claude_session_id",
     "history": [HistoryEntry, ...], "context_used", "context_max", "cost_usd", "created_at",
     "pending": [message, ...], "awake": bool}

Every agent has a worker (an asyncio task) that waits for messages, joins the waiting ones into
one prompt, each starting with [User] (the user typed it) or [System] (the app: a new job, a VM
that is its turn now, the user's decision on a draft, a reminder), and runs one turn with them.
A message sent while the agent works waits in a queue (the chat shows it as pending; MAX_QUEUED of
the user's at most). Each of the user's messages gets a turn of its own, in order, together with the
app's messages that came before it; interrupting a turn (Esc in the chat) starts the next one. The user can take
one of their queued messages out before it goes in (cancel_queued); the agent list carries their texts (queued).
Waiting messages are saved with the record, so a backend restart (it reloads on every code
change) doesn't lose them. An agent that was in a turn or about to start one (awake) is woken
with them after the restart; one cut off in the middle of a turn gets one more saying so.

After each turn the worker enforces the VM rule: an agent never holds a VM it has nothing to do in.
- Holding a VM with no queued or working job for it: the VM is released for it.
- Holding one with open jobs there: it is reminded to go on, or to release the VM. After
  MAX_NUDGES reminders in a row with no change to its jobs, the VM is released for it.
- In no queue but with queued jobs for a VM: it is reminded to queue_for_vm (MAX_NUDGES times at most).
The VM queue (sandbox/vm_queue.py) tells Agents when an agent's turn comes (on_grant: a message
that wakes it, or the VM passes on at once if it has no open jobs there anymore) and when the
user took the VM or its place away (on_kick: it is interrupted, and what it still ran in that
VM is killed).

The user's side: assign() turns an issue into a job for an agent, decide() passes the user's
decision on a draft back to its agent.

Everything here runs in the backend's event loop. notify() and the queue callbacks may be called
from request threads, so they hand their work to the loop. version goes up on every change the
agent list shows (status, history, context, queue), for the live feed.

    agents = Agents(repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues)
    await agents.start()
    agents.send(agent_id, "find good first issues in Python CLI tools")
"""

import asyncio
import functools
import json
import os
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher import search
from github_searcher.agent.agent import Agent
from github_searcher.agent.work_tools import WorkTools
from sandbox.agent.tools import ComputerTools
from sandbox.vms import VMsError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Reminders in a row, with no change to the agent's jobs or queue place, before the app stops reminding.
MAX_NUDGES = 2
# The user's messages that may wait for their turn at once.
MAX_QUEUED = 10
# While an agent works, its record is saved this often (and after every turn).
SAVE_SECONDS = 5
OPEN_STATUSES = ["queued", "working"]


class Agents:
    def __init__(self, repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues, rejections, repo_signals, issue_tags, explore):
        self.repos = repos
        self.issues = issues
        # The Tracked list (a RepoList) and what each tracked repo's last check found on GitHub.
        self.tracked = tracked
        self.tracked_issues = tracked_issues
        # Repos the user rejected (agents can't add them back while blocked), each repo's signals
        # (check_activity works them out the same way) and each issue's tags: free or assigned, level, kind.
        self.rejections = rejections
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
            computer_tools = ComputerTools(self.vms, record["id"], functools.partial(record.get, "target_vm"), record["history"])
            agent = Agent(record, computer_tools, WorkTools(self, record), self.changed)
            self.agents[agent.id] = agent
            # Messages that waited when the backend stopped. Only an agent that had a turn to run
            # wakes for them; the others (e.g. interrupted by the user) keep waiting for a message.
            self.pending[agent.id] = record.get("pending", [])
            self.wake[agent.id] = asyncio.Event()
            if record.get("awake") and self.pending[agent.id]:
                self.wake[agent.id].set()
            self.nudges[agent.id] = {"count": 0, "state": None}
            self.workers[agent.id] = asyncio.create_task(self.work(agent))

        # The queues are saved with the VMs: take out agents whose record is gone.
        for vm_record in self.vms.list():
            for agent_id in [vm_record.holder] + list(vm_record.queue):
                if agent_id is None or agent_id == "user" or agent_id in self.agents:
                    continue
                self.queue.leave_all(agent_id)

        # A VM an agent held when the backend stopped is still its own: it carries on.
        for agent_id in self.agents:
            vm_name, place = self.queue.place(agent_id)
            if place != 0:
                continue
            self.notify(agent_id, f"The backend restarted; you still hold {vm_name}. Check where your jobs for it stand (my_jobs), finish them, then release_vm.")

        self.saver = asyncio.create_task(self.autosave())

    async def stop(self) -> None:
        if self.saver is not None:
            self.saver.cancel()
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
                text = f"You still hold {vm_name} and have open jobs: {titles}. Continue, or release_vm."
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
        for agent in sorted(self.agents.values(), key=lambda agent: agent.record["created_at"]):
            vm_name, place = self.queue.place(agent.id)
            status = "idle"
            if agent.busy:
                status = "working"
            if place is not None and place > 0:
                status = "in_queue"
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
                }
            )
        return summaries

    def create(self, name: str = "") -> dict:
        """A new agent with no target VM. Without a name it gets the first free "agent-N"."""
        names = [agent.name for agent in self.agents.values()]
        name = name.strip()
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
        }
        computer_tools = ComputerTools(self.vms, agent_id, functools.partial(record.get, "target_vm"), record["history"])
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

    def rename(self, agent_id: str, new_name: str) -> None:
        """The user renamed the agent. Jobs, drafts and the VM queue know it by its id, so nothing else changes."""
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
        self.save(agent)
        self.version += 1

    async def delete(self, agent_id: str) -> None:
        """Stop the agent and delete it. Its open jobs become cancelled; its drafts stay in the Inbox."""
        agent = self.agents[agent_id]
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
        # Its desktop lock and whatever it still runs in the VM end with it.
        agent.computer_tools.end_turn()
        if vm_name is not None:
            await asyncio.to_thread(agent.computer_tools.cancel, vm_name)
        (self.folder / f"{agent_id}.json").unlink(missing_ok=True)

    def history(self, agent_id: str, since: int) -> list[dict]:
        return self.agents[agent_id].history[since:]

    def send(self, agent_id: str, text: str) -> None:
        """A chat message from the user. It waits while the agent works, then goes with its next turn."""
        if agent_id not in self.agents:
            raise KeyError(f"No agent {agent_id}")
        if not text.strip():
            raise ValueError("The message is empty")
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
        self.wake[agent_id].set()
        self.version += 1

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

        title = f"Fix {issue_id}: {issue['title']}"
        vm_name = agent.record["target_vm"]
        job = self.jobs.create("fix_issue", title, agent_id, "user", issue=issue_id, repo=issue["repo"], vm=vm_name, instructions=instructions)
        text = f"New job {job['id']}: {title}"
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
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

        vm_name = agent.record["target_vm"]
        job = self.jobs.create("task", title, agent_id, "user", vm=vm_name, instructions=instructions)
        text = f"New job {job['id']}: {title}"
        if instructions:
            text += f"\nInstructions from the user: {instructions}"
        if vm_name is None:
            text += "\nYou have no target VM. If the job needs one, pick the one that suits it with vms_list and choose_vm."
        else:
            text += f"\nYour VM is {vm_name}. If the job needs it, use queue_for_vm when ready; if it doesn't, just do it and mark it done."
        self.notify(agent_id, text)
        return job

    def decide(self, draft_id: str, decision: str, reply: str = "") -> dict:
        """The user's decision on a draft (approved, rejected or replied) goes to its agent, and its job is open again."""
        draft = self.inbox.decide(draft_id, decision, reply)
        job = None
        if draft["job"] is not None:
            job = self.jobs.get(draft["job"])
        if job is not None and job["status"] == "waiting_on_user":
            job = self.jobs.update(job["id"], status="queued")

        kinds = {"pr": "PR", "comment": "comment", "question": "question"}
        about = f"your {kinds.get(draft['kind'], draft['kind'])} draft {draft_id} ({draft['title']})"
        job_name = job["id"] if job is not None else "your work"
        if decision == "approved" and draft["kind"] == "pr":
            text = f"The user approved {about}. They send it to GitHub themselves. If it finishes {job_name}, mark the job done with job_update."
        elif decision == "approved" and draft["kind"] == "comment":
            text = f"The user approved {about}. They post it themselves. Carry on with {job_name}."
        elif decision == "approved":
            text = f"The user approved {about}. Carry on with {job_name}."
        elif decision == "rejected":
            text = f"The user rejected {about}."
            if reply:
                text += f" Their note: {reply}"
            text += f" Don't draft it again as it is: change course, or cancel {job_name} with job_update if it no longer makes sense. Ask with draft_question if unsure."
        else:
            text = f"The user replied to {about}:\n{reply}\nDo what they say and keep working on {job_name}; draft again when it's ready."
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
            self.notify(agent_id, f"{vm_name} is yours now. Your open jobs for it: {titles}. Do them all, then release_vm.")
            return
        agent.history.append({"type": "system", "text": f"Passed {vm_name} on: no open jobs for it", "time": datetime.now(UTC).isoformat()})
        self.version += 1
        try:
            self.queue.release(vm_name, agent_id)
        except (ValueError, VMsError):
            # The user took it, or deleted the VM, in the meantime.
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
