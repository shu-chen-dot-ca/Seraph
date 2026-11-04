"""Who uses each VM: one holder and a priority line per desktop, and one line of agents waiting for a desktop.

A VM has one to three desktops (sandbox/vm.py), each with its own screen, mouse, keyboard and home folder, so agents
on different desktops work at the same time. Each has a fixed number (record.desktops is {number: line}), so a VM may
have desktops 2 and 3 only. An agent joins its target VM (queue_for_vm), maybe asking for one
desktop (where its project is set up). If a desktop nobody holds is there (the one it asked for, or any), it holds
it at once; otherwise it waits in the VM's line, even while the VM is off. When a holder releases, the desktop goes
to the next one (next_holder) and Agents hears about it (on_grant), which wakes that agent. An agent is in at most
one VM's lines (holding, in priority or waiting) at a time.

Runs (sandbox/agent/long_runs.py) are long commands agents left going in the VM: a test suite, a big build. They
are kept here with the VM, from add_run until finish_run, each with its desktop. An agent that holds a desktop while
only its run goes keeps it (agents.py wakes it to check on the run). Only the user makes the holder step aside
(Skip, step_aside): the next one gets the desktop, and the agent goes to the end of that desktop's priority line. So
it gets its own desktop back, where its run and its folders are.

Who is next on a desktop (next_holder): its priority line comes first. Its first agent is checked: if no run of its
own still goes in the VM, it is its turn and the desktop is its; otherwise it goes to the end of the priority line
and the next one is checked. When none of them is ready, the first in the waiting line that asked for this desktop
or for none gets it. When a run ends on a desktop nobody holds, the next one is picked then, so an agent whose run
ends gets its desktop back at once if it is free.

The user can take a desktop over (the agent holding it goes back to the front of the line, asking for that desktop),
give a desktop to a waiting agent, move an agent to the front, skip the holder, or remove an agent from a line or
from holding. An agent that loses its place because of the user is told through on_kick (Agents interrupts it; its
runs go on). on_change runs after every change, so the agent list (which shows each agent's place) is sent again.

The state lives in each VMRecord (desktops, queue, wants, runs) and is saved with it, so it survives a restart.
Calls never touch Incus, so they are quick. One lock guards every change, and the callbacks
run after it is released (they may call back into this queue).

    queue = VMQueue(vms)
    queue.on_grant = lambda vm_name, agent_id: ...
    queue.on_kick = lambda vm_name, agent_id, reason: ...
    place = queue.join("vm1", "agent_a1b2c3")    # 0: it holds a desktop now; 2: second in line
    desktop = vms.get("vm1").desktop_of("agent_a1b2c3")
"""

import threading

from sandbox.vms import VMs


class VMQueue:
    def __init__(self, vms: VMs):
        self.vms = vms
        self.lock = threading.Lock()
        # Runs whose end someone is handling now (a tool call or Agents), so nobody handles one twice. Not saved.
        self.ending: set[str] = set()
        # Set by Agents. on_grant(vm_name, agent_id): an agent became the holder of a desktop while it waited.
        # on_kick(vm_name, agent_id, reason): the user took the desktop or its place away.
        # on_change(): any holder, line or run changed.
        self.on_grant = None
        self.on_kick = None
        self.on_change = None

    def next_holder(self, record, desktop: int) -> str | None:
        """Only with the lock held, on a desktop nobody holds: makes the next one its holder, and returns it (None when
        nobody can take it). Its priority line first, in turn: an agent whose run still goes goes to the end of that
        line. Then the first in the waiting line that asked for this desktop or for none."""
        line = record.desktops[desktop]
        for _ in range(len(line["priority"])):
            agent_id = line["priority"].pop(0)
            if not [run for run in record.runs if run["agent"] == agent_id]:
                line["holder"] = agent_id
                return agent_id
            line["priority"].append(agent_id)
        for agent_id in record.queue:
            if record.wants.get(agent_id, desktop) == desktop:
                record.queue.remove(agent_id)
                record.wants.pop(agent_id, None)
                line["holder"] = agent_id
                return agent_id
        return None

    def join(self, vm_name: str, agent_id: str, desktop: int | None = None) -> int:
        """0 if the agent holds a desktop of the VM now, else its place in line (1 is next). Joining again gives the same
        answer. An agent in a priority line gets its place there. desktop: the one it wants (where its folders are);
        None takes any. Which one it got: record.desktop_of(agent_id).

        A desktop granted right here is not reported through on_grant: the caller learns it from the 0.
        """
        with self.lock:
            record = self.vms.get(vm_name)
            for line in record.desktops.values():
                if line["holder"] == agent_id:
                    return 0
                if agent_id in line["priority"]:
                    return line["priority"].index(agent_id) + 1
            if agent_id in record.queue:
                return record.queue.index(agent_id) + 1
            for other in self.vms.list():
                if other.desktop_of(agent_id) is not None or agent_id in other.queue:
                    raise ValueError(f"Already in {other.name}'s queue; release_vm takes you out of it")
            if desktop is not None and desktop not in record.desktops:
                numbers = ", ".join([str(number) for number in record.desktops])
                raise ValueError(f"{vm_name} has no desktop {desktop}; its desktops are {numbers}")
            # A desktop nobody holds: the one asked for, or the first such one.
            free = None
            for number, line in record.desktops.items():
                if line["holder"] is None and free is None and desktop in [None, number]:
                    free = number
            if free is not None:
                record.desktops[free]["holder"] = agent_id
                record.save()
                place = 0
            else:
                record.queue.append(agent_id)
                if desktop is not None:
                    record.wants[agent_id] = desktop
                record.save()
                place = len(record.queue)
        if self.on_change is not None:
            self.on_change()
        return place

    def release(self, vm_name: str, who: str, desktop: int | None = None) -> None:
        """The holder (an agent id, or "user" with the desktop) is done; the next one gets the desktop."""
        with self.lock:
            record = self.vms.get(vm_name)
            if desktop is None:
                desktop = record.holding(who)
            if desktop not in record.desktops or record.desktops[desktop]["holder"] != who:
                raise ValueError(f"{who} doesn't hold {vm_name}")
            record.desktops[desktop]["holder"] = None
            granted = self.next_holder(record, desktop)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def step_aside(self, vm_name: str, agent_id: str, by_user: bool = False) -> None:
        """The user skipped the holder (Skip): the next one gets its desktop, and the agent goes to
        the end of that desktop's priority line, so it gets it back before anyone in the waiting line once its run is over.

        by_user (Skip): refused when nobody else could take the desktop, and the agent is told (on_kick).
        """
        with self.lock:
            record = self.vms.get(vm_name)
            desktop = record.holding(agent_id)
            if desktop is None:
                raise ValueError(f"{agent_id} doesn't hold {vm_name}")
            line = record.desktops[desktop]
            line["holder"] = None
            granted = self.next_holder(record, desktop)
            if granted is None and by_user:
                line["holder"] = agent_id
                raise ValueError(f"No other agent waits for desktop {desktop} of {vm_name}")
            line["priority"].append(agent_id)
            # Nobody else could take it, and the agent's run ended meanwhile: it is its own again.
            if line["holder"] is None:
                granted = self.next_holder(record, desktop)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if by_user and self.on_kick is not None:
            reason = (
                f"The user gave desktop {desktop} of {vm_name} to the next agent for now. You are in its priority line: you "
                "get it back first, with a message."
            )
            self.on_kick(vm_name, agent_id, reason)
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def take_over(self, vm_name: str, desktop: int) -> None:
        """The user holds the desktop now. An agent that held it goes back to the front of the line, asking for it."""
        kicked = None
        with self.lock:
            record = self.vms.get(vm_name)
            if desktop not in record.desktops:
                raise ValueError(f"{vm_name} has no desktop {desktop}")
            line = record.desktops[desktop]
            if line["holder"] == "user":
                return
            if line["holder"] is not None:
                kicked = line["holder"]
                record.queue.insert(0, kicked)
                record.wants[kicked] = desktop
            line["holder"] = "user"
            record.save()
        if self.on_change is not None:
            self.on_change()
        if kicked is not None and self.on_kick is not None:
            self.on_kick(vm_name, kicked, f"The user took desktop {desktop} of {vm_name} over. You are first in its queue again.")

    def give_to(self, vm_name: str, agent_id: str, desktop: int) -> None:
        """A waiting agent (in the waiting line or a priority line) holds the desktop now. An agent that held it goes
        back to the front of the line, asking for it; if the user held it, the user's hold just ends."""
        kicked = None
        with self.lock:
            record = self.vms.get(vm_name)
            if desktop not in record.desktops:
                raise ValueError(f"{vm_name} has no desktop {desktop}")
            line = record.desktops[desktop]
            if line["holder"] == agent_id:
                return
            waiting = agent_id in record.queue
            for other in record.desktops.values():
                if agent_id in other["priority"]:
                    waiting = True
                    other["priority"].remove(agent_id)
            if not waiting:
                raise ValueError(f"{agent_id} is not waiting for {vm_name}")
            if agent_id in record.queue:
                record.queue.remove(agent_id)
            record.wants.pop(agent_id, None)
            if line["holder"] is not None and line["holder"] != "user":
                kicked = line["holder"]
                record.queue.insert(0, kicked)
                record.wants[kicked] = desktop
            line["holder"] = agent_id
            record.save()
        if self.on_change is not None:
            self.on_change()
        if kicked is not None and self.on_kick is not None:
            self.on_kick(vm_name, kicked, f"The user gave desktop {desktop} of {vm_name} to another agent. You are first in its queue again.")
        if self.on_grant is not None:
            self.on_grant(vm_name, agent_id)

    def fill(self, vm_name: str) -> None:
        """Give every desktop nobody holds to the next one, e.g. after the VM got more desktops."""
        grants = []
        with self.lock:
            record = self.vms.get(vm_name)
            for number, line in record.desktops.items():
                if line["holder"] is None:
                    granted = self.next_holder(record, number)
                    if granted is not None:
                        grants.append(granted)
            record.save()
        if self.on_change is not None:
            self.on_change()
        if self.on_grant is None:
            return
        for granted in grants:
            self.on_grant(vm_name, granted)

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
        """The user takes an agent out of a line, or away from holding (then the next one gets the desktop). Its runs go on."""
        granted = None
        reason = None
        with self.lock:
            record = self.vms.get(vm_name)
            for number, line in record.desktops.items():
                if line["holder"] == agent_id:
                    reason = f"The user removed you from desktop {number} of {vm_name}; you don't hold it anymore."
                    line["holder"] = None
                    # The next one gets a desktop nobody holds.
                    granted = self.next_holder(record, number)
                if agent_id in line["priority"]:
                    reason = f"The user removed you from {vm_name}'s priority line."
                    line["priority"].remove(agent_id)
            if agent_id in record.queue:
                reason = f"The user removed you from {vm_name}'s queue."
                record.queue.remove(agent_id)
                record.wants.pop(agent_id, None)
            if reason is None:
                raise ValueError(f"{agent_id} is not holding or waiting for {vm_name}")
            record.save()
        if self.on_change is not None:
            self.on_change()
        if self.on_kick is not None:
            self.on_kick(vm_name, agent_id, reason)
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def leave_all(self, agent_id: str) -> None:
        """The agent is deleted: out of every line, without on_kick. A desktop it held goes to the next one."""
        grants = []
        with self.lock:
            for record in self.vms.list():
                if record.desktop_of(agent_id) is None and agent_id not in record.queue:
                    continue
                if agent_id in record.queue:
                    record.queue.remove(agent_id)
                record.wants.pop(agent_id, None)
                for number, line in record.desktops.items():
                    if agent_id in line["priority"]:
                        line["priority"].remove(agent_id)
                    if line["holder"] == agent_id:
                        line["holder"] = None
                        granted = self.next_holder(record, number)
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
        """(VM name, 0 when holding a desktop or its place in its line) or (None, None) when in no line. Which desktop:
        the VM record's desktop_of(agent_id)."""
        with self.lock:
            for record in self.vms.list():
                for line in record.desktops.values():
                    if line["holder"] == agent_id:
                        return record.name, 0
                    if agent_id in line["priority"]:
                        return record.name, line["priority"].index(agent_id) + 1
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
        """The run ended and its agent has the result: it is gone from the VM. On a desktop nobody holds, the next one
        gets it, so an agent skipped while this run went gets its desktop back at once."""
        granted = None
        with self.lock:
            self.ending.discard(run_id)
            record = self.vms.get(vm_name)
            # Runs from before desktops were all on desktop 1.
            desktops = [run.get("desktop", 1) for run in record.runs if run["id"] == run_id]
            record.runs = [run for run in record.runs if run["id"] != run_id]
            if desktops and desktops[0] in record.desktops and record.desktops[desktops[0]]["holder"] is None:
                granted = self.next_holder(record, desktops[0])
            record.save()
        if self.on_change is not None:
            self.on_change()
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)
