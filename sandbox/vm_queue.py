"""Who uses each VM: one holder per desktop, and one line of agents waiting for a desktop.

A VM has one desktop or more, up to its max desktops (sandbox/vm.py), each with its own screen, mouse, keyboard and
home folder, so agents on different desktops work at the same time. Each has a fixed number (record.desktops is {number: line}), so a VM may
have desktops 2 and 3 only. An agent joins its target VM (queue_for_vm), maybe asking for one
desktop (where its project is set up). If a desktop nobody holds is there (the one it asked for, or any), it holds
it at once; otherwise it waits in the VM's line, even while the VM is off. When a holder releases, the desktop goes
to the next one (next_holder) and Agents hears about it (on_grant), which wakes that agent. An agent is in at most
one VM's line (holding or waiting) at a time.

Runs (sandbox/agent/long_runs.py) are long commands agents left going in the VM: a test suite, a big build. They
are kept here with the VM, from add_run until finish_run, each with its desktop. An agent keeps its desktop while its
run goes: nobody steps aside.

A VM with no room (its CPUs, memory or disk used up: full, set by Agents.watch_room) takes nobody new: a desktop that frees
up, or one nobody holds, doesn't go to the waiting line until there is room again. Overloaded, the app takes a desktop back from its agent (step_down): the agent goes to the front of
the waiting line, asking for that desktop, and Agents removes the desktop; nothing the agent runs there is stopped.

Who is next on a desktop (next_holder): the first in the waiting line that asked for this desktop or for none. An
agent with priority (prioritized: the user gave it, or it works on a pull request of yours that needs action, set by
Agents) joins the waiting line ahead of everyone without it, and moves there when it gets priority while it waits
(move_to_front for the user's, move_up, behind the others with priority, for a pull request's).

The user can take a desktop over (the agent holding it goes back to the front of the line, asking for that desktop),
give a desktop to a waiting agent, move an agent to the front, or remove an agent from the line or from holding. An agent that loses its place because of the user is told through on_kick (Agents interrupts it; its
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
from datetime import UTC, datetime

from sandbox.vms import VMs


class VMQueue:
    def __init__(self, vms: VMs):
        self.vms = vms
        self.lock = threading.Lock()
        # Runs whose end someone is handling now (a tool call or Agents), so nobody handles one twice. Not saved.
        self.ending: set[str] = set()
        # The agents the user gave priority, set by Agents (which saves it with each agent): they join a waiting line
        # ahead of everyone without it.
        self.prioritized: set[str] = set()
        # The VMs with no room right now, set by Agents (watch_room), each with why ("a load of 17 on 16 CPUs, 9 GB of
        # its disk free"): nobody new gets a desktop there. {VM name: why}.
        self.full: dict[str, str] = {}
        # Set by Agents. on_grant(vm_name, agent_id): an agent became the holder of a desktop while it waited.
        # on_kick(vm_name, agent_id, reason): the user took the desktop or its place away.
        # on_change(): any holder, line or run changed.
        self.on_grant = None
        self.on_kick = None
        self.on_change = None

    def next_holder(self, record, desktop: int) -> str | None:
        """Only with the lock held, on a desktop nobody holds: makes the next one its holder, and returns it (None when
        nobody can take it): the first in the waiting line that asked for this desktop or for none, unless the VM is
        full."""
        line = record.desktops[desktop]
        if record.name in self.full:
            return None
        for agent_id in record.queue:
            if record.wants.get(agent_id, desktop) == desktop:
                record.queue.remove(agent_id)
                record.wants.pop(agent_id, None)
                line["holder"] = agent_id
                return agent_id
        return None

    def join(self, vm_name: str, agent_id: str, desktop: int | None = None) -> int:
        """0 if the agent holds a desktop of the VM now, else its place in line (1 is next). Joining again gives the same
        answer. desktop: the one it wants (where its folders are);
        None takes any. Which one it got: record.desktop_of(agent_id).

        A desktop granted right here is not reported through on_grant: the caller learns it from the 0.
        """
        with self.lock:
            record = self.vms.get(vm_name)
            for line in record.desktops.values():
                if line["holder"] == agent_id:
                    return 0
            if agent_id in record.queue:
                return record.queue.index(agent_id) + 1
            for other in self.vms.list():
                if other.desktop_of(agent_id) is not None or agent_id in other.queue:
                    raise ValueError(f"Already in {other.name}'s queue; release_vm takes you out of it")
            if desktop is not None and desktop not in record.desktops:
                numbers = ", ".join([str(number) for number in record.desktops])
                raise ValueError(f"{vm_name} has no desktop {desktop}; its desktops are {numbers}")
            # A desktop nobody holds: the one asked for, or the first such one. A full VM takes nobody new.
            free = None
            for number, line in record.desktops.items():
                if line["holder"] is None and free is None and desktop in [None, number]:
                    free = number
            if vm_name in self.full:
                free = None
            if free is not None:
                record.desktops[free]["holder"] = agent_id
                record.save()
                place = 0
            else:
                # With priority: behind the others with priority, ahead of the rest.
                place = len(record.queue)
                if agent_id in self.prioritized:
                    place = 0
                    while place < len(record.queue) and record.queue[place] in self.prioritized:
                        place += 1
                record.queue.insert(place, agent_id)
                if desktop is not None:
                    record.wants[agent_id] = desktop
                record.save()
                place += 1
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

    def step_down(self, vm_name: str, agent_id: str) -> int:
        """The VM is overloaded (Agents.watch_room): the agent gives its desktop back and goes to the front of the waiting
        line, asking for that desktop again. Returns the desktop's number, for Agents to remove it. No on_kick: Agents tells the agent, and nothing it runs is stopped."""
        with self.lock:
            record = self.vms.get(vm_name)
            number = record.holding(agent_id)
            if number is None:
                raise ValueError(f"{agent_id} doesn't hold a desktop of {vm_name}")
            record.desktops[number]["holder"] = None
            record.queue.insert(0, agent_id)
            record.wants[agent_id] = number
            record.stepped_down_at = datetime.now(UTC).isoformat()
            record.save()
        if self.on_change is not None:
            self.on_change()
        return number

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
        """A waiting agent holds the desktop now. An agent that held it goes
        back to the front of the line, asking for it; if the user held it, the user's hold just ends."""
        kicked = None
        with self.lock:
            record = self.vms.get(vm_name)
            if desktop not in record.desktops:
                raise ValueError(f"{vm_name} has no desktop {desktop}")
            line = record.desktops[desktop]
            if line["holder"] == agent_id:
                return
            if agent_id not in record.queue:
                raise ValueError(f"{agent_id} is not waiting for {vm_name}")
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

    def move_up(self, vm_name: str, agent_id: str) -> None:
        """An agent that got priority while it waits: ahead of everyone without it, behind the others with it, the place
        join gives it."""
        with self.lock:
            record = self.vms.get(vm_name)
            if agent_id not in record.queue:
                raise ValueError(f"{agent_id} is not waiting for {vm_name}")
            record.queue.remove(agent_id)
            place = 0
            while place < len(record.queue) and record.queue[place] in self.prioritized:
                place += 1
            record.queue.insert(place, agent_id)
            record.save()
        if self.on_change is not None:
            self.on_change()

    def remove(self, vm_name: str, agent_id: str) -> None:
        """The user takes an agent out of the line, or away from holding (then the next one gets the desktop). Its runs go on."""
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
        """(VM name, 0 when holding a desktop or its place in the line) or (None, None) when in no line. Which desktop:
        the VM record's desktop_of(agent_id)."""
        with self.lock:
            for record in self.vms.list():
                for line in record.desktops.values():
                    if line["holder"] == agent_id:
                        return record.name, 0
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
        gets it."""
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
