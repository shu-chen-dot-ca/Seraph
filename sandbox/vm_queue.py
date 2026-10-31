"""Who uses each VM: one holder, a priority line of agents that stepped aside, and a line of waiting agents.

An agent joins its target VM's queue (queue_for_vm). If nobody holds the VM and nobody waits,
it holds it at once; otherwise it waits, even while the VM is off. When the holder releases,
the next one becomes the holder and Agents hears about it (on_grant), which wakes that agent.
An agent is in at most one VM's lines (holding, in priority or waiting) at a time.

Runs (sandbox/agent/long_runs.py) are long commands agents left going in the VM: a test suite, a big build. They
are kept here with the VM, from add_run until finish_run. An agent that holds the VM while only its run goes steps
aside after its turn (step_aside, agents.py), and the user can make the holder step aside too (Skip): the next one
gets the VM, and the agent goes to the end of the priority line.

Who is next (next_holder): the priority line comes first. Its first agent is checked: if no run of its own still
goes in the VM, it is its turn and the VM is its; otherwise it goes to the end of the priority line and the next one
is checked. When none of them is ready, the first in the waiting line gets the VM. When a run ends on a VM nobody
holds, the next one is picked then, so an agent whose run ends gets its VM back at once if the VM is free.

The user can take a VM over (the agent holding it goes back to the front of the line), give it
to a waiting agent, move an agent to the front, skip the holder, or remove an agent from a line or from holding.
An agent that loses its place because of the user is told through on_kick (Agents interrupts it; its runs go on).
on_change runs after every change, so the agent list (which shows each agent's place) is sent again.

The state lives in each VMRecord (holder, priority, queue, runs) and is saved with it, so it survives a restart.
Calls never touch Incus, so they are quick. One lock guards every change, and the callbacks
run after it is released (they may call back into this queue).

    queue = VMQueue(vms)
    queue.on_grant = lambda vm_name, agent_id: ...
    queue.on_kick = lambda vm_name, agent_id, reason: ...
    place = queue.join("vm1", "agent_a1b2c3")    # 0: it is yours now; 2: second in line
"""

import threading

from sandbox.vms import VMs


class VMQueue:
    def __init__(self, vms: VMs):
        self.vms = vms
        self.lock = threading.Lock()
        # Runs whose end someone is handling now (a tool call or Agents), so nobody handles one twice. Not saved.
        self.ending: set[str] = set()
        # Set by Agents. on_grant(vm_name, agent_id): an agent became the holder while it waited.
        # on_kick(vm_name, agent_id, reason): the user took the VM or its place away.
        # on_change(): any holder, line or run changed.
        self.on_grant = None
        self.on_kick = None
        self.on_change = None

    def next_holder(self, record) -> str | None:
        """Only with the lock held, on a VM nobody holds: makes the next one its holder, and returns it (None when nobody
        can take it). The priority line first, in turn: an agent whose run still goes goes to the end of that line."""
        for _ in range(len(record.priority)):
            agent_id = record.priority.pop(0)
            if not [run for run in record.runs if run["agent"] == agent_id]:
                record.holder = agent_id
                return agent_id
            record.priority.append(agent_id)
        if record.queue:
            record.holder = record.queue.pop(0)
            return record.holder
        return None

    def join(self, vm_name: str, agent_id: str) -> int:
        """0 if the agent holds the VM now, else its place in line (1 is next). Joining again gives the same answer.
        An agent in the priority line gets its place there.

        A VM granted right here is not reported through on_grant: the caller learns it from the 0.
        """
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder == agent_id:
                return 0
            if agent_id in record.priority:
                return record.priority.index(agent_id) + 1
            if agent_id in record.queue:
                return record.queue.index(agent_id) + 1
            for other in self.vms.list():
                if other.holder == agent_id or agent_id in other.queue or agent_id in other.priority:
                    raise ValueError(f"Already in {other.name}'s queue; release_vm takes you out of it")
            if record.holder is None and not record.queue:
                record.holder = agent_id
                record.save()
                place = 0
            else:
                record.queue.append(agent_id)
                record.save()
                place = len(record.queue)
        if self.on_change is not None:
            self.on_change()
        return place

    def release(self, vm_name: str, who: str) -> None:
        """The holder (an agent id or "user") is done; the next one gets the VM."""
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder != who:
                raise ValueError(f"{who} doesn't hold {vm_name}")
            record.holder = None
            granted = self.next_holder(record)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def step_aside(self, vm_name: str, agent_id: str, by_user: bool = False) -> None:
        """The holder waits on its run (or the user skipped it): the next one gets the VM, and the agent goes to the end
        of the priority line, so it gets the VM back before anyone in the waiting line once its run is over.

        by_user (Skip): refused when nobody else could take the VM, and the agent is told (on_kick).
        """
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder != agent_id:
                raise ValueError(f"{agent_id} doesn't hold {vm_name}")
            record.holder = None
            granted = self.next_holder(record)
            if granted is None and by_user:
                record.holder = agent_id
                raise ValueError(f"No other agent waits for {vm_name}")
            record.priority.append(agent_id)
            # Nobody else could take it, and the agent's run ended meanwhile: it is its own again.
            if record.holder is None:
                granted = self.next_holder(record)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if by_user and self.on_kick is not None:
            reason = f"The user gave {vm_name} to the next agent for now. You are in its priority line: you get it back first, with a message."
            self.on_kick(vm_name, agent_id, reason)
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def take_over(self, vm_name: str) -> None:
        """The user holds the VM now. An agent that held it goes back to the front of the line."""
        kicked = None
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder == "user":
                return
            if record.holder is not None:
                kicked = record.holder
                record.queue.insert(0, kicked)
            record.holder = "user"
            record.save()
        if self.on_change is not None:
            self.on_change()
        if kicked is not None and self.on_kick is not None:
            self.on_kick(vm_name, kicked, f"The user took {vm_name} over. You are first in its queue again.")

    def give_to(self, vm_name: str, agent_id: str) -> None:
        """A waiting agent (in either line) holds the VM now. An agent that held it goes back to the front of the line;
        if the user held it, the user's hold just ends."""
        kicked = None
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder == agent_id:
                return
            if agent_id not in record.queue and agent_id not in record.priority:
                raise ValueError(f"{agent_id} is not waiting for {vm_name}")
            if agent_id in record.queue:
                record.queue.remove(agent_id)
            if agent_id in record.priority:
                record.priority.remove(agent_id)
            if record.holder is not None and record.holder != "user":
                kicked = record.holder
                record.queue.insert(0, kicked)
            record.holder = agent_id
            record.save()
        if self.on_change is not None:
            self.on_change()
        if kicked is not None and self.on_kick is not None:
            self.on_kick(vm_name, kicked, f"The user gave {vm_name} to another agent. You are first in its queue again.")
        if self.on_grant is not None:
            self.on_grant(vm_name, agent_id)

    def move_to_front(self, vm_name: str, agent_id: str) -> None:
        with self.lock:
            record = self.vms.get(vm_name)
            if agent_id not in record.queue:
                raise ValueError(f"{agent_id} is not waiting for {vm_name}")
            record.queue.remove(agent_id)
            record.queue.insert(0, agent_id)
            record.save()
        if self.on_change is not None:
            self.on_change()

    def remove(self, vm_name: str, agent_id: str) -> None:
        """The user takes an agent out of a line, or away from holding (then the next one gets the VM). Its runs go on."""
        granted = None
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder != agent_id and agent_id not in record.queue and agent_id not in record.priority:
                raise ValueError(f"{agent_id} is not holding or waiting for {vm_name}")
            if record.holder == agent_id:
                reason = f"The user removed you from {vm_name}; you don't hold it anymore."
                record.holder = None
            elif agent_id in record.priority:
                reason = f"The user removed you from {vm_name}'s priority line."
                record.priority.remove(agent_id)
            else:
                reason = f"The user removed you from {vm_name}'s queue."
                record.queue.remove(agent_id)
            # The next one gets a VM nobody holds.
            if record.holder is None:
                granted = self.next_holder(record)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if self.on_kick is not None:
            self.on_kick(vm_name, agent_id, reason)
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def leave_all(self, agent_id: str) -> None:
        """The agent is deleted: out of every line, without on_kick. A VM it held goes to the next one."""
        grants = []
        with self.lock:
            for record in self.vms.list():
                if record.holder != agent_id and agent_id not in record.queue and agent_id not in record.priority:
                    continue
                if agent_id in record.queue:
                    record.queue.remove(agent_id)
                if agent_id in record.priority:
                    record.priority.remove(agent_id)
                if record.holder == agent_id:
                    record.holder = None
                    granted = self.next_holder(record)
                    if granted is not None:
                        grants.append((record.name, granted))
                record.save()
        if self.on_change is not None:
            self.on_change()
        if self.on_grant is None:
            return
        for vm_name, granted in grants:
            self.on_grant(vm_name, granted)

    def place(self, agent_id: str) -> tuple[str | None, int | None]:
        """(VM name, 0 when holding or its place in its line) or (None, None) when in no line."""
        with self.lock:
            for record in self.vms.list():
                if record.holder == agent_id:
                    return record.name, 0
                if agent_id in record.priority:
                    return record.name, record.priority.index(agent_id) + 1
                if agent_id in record.queue:
                    return record.name, record.queue.index(agent_id) + 1
        return None, None

    def add_run(self, vm_name: str, run: dict) -> None:
        """A run started in the VM (long_runs.start). The dict itself is kept, so a tool call waiting for it sees it
        move to the background."""
        with self.lock:
            record = self.vms.get(vm_name)
            record.runs.append(run)
            record.save()
        if self.on_change is not None:
            self.on_change()

    def claim_run(self, run_id: str) -> bool:
        """Whoever saw the run end first handles it: True for them, False for anyone after."""
        with self.lock:
            if run_id in self.ending:
                return False
            self.ending.add(run_id)
            return True

    def to_background(self, agent_id: str | None = None) -> None:
        """No tool call waits for these runs anymore (the agent's turn ended, or the backend restarted): the app
        collects them (agents.py, watch_runs). The runs of agent_id, in every VM; with None, every run."""
        changed = []
        with self.lock:
            for record in self.vms.list():
                runs = [run for run in record.runs if not run["background"] and agent_id in [None, run["agent"]]]
                for run in runs:
                    run["background"] = True
                if runs:
                    changed.append(record)
            for record in changed:
                record.save()

    def stop_run(self, vm_name: str, run_id: str) -> dict:
        """The user stops a run: marked, so its agent hears who stopped it. long_runs.stop ends it in the VM."""
        with self.lock:
            record = self.vms.get(vm_name)
            matches = [run for run in record.runs if run["id"] == run_id]
            if not matches:
                raise ValueError(f"No run {run_id} in {vm_name}; it may have just ended")
            matches[0]["stopped_by_user"] = True
            record.save()
            return matches[0]

    def finish_run(self, vm_name: str, run_id: str) -> None:
        """The run ended and its agent has the result: it is gone from the VM. On a VM nobody holds, the next one gets
        it, so an agent that stepped aside for this run gets its VM back at once."""
        granted = None
        with self.lock:
            self.ending.discard(run_id)
            record = self.vms.get(vm_name)
            record.runs = [run for run in record.runs if run["id"] != run_id]
            if record.holder is None:
                granted = self.next_holder(record)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)
