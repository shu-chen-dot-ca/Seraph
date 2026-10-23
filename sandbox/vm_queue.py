"""Who uses each VM: one holder and a line of waiting agents.

An agent joins its target VM's queue (queue_for_vm). If nobody holds the VM and nobody waits,
it holds it at once; otherwise it waits, even while the VM is off. When the holder releases,
the first in line becomes the holder and Agents hears about it (on_grant), which wakes that agent.
An agent is in at most one VM's line (holding or waiting) at a time.

The user can take a VM over (the agent holding it goes back to the front of the line), give it
to a waiting agent, move an agent to the front, or remove an agent from the line or from holding.
An agent that loses its place because of the user is told through on_kick (Agents interrupts it).
on_change runs after every change, so the agent list (which shows each agent's place) is sent again.

The state lives in each VMRecord (holder, queue) and is saved with it, so it survives a restart.
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
        # Set by Agents. on_grant(vm_name, agent_id): an agent became the holder while it waited.
        # on_kick(vm_name, agent_id, reason): the user took the VM or its place away.
        # on_change(): any holder or line changed.
        self.on_grant = None
        self.on_kick = None
        self.on_change = None

    def join(self, vm_name: str, agent_id: str) -> int:
        """0 if the agent holds the VM now, else its place in line (1 is next). Joining again gives the same answer.

        A VM granted right here is not reported through on_grant: the caller learns it from the 0.
        """
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder == agent_id:
                return 0
            if agent_id in record.queue:
                return record.queue.index(agent_id) + 1
            for other in self.vms.list():
                if other.holder == agent_id or agent_id in other.queue:
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
        """The holder (an agent id or "user") is done; the first in line gets the VM."""
        granted = None
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder != who:
                raise ValueError(f"{who} doesn't hold {vm_name}")
            record.holder = None
            if record.queue:
                granted = record.queue.pop(0)
                record.holder = granted
            record.save()
        if self.on_change is not None:
            self.on_change()
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
        """A waiting agent holds the VM now. An agent that held it goes back to the front of the line;
        if the user held it, the user's hold just ends."""
        kicked = None
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder == agent_id:
                return
            if agent_id not in record.queue:
                raise ValueError(f"{agent_id} is not waiting for {vm_name}")
            record.queue.remove(agent_id)
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
        """The user takes an agent out of the line, or away from holding (then the next in line gets the VM)."""
        granted = None
        with self.lock:
            record = self.vms.get(vm_name)
            if record.holder != agent_id and agent_id not in record.queue:
                raise ValueError(f"{agent_id} is not holding or waiting for {vm_name}")
            if record.holder == agent_id:
                reason = f"The user removed you from {vm_name}; you don't hold it anymore."
                record.holder = None
            else:
                reason = f"The user removed you from {vm_name}'s queue."
                record.queue.remove(agent_id)
            # The next in line gets a VM nobody holds.
            if record.holder is None and record.queue:
                granted = record.queue.pop(0)
                record.holder = granted
            record.save()
        if self.on_change is not None:
            self.on_change()
        if self.on_kick is not None:
            self.on_kick(vm_name, agent_id, reason)
        if granted is not None and self.on_grant is not None:
            self.on_grant(vm_name, granted)

    def leave_all(self, agent_id: str) -> None:
        """The agent is deleted: out of every line, without on_kick. A VM it held goes to the next in line."""
        grants = []
        with self.lock:
            for record in self.vms.list():
                if record.holder != agent_id and agent_id not in record.queue:
                    continue
                if agent_id in record.queue:
                    record.queue.remove(agent_id)
                if record.holder == agent_id:
                    record.holder = None
                # A VM nobody holds goes to the first in line.
                if record.holder is None and record.queue:
                    record.holder = record.queue.pop(0)
                    grants.append((record.name, record.holder))
                record.save()
        if self.on_change is not None:
            self.on_change()
        if self.on_grant is None:
            return
        for vm_name, granted in grants:
            self.on_grant(vm_name, granted)

    def place(self, agent_id: str) -> tuple[str | None, int | None]:
        """(VM name, 0 when holding or its place in line) or (None, None) when in no line."""
        with self.lock:
            for record in self.vms.list():
                if record.holder == agent_id:
                    return record.name, 0
                if agent_id in record.queue:
                    return record.name, record.queue.index(agent_id) + 1
        return None, None
