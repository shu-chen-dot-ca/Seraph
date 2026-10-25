"""The agent's VM tools: the Computer's actions, as tools Claude can call.

Only turns tool calls into Computer calls and Computer results into tool
results. What each action does inside the VM lives in computer_use.py.
An exception raised here reaches Claude as a failed tool call.

An agent works on one VM, its target VM, and only while it holds it (VMQueue).
Every tool except wait (and the env tools' part for all VMs, below) checks that first and refuses otherwise, so an agent that
waits in line, or lost the VM to the user, can't touch it. The target can change
between jobs, so it is looked up on every call.

Every tool that touches the VM checks it next, so if the VM stops in the middle
of a job the next tool call fails with the reason. The agent never has to poll;
the check tool is there for asking up front.

The VM's environment variables are the user's secrets: the agent may see their
names and whether each has a value, never the values. It may add a new, empty
one (for the user to fill in) and remove ones that are still empty; it can never
set, change or remove a value. Commands it runs do get them (they are in every
login shell), and any value that shows up in a command's output is replaced by
[hidden] before the agent sees it. The same goes for the ones for all VMs (the
Settings dialog): any agent may list their names and add or remove empty ones
(for_all_vms), also while it holds no VM, since they belong to no one VM.

The agent may lock the human's mouse and keyboard out of the desktop while it
works there: once per turn. The user can unlock it any time, and then it stays
unlocked for the rest of the turn. A lock the agent set ends with its turn
(Agents calls end_turn after every turn, also one that failed or was cancelled).

Nothing is written to the agent's history here: the Agent adds a tool entry
(with describe()'s line) and a tool_result entry for every call itself.

Computer calls block (they run `incus exec`), so they run in a thread and the
backend keeps answering other requests meanwhile. Every command the agent runs
in the VM is tagged with its id, so when it loses the VM (the user took it, gave
it to another agent, removed or deleted it) cancel() kills whatever it still
had running there: a long bash command, typing, a server it started.

    tools = ComputerTools(vms, agent["id"], lambda: agent["target_vm"], agent["history"]).list()
"""

import asyncio
import base64

from claude_agent_sdk import tool

from sandbox.agent.computer_use import Computer
from sandbox.vms import VMRecord, VMs, VMsError

# The only waits the agent can pick. Short ones are for things that are about
# instant; for something slow it waits 10s at a time and looks in between.
WAIT_SECONDS = [1, 3, 10, 30]
# Values shorter than this are not hidden in output: hiding "1" or "yes" would garble
# everything, and values that short are not secrets.
HIDE_MIN_LENGTH = 4
NOT_HOLDER = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."


class ComputerTools:
    def __init__(self, vms: VMs, agent_id: str, get_target_vm, history: list):
        self.vms = vms
        self.agent_id = agent_id
        # Returns the agent's target VM name (or None), read fresh on every call.
        self.get_target_vm = get_target_vm
        # The agent's history. Only kept for the Agent; the tools don't write to it.
        self.history = history
        # Whether lock_desktop was used in this turn (allowed once per turn).
        self.locked_this_turn = False
        # The VM this agent locked, so end_turn unlocks that one.
        self.locked_record: VMRecord | None = None
        # Every command it runs in a VM carries this (Computer, VM.exec), so cancel() finds them.
        self.tag = f"sandbox-agent-{agent_id}"

    def held_vm(self) -> VMRecord:
        """The agent's target VM, if the agent holds it. Raises (a failed tool call) otherwise."""
        name = self.get_target_vm()
        if name is None:
            raise ValueError(NOT_HOLDER)
        record = self.vms.get(name)
        if record.holder != self.agent_id:
            raise ValueError(NOT_HOLDER)
        return record

    def list(self) -> list:
        return [
            tool("check", "Check that the VM is running and its desktop can be used.", {})(self.check),
            tool("screenshot", "See the VM's screen. Coordinates in other tools are pixels of this image.", {})(self.screenshot),
            tool(
                "click",
                "Click at (x, y). button: left, middle or right. count: 2 for a double click.",
                {"x": int, "y": int, "button": str, "count": int},
            )(self.click),
            tool("drag", "Hold the left mouse button at (x1, y1), move to (x2, y2) and let go.", {"x1": int, "y1": int, "x2": int, "y2": int})(self.drag),
            tool("type", "Type text where the keyboard focus is.", {"text": str})(self.type),
            tool("key", "Press a key or combo, in xdotool names: Return, Escape, Tab, BackSpace, ctrl+l, ctrl+shift+t.", {"keys": str})(self.key),
            tool(
                "scroll",
                "Scroll with the mouse at (x, y). direction: up, down, left or right. amount: wheel clicks, 3 is about a third of a page.",
                {"x": int, "y": int, "direction": str, "amount": int},
            )(self.scroll),
            tool(
                "wait",
                "Wait before looking again with screenshot. seconds: 1 for things that are instant (a menu opening), 3 for things that are "
                "nearly instant (a window or page opening), 10 or 30 for slow things (installs, downloads, builds). "
                "Prefer checking often: for something that takes about 40 seconds, wait 10 four times and look in between, not 30 twice.",
                {"type": "object", "properties": {"seconds": {"type": "integer", "enum": WAIT_SECONDS}}, "required": ["seconds"]},
            )(self.wait),
            tool(
                "bash",
                "Run a shell command in the VM as the desktop user, in their home folder. "
                "The user's environment variables are set in it; their values are replaced by [hidden] in the output. "
                "Only the last 50000 bytes of stdout and of stderr come back.",
                {"command": str},
            )(self.bash),
            tool(
                "vm_start",
                "Start the VM when it is off (takes about a minute; returns when the desktop is up).",
                {},
            )(self.vm_start),
            tool(
                "vm_stop",
                "Shut the VM down. Its disk is kept, so vm_start brings everything back except what was running.",
                {},
            )(self.vm_stop),
            tool(
                "vm_health",
                "See how the VM is doing, even when it is frozen: on or off, whether it still answers, memory and swap in use, "
                "the processes using the most memory, and recent out-of-memory kills or crashes from its console. "
                "Use it when the VM stops answering, a command gets killed, or things get slow.",
                {},
            )(self.vm_health),
            tool(
                "vm_restart",
                "Restart the VM; a frozen one is forced off first. Its disk is kept, but everything running in it ends "
                "(servers, test runs, open windows). Returns when the desktop is up again.",
                {},
            )(self.vm_restart),
            tool(
                "desktop_log_out",
                "Log the desktop user out: the desktop session ends and its windows close. "
                "Things running in the browser terminals keep going.",
                {},
            )(self.desktop_log_out),
            tool(
                "desktop_log_in",
                "Log the desktop user back in after a log out (returns when the desktop is up).",
                {},
            )(self.desktop_log_in),
            tool(
                "lock_desktop",
                "Lock the user's mouse and keyboard out of the desktop and terminals while you control the desktop, "
                "so they can't get in your way. Only once per turn; it ends when your turn ends. "
                "The user can unlock it any time, and then you can't lock it again this turn.",
                {},
            )(self.lock_desktop),
            tool(
                "unlock_desktop",
                "Give the user back their mouse and keyboard as soon as you are done controlling the desktop. "
                "Only undoes your own lock, and you can't lock again this turn.",
                {},
            )(self.unlock_desktop),
            tool(
                "env_vars",
                "List the environment variables the user set: this VM's own (while you hold it) and the ones for all VMs. "
                "Each name and whether it has a value, never the values; use them in commands as $NAME. Works without a VM too.",
                {},
            )(self.env_vars),
            tool(
                "env_var_add",
                "Add a new, empty environment variable for a secret the job needs (e.g. OPENAI_API_KEY), "
                "then ask the user to fill in its value. for_all_vms: false (default) adds it to the VM you hold, for the "
                "VM's Settings tab; true adds it for every VM, for Settings at the bottom of the sidebar (no VM needed): "
                "for secrets that aren't about one VM, like an API key every job uses. Only for secrets: anything else "
                "(settings, config) goes in files in the VM.",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "for_all_vms": {"type": "boolean"}},
                    "required": ["name"],
                },
            )(self.env_var_add),
            tool(
                "env_var_remove",
                "Remove an environment variable that is still empty: this VM's own, or with for_all_vms: true one for all VMs. "
                "Ones with a value can't be removed.",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "for_all_vms": {"type": "boolean"}},
                    "required": ["name"],
                },
            )(self.env_var_remove),
        ]

    def describe(self, name: str, args: dict) -> str:
        """One line for the chat, saying what a tool call is about to do."""
        if name == "check":
            return "Checking the VM"
        if name == "screenshot":
            return "Taking a screenshot"
        if name == "click":
            what = "Double-clicking" if args.get("count") == 2 else "Clicking"
            if args.get("button") == "right":
                what = "Right-clicking"
            return f"{what} at ({args.get('x')}, {args.get('y')})"
        if name == "drag":
            return f"Dragging from ({args.get('x1')}, {args.get('y1')}) to ({args.get('x2')}, {args.get('y2')})"
        if name == "type":
            text = str(args.get("text", "")).replace("\n", " ").replace("`", "'")[:80]
            return f"Typing `{text}`"
        if name == "key":
            return f"Pressing `{args.get('keys')}`"
        if name == "scroll":
            return f"Scrolling {args.get('direction')}"
        if name == "wait":
            return f"Waiting {args.get('seconds')} seconds"
        if name == "bash":
            command = str(args.get("command", "")).replace("\n", " ").replace("`", "'")[:160]
            return f"Running `{command}`"
        if name == "env_vars":
            return "Looking at the environment variable names"
        if name == "env_var_add" and args.get("for_all_vms"):
            return f"Adding the environment variable `{args.get('name')}` for all VMs (empty, for you to fill in)"
        if name == "env_var_add":
            return f"Adding the environment variable `{args.get('name')}` (empty, for you to fill in)"
        if name == "env_var_remove" and args.get("for_all_vms"):
            return f"Removing the empty environment variable `{args.get('name')}` for all VMs"
        if name == "env_var_remove":
            return f"Removing the empty environment variable `{args.get('name')}`"
        if name == "vm_start":
            return "Starting the VM"
        if name == "vm_stop":
            return "Shutting the VM down"
        if name == "vm_health":
            return "Checking the VM's health"
        if name == "vm_restart":
            return "Restarting the VM"
        if name == "desktop_log_out":
            return "Logging out of the desktop"
        if name == "desktop_log_in":
            return "Logging in to the desktop"
        if name == "unlock_desktop":
            return "Unlocking the desktop: your mouse and keyboard work again"
        if name == "lock_desktop":
            return "Locking your mouse and keyboard out of the desktop while I work (you can unlock it any time)"
        return f"Using {name}"

    async def check(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        width, height = await asyncio.to_thread(computer.screen_size)
        return {"content": [{"type": "text", "text": f"The VM is running and its desktop is up ({width}x{height} pixels)."}]}

    async def screenshot(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        width, height = await asyncio.to_thread(computer.screen_size)
        jpeg = await asyncio.to_thread(computer.screenshot)
        return {
            "content": [
                {"type": "text", "text": f"Screen is {width}x{height} pixels."},
                {"type": "image", "data": base64.b64encode(jpeg).decode(), "mimeType": "image/jpeg"},
            ]
        }

    async def click(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.click, args["x"], args["y"], args["button"], args["count"])
        return {"content": [{"type": "text", "text": "Clicked."}]}

    async def drag(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.drag, args["x1"], args["y1"], args["x2"], args["y2"])
        return {"content": [{"type": "text", "text": "Dragged."}]}

    async def type(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.type, args["text"])
        return {"content": [{"type": "text", "text": "Typed."}]}

    async def key(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.key, args["keys"])
        return {"content": [{"type": "text", "text": f"Pressed {args['keys']}."}]}

    async def scroll(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.scroll, args["x"], args["y"], args["direction"], args["amount"])
        return {"content": [{"type": "text", "text": "Scrolled."}]}

    async def wait(self, args: dict) -> dict:
        seconds = args["seconds"]
        if seconds not in WAIT_SECONDS:
            raise ValueError(f"seconds must be one of {WAIT_SECONDS}")
        await asyncio.sleep(seconds)
        return {"content": [{"type": "text", "text": f"Waited {seconds} seconds."}]}

    async def bash(self, args: dict) -> dict:
        record = self.held_vm()
        computer = Computer(record.vm, self.tag)
        await asyncio.to_thread(computer.check)
        output = await asyncio.to_thread(computer.bash, args["command"])
        # The VM may have been taken from it while the command ran: then its output is not its to see.
        if record.holder != self.agent_id:
            raise ValueError("You lost the VM while the command ran; it was stopped. " + NOT_HOLDER)
        # Read after the command: the user may have changed them meanwhile.
        # Longest first, so a value that contains another one is hidden whole.
        values = sorted(list(record.global_env.values()) + list(record.env.values()), key=len, reverse=True)
        for value in values:
            if len(value) >= HIDE_MIN_LENGTH:
                output = output.replace(value, "[hidden]")
        return {"content": [{"type": "text", "text": output}]}

    async def env_vars(self, args: dict) -> dict:
        # The VM's own only while it holds the VM; the ones for all VMs always. Names and set or empty, never values.
        own = {}
        lines = []
        try:
            own = self.held_vm().env
        except (ValueError, VMsError):
            lines.append("(You hold no VM, so only the ones for all VMs are listed.)")
        for name, value in own.items():
            lines.append(f"{name}: {'set' if value else 'empty'}")
        for name, value in VMRecord.global_env.items():
            # The VM's own value wins over the one for all VMs.
            if own.get(name):
                continue
            lines.append(f"{name}: {'set' if value else 'empty'} (for all VMs)")
        if not own and not VMRecord.global_env:
            lines.append("No environment variables are set.")
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

    async def env_var_add(self, args: dict) -> dict:
        name = args["name"]
        # Only ever an empty one: agents can't set a value, here or anywhere.
        if args.get("for_all_vms"):
            await asyncio.to_thread(self.vms.add_empty_global_env, name)
            text = f"Added {name} for all VMs, empty. Ask the user to fill it in in Settings (at the bottom of the sidebar)."
            return {"content": [{"type": "text", "text": text}]}
        record = self.held_vm()
        if name in record.env:
            raise ValueError(f"{name} already exists")
        if record.global_env.get(name):
            raise ValueError(f"{name} is already set, for all VMs")
        env = dict(record.env)
        env[name] = ""
        await asyncio.to_thread(record.set_env, env)
        return {"content": [{"type": "text", "text": f"Added {name}, empty. Ask the user to fill it in in the VM's Settings tab."}]}

    async def env_var_remove(self, args: dict) -> dict:
        name = args["name"]
        if args.get("for_all_vms"):
            await asyncio.to_thread(self.vms.remove_empty_global_env, name)
            return {"content": [{"type": "text", "text": f"Removed {name} for all VMs."}]}
        record = self.held_vm()
        if name not in record.env:
            raise ValueError(f"There is no {name}")
        if record.env[name] != "":
            raise ValueError(f"{name} has a value; only the user can remove it")
        env = dict(record.env)
        del env[name]
        await asyncio.to_thread(record.set_env, env)
        return {"content": [{"type": "text", "text": f"Removed {name}."}]}

    async def vm_start(self, args: dict) -> dict:
        record = self.held_vm()
        if await asyncio.to_thread(record.vm.status) == "Running":
            return {"content": [{"type": "text", "text": "The VM is already running."}]}
        await asyncio.to_thread(record.start)
        return {"content": [{"type": "text", "text": "The VM is running and its desktop is up."}]}

    async def vm_stop(self, args: dict) -> dict:
        record = self.held_vm()
        if await asyncio.to_thread(record.vm.status) != "Running":
            return {"content": [{"type": "text", "text": "The VM is already off."}]}
        await asyncio.to_thread(record.stop)
        return {"content": [{"type": "text", "text": "The VM is off."}]}

    async def vm_health(self, args: dict) -> dict:
        record = self.held_vm()
        lines = []
        state = await asyncio.to_thread(record.vm.state)
        if state is None:
            return {"content": [{"type": "text", "text": "The VM doesn't exist."}]}
        lines.append(f"Status: {state['status']}")
        responds = False
        if state["status"] == "Running":
            lines.append(f"Memory in use (seen from outside): {state['memory']['usage'] / 1024**3:.1f} of {record.memory_gb} GB")
            responds = await asyncio.to_thread(record.vm.responds)
            lines.append("Answers commands: yes" if responds else "Answers commands: NO (frozen or still booting)")
        if responds:
            # As root, so it works even when the desktop user's processes are stuck.
            result = await asyncio.to_thread(
                record.vm.exec_root,
                "uptime; echo; free -h; echo; ps -eo pid,user,rss,pcpu,etime,args --sort=-rss | head -9 | cut -c1-160",
                30,
            )
            lines.append("")
            lines.append(result.stdout.strip() or result.stderr.strip())

        # Out-of-memory kills and crashes, from the console log (readable even when frozen).
        log = await asyncio.to_thread(record.vm.console_log)
        events = []
        for line in log.splitlines():
            lowered = line.lower()
            if "out of memory" in lowered or "killed process" in lowered or "segv" in lowered or "freezing execution" in lowered or "kernel panic" in lowered or "hung task" in lowered:
                events.append(line.strip()[:200])
        lines.append("")
        if events:
            lines.append("Recent trouble on the console (since the VM last started):")
            lines.extend(events[-10:])
        else:
            lines.append("No out-of-memory kills or crashes on the console since the VM last started.")
        # Process command lines can hold the user's secrets (e.g. --api-key "$KEY"): hidden as in bash.
        text = "\n".join(lines)
        for value in sorted(list(record.global_env.values()) + list(record.env.values()), key=len, reverse=True):
            if len(value) >= HIDE_MIN_LENGTH:
                text = text.replace(value, "[hidden]")
        return {"content": [{"type": "text", "text": text}]}

    async def vm_restart(self, args: dict) -> dict:
        record = self.held_vm()
        await asyncio.to_thread(record.restart)
        return {"content": [{"type": "text", "text": "The VM restarted and its desktop is up. Everything that was running in it has ended."}]}

    async def desktop_log_out(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.log_out)
        return {"content": [{"type": "text", "text": "Logged out. The desktop shows the login screen until desktop_log_in."}]}

    async def desktop_log_in(self, args: dict) -> dict:
        computer = Computer(self.held_vm().vm, self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.log_in)
        return {"content": [{"type": "text", "text": "Logged in; the desktop is up."}]}

    async def lock_desktop(self, args: dict) -> dict:
        record = self.held_vm()
        if self.locked_this_turn:
            raise ValueError("The desktop was already locked once this turn; it can't be locked again until your next turn")
        if record.locked_by is not None:
            return {"content": [{"type": "text", "text": "The desktop is already locked (by the user)."}]}
        self.locked_this_turn = True
        self.locked_record = record
        record.locked_by = "agent"
        # Not saved (runtime only), so tell the live feed directly.
        self.vms.changed()
        return {"content": [{"type": "text", "text": "Locked. It unlocks when your turn ends, or when the user unlocks it."}]}

    async def unlock_desktop(self, args: dict) -> dict:
        record = self.held_vm()
        if record.locked_by == "user":
            return {"content": [{"type": "text", "text": "The user locked it themselves; leave it to them."}]}
        if record.locked_by is None:
            return {"content": [{"type": "text", "text": "It isn't locked."}]}
        record.locked_by = None
        self.locked_record = None
        self.vms.changed()
        return {"content": [{"type": "text", "text": "Unlocked. You can't lock again this turn."}]}

    def cancel(self, vm_name: str) -> None:
        """The agent lost vm_name: kill everything it still runs there. Blocking (an incus call)."""
        try:
            record = self.vms.get(vm_name)
            if record.vm.status() != "Running":
                return
            record.vm.kill_tagged(self.tag)
        except Exception:
            # The VM is gone, stopped meanwhile or not answering: nothing of the agent's runs in it then.
            pass

    def end_turn(self) -> None:
        """The agent's turn is over: undo its lock (not the user's), and allow locking again next turn."""
        if self.locked_record is not None and self.locked_record.locked_by == "agent":
            self.locked_record.locked_by = None
            self.vms.changed()
        self.locked_record = None
        self.locked_this_turn = False
