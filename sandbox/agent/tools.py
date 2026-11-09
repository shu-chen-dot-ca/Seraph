"""The agent's VM tools: the Computer's actions, as tools Claude can call.

Only turns tool calls into Computer calls and Computer results into tool
results. What each action does inside the VM lives in computer_use.py.
An exception raised here reaches Claude as a failed tool call.

An agent works on one VM, its target VM, and only while it holds one of its desktops (VMQueue). Its tools act on
that desktop alone: its screen, mouse and keyboard, and commands run as that desktop's user, in its home folder
(sandbox/vm.py). Agents on the VM's other desktops work at the same time without getting in each other's way.
Every tool except wait (and the env tools' part for all VMs, below) checks that first and refuses otherwise, so an agent that
waits in line, or lost the desktop to the user, can't touch it. The target can change
between jobs, so it is looked up on every call.

Every tool that touches the VM checks it next, so if the VM stops in the middle
of a job the next tool call fails with the reason. The agent never has to poll;
the check tool is there for asking up front.

The VM's environment variables are the user's secrets: the agent may see their
names and whether each has a value, never the values. It may add a new, empty
one (for the user to fill in; it says so in the chat, not in the Inbox, and the app
tells it once the user did) and remove ones that are still empty; it can never
set, change or remove a value. Commands it runs do get them (they are in every
login shell), and any value that shows up in a command's output is replaced by
[hidden] before the agent sees it. The same goes for the ones for all VMs (the
Settings dialog): any agent may list their names and add or remove empty ones
(for_all_vms), also while it holds no VM, since they belong to no one VM.

bash can show a command live in a terminal window on the desktop (visible), and start programs
on the desktop (on_desktop), so the user sees long runs and the app being tried, not only the agent.
A visible command is a run (long_runs.py): it goes on in the VM by itself. bash waits for it up to
long_runs.FOREGROUND_SECONDS, then leaves it going in the background;
background: true returns at once. A run in the background is collected by the app (agents.py), which gives the agent
its result (bash_result) in a message.
While another agent's run goes in the VM, or another agent holds one of its other desktops, vm_stop and vm_restart
are refused (they would end that work), unless the VM no longer answers.

The browser_* tools are the agent's own web browser in the VM (sandbox/agent/browser_service.py): a Firefox that
isn't on the desktop, which the agent reads as text with numbered things to click or fill in, instead of
screenshots and mouse clicks, and which fetches a site's data (JSON) straight into a file. Each desktop has its own
browser service (so files land in that desktop's home), and each agent its own session (tabs, cookies) in it. Page text has the user's secrets hidden like bash output.

The agent may lock the human's mouse and keyboard out of its desktop while it
works there: once per turn. The user can unlock it any time, and then it stays
unlocked for the rest of the turn. A lock the agent set ends with its turn
(Agents calls end_turn after every turn, also one that failed or was cancelled).

Before a click, drag or scroll, the VM page shows the agent's cursor gliding to that place (record.pointers,
AgentCursor.tsx), and the action waits GLIDE_SECONDS for it to get there, so the user sees where it clicks.

Nothing is written to the agent's history here: the Agent adds a tool entry
(with describe()'s line) and a tool_result entry for every call itself.

Computer calls block (they run `incus exec`), so they run in a thread and the
backend keeps answering other requests meanwhile. Every command the agent runs
in the VM is tagged with its id, so when it loses the VM (the user took it, gave
it to another agent, removed or deleted it) cancel() kills whatever it still
had running there: a bash command, typing, a server it started. Its runs have their own tags and go on.

    tools = ComputerTools(vms, queue, agent["id"], lambda: agent["target_vm"], agent["history"]).list()
"""

import asyncio
import base64
import json

from claude_agent_sdk import tool

from sandbox.agent import long_runs
from sandbox.agent.computer_use import Computer
from sandbox.vm import BROWSER_DIR, BROWSER_PORT, VM
from sandbox.vms import VMRecord, VMs, VMsError

# The only waits the agent can pick. Short ones are for things that are about
# instant; for something slow it waits 10s at a time and looks in between.
WAIT_SECONDS = [1, 3, 10, 30]
# How long a click, drag or scroll waits for the agent's cursor to glide there on the VM page: the page hears of it
# within 0.25 s and the glide takes 0.7 s (AgentCursor.tsx).
GLIDE_SECONDS = 1
# Values shorter than this are not hidden in output: hiding "1" or "yes" would garble
# everything, and values that short are not secrets.
HIDE_MIN_LENGTH = 4
NOT_HOLDER = "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."
# One call to the agents' browser of a desktop in the VM, with its port before it: the request on stdin, the answer
# on stdout (sandbox/agent/browser_service.py).
BROWSER_CALL = f"python3 {BROWSER_DIR}/browser_service.py call"


class ComputerTools:
    def __init__(self, vms: VMs, queue, agent_id: str, get_target_vm, history: list):
        self.vms = vms
        # The VM queue (sandbox/vm_queue.py), which keeps the runs going in each VM.
        self.queue = queue
        self.agent_id = agent_id
        # Returns the agent's target VM name (or None), read fresh on every call.
        self.get_target_vm = get_target_vm
        # The agent's history. Only kept for the Agent; the tools don't write to it.
        self.history = history
        # Whether lock_desktop was used in this turn (allowed once per turn).
        self.locked_this_turn = False
        # The VM and desktop this agent locked, so end_turn unlocks that one.
        self.locked_record: VMRecord | None = None
        self.locked_desktop = 1
        # Every command it runs in a VM carries this (Computer, VM.exec), so cancel() finds them.
        self.tag = f"sandbox-agent-{agent_id}"

    def held_vm(self) -> VMRecord:
        """The agent's target VM, if the agent holds one of its desktops. Raises (a failed tool call) otherwise."""
        name = self.get_target_vm()
        if name is None:
            raise ValueError(NOT_HOLDER)
        record = self.vms.get(name)
        if record.holding(self.agent_id) is None:
            raise ValueError(NOT_HOLDER)
        return record

    def held_desktop(self) -> VM:
        """The desktop the agent holds, as a VM that runs commands as its user. Raises (a failed tool call) otherwise."""
        record = self.held_vm()
        return record.desktop_vm(record.holding(self.agent_id))

    def list(self) -> list:
        return [
            tool("check", "Check that the VM is running and your desktop can be used.", {})(self.check),
            tool("screenshot", "See your desktop's screen. Coordinates in other tools are pixels of this image.", {})(self.screenshot),
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
                "Run a shell command in the VM as your desktop's user, in their home folder. "
                "The user's environment variables are set in it; their values are replaced by [hidden] in the output. "
                "Only the last 50000 bytes of stdout and of stderr come back. visible: true shows the command live in a terminal "
                "window on the desktop while it runs, so the user can follow it; use it for anything that takes a while (installs, "
                "builds, test runs); its output then comes back as one, stdout and stderr together. A visible command still "
                f"running after {long_runs.FOREGROUND_SECONDS // 60} minutes goes on in the background, and you get its result in a message when it "
                "ends. background: true starts it that way at once (shown in the window too), for anything you expect to take "
                "more than about 5 minutes (a big install, a build): then do what else you have in this VM, or end your turn: "
                "you keep your desktop meanwhile. "
                "To start a program or a terminal window on the desktop, prefix it with on_desktop and put it "
                "in the background with its output in a file, e.g. `on_desktop nohup python app.py > ~/app.log 2>&1 &` or "
                "`on_desktop gnome-terminal -- bash -c 'cd ~/proj && python demo.py; exec bash'` (konsole -e on a KDE desktop).",
                {
                    "type": "object",
                    "properties": {"command": {"type": "string"}, "visible": {"type": "boolean"}, "background": {"type": "boolean"}},
                    "required": ["command"],
                },
            )(self.bash),
            tool(
                "vm_start",
                "Start the VM when it is off (takes about a minute; returns when the desktop is up).",
                {},
            )(self.vm_start),
            tool(
                "vm_stop",
                "Shut the VM down. Its disk is kept, so vm_start brings everything back except what was running. "
                "Refused while another agent works on one of its other desktops.",
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
                "(servers, test runs, open windows) on every desktop. Returns when the desktop is up again. Refused while "
                "another agent works on one of its other desktops, unless the VM stopped answering.",
                {},
            )(self.vm_restart),
            tool(
                "desktop_log_out",
                "Log your desktop's user out: the desktop session ends and its windows close. "
                "Things running in the browser terminals keep going, and so do the VM's other desktops.",
                {},
            )(self.desktop_log_out),
            tool(
                "desktop_log_in",
                "Log the desktop user back in after a log out (returns when the desktop is up).",
                {},
            )(self.desktop_log_in),
            tool(
                "lock_desktop",
                "Lock the user's mouse and keyboard out of your desktop and terminals while you control the desktop, "
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
                "then say so to the user in your message (not draft_question): the app tells you once they fill it in. "
                "for_all_vms: false (default) adds it to the VM you hold, for the "
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
            tool(
                "browser_open",
                "Open a web page in your own browser in the VM: a Firefox that is not on the desktop (nobody sees it, and it "
                "never gets in the way of the desktop). Returns the page as text, with the things to click or fill in numbered "
                "for browser_click, browser_type and browser_select. Your browser keeps its tabs and cookies between calls, until "
                "browser_close, 30 minutes unused or the VM restarting; every agent has its own.",
                {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
            )(self.browser_open),
            tool(
                "browser_read",
                "Read the page your browser is on again: after it changed by itself, or the next part of a long page. "
                "start: the character to start the text at (a long page says where to go on). find: only the lines of text, "
                "and the numbered things, that contain this.",
                {"type": "object", "properties": {"start": {"type": "integer"}, "find": {"type": "string"}}},
            )(self.browser_read),
            tool(
                "browser_click",
                "Click a numbered thing from the last page you read in your browser (a link, button, checkbox, tab). "
                "Returns the page after it, with fresh numbers.",
                {"type": "object", "properties": {"ref": {"type": "integer"}}, "required": ["ref"]},
            )(self.browser_click),
            tool(
                "browser_type",
                "Type text into a numbered field in your browser; what was in it is replaced. enter: true presses Enter "
                "after it (to search or send a form). Returns the page after it.",
                {
                    "type": "object",
                    "properties": {"ref": {"type": "integer"}, "text": {"type": "string"}, "enter": {"type": "boolean"}},
                    "required": ["ref", "text"],
                },
            )(self.browser_type),
            tool(
                "browser_select",
                "Pick an option, by its text, in a numbered drop-down in your browser. Returns the page after it.",
                {"type": "object", "properties": {"ref": {"type": "integer"}, "option": {"type": "string"}}, "required": ["ref", "option"]},
            )(self.browser_select),
            tool(
                "browser_fetch",
                "Get a web address's raw answer (JSON, CSV, a file) through your browser, with its cookies: for a site's data, "
                "instead of reading it off pages. save_to: a file in the VM (from the home folder) to save all of it in, for "
                "big answers you then work on with bash (jq, python); without it the text comes back here, cut at 20000 "
                "characters. GET by default. method and body (text, e.g. JSON) for anything else; that is sent from the page "
                "you have open, so open the site first. A site with a bot check: open one of its pages with browser_open "
                "first, so the check passes, then fetch.",
                {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "method": {"type": "string"},
                        "body": {"type": "string"},
                        "save_to": {"type": "string"},
                    },
                    "required": ["url"],
                },
            )(self.browser_fetch),
            tool(
                "browser_screenshot",
                "See the page your browser is on, when its text isn't enough (a layout, a picture, a chart).",
                {},
            )(self.browser_screenshot),
            tool(
                "browser_close",
                "Close your browser: its tabs and cookies are gone. The next browser_open starts afresh.",
                {},
            )(self.browser_close),
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
            if args.get("background"):
                return f"Running `{command}` in the background (in a terminal on the desktop)"
            if args.get("visible"):
                return f"Running `{command}` (in a terminal on the desktop)"
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
        if name == "browser_open":
            return f"Opening {args.get('url')} in its browser"
        if name == "browser_read" and args.get("find"):
            return f"Reading the page in its browser, looking for `{args.get('find')}`"
        if name == "browser_read":
            return "Reading the page in its browser"
        if name == "browser_click":
            return f"Clicking [{args.get('ref')}] in its browser"
        if name == "browser_type":
            text = str(args.get("text", "")).replace("\n", " ").replace("`", "'")[:80]
            return f"Typing `{text}` into [{args.get('ref')}] in its browser"
        if name == "browser_select":
            return f"Picking `{args.get('option')}` in [{args.get('ref')}] in its browser"
        if name == "browser_fetch" and args.get("save_to"):
            return f"Fetching {args.get('url')} through its browser into `{args.get('save_to')}`"
        if name == "browser_fetch":
            return f"Fetching {args.get('url')} through its browser"
        if name == "browser_screenshot":
            return "Looking at the page in its browser"
        if name == "browser_close":
            return "Closing its browser"
        return f"Using {name}"

    async def check(self, args: dict) -> dict:
        computer = Computer(self.held_desktop(), self.tag)
        await asyncio.to_thread(computer.check)
        width, height = await asyncio.to_thread(computer.screen_size)
        return {"content": [{"type": "text", "text": f"The VM is running and its desktop is up ({width}x{height} pixels)."}]}

    async def screenshot(self, args: dict) -> dict:
        computer = Computer(self.held_desktop(), self.tag)
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
        record = self.held_vm()
        desktop = record.holding(self.agent_id)
        computer = Computer(record.desktop_vm(desktop), self.tag)
        await asyncio.to_thread(computer.check)
        # Its cursor glides there on the VM page first. A new dict, so a reader never sees one half changed.
        width, height = await asyncio.to_thread(computer.screen_size)
        pointer = {"agent": self.agent_id, "x": args["x"], "y": args["y"], "width": width, "height": height}
        record.pointers = {**record.pointers, desktop: pointer}
        self.vms.changed()
        await asyncio.sleep(GLIDE_SECONDS)
        # The desktop may have been taken from it meanwhile.
        if record.holding(self.agent_id) != desktop:
            raise ValueError(NOT_HOLDER)
        await asyncio.to_thread(computer.click, args["x"], args["y"], args["button"], args["count"])
        return {"content": [{"type": "text", "text": "Clicked."}]}

    async def drag(self, args: dict) -> dict:
        record = self.held_vm()
        desktop = record.holding(self.agent_id)
        computer = Computer(record.desktop_vm(desktop), self.tag)
        await asyncio.to_thread(computer.check)
        # Its cursor glides to the start on the VM page, then to the end.
        width, height = await asyncio.to_thread(computer.screen_size)
        pointer = {"agent": self.agent_id, "x": args["x1"], "y": args["y1"], "width": width, "height": height}
        record.pointers = {**record.pointers, desktop: pointer}
        self.vms.changed()
        await asyncio.sleep(GLIDE_SECONDS)
        pointer = {"agent": self.agent_id, "x": args["x2"], "y": args["y2"], "width": width, "height": height}
        record.pointers = {**record.pointers, desktop: pointer}
        self.vms.changed()
        await asyncio.sleep(GLIDE_SECONDS)
        if record.holding(self.agent_id) != desktop:
            raise ValueError(NOT_HOLDER)
        await asyncio.to_thread(computer.drag, args["x1"], args["y1"], args["x2"], args["y2"])
        return {"content": [{"type": "text", "text": "Dragged."}]}

    async def type(self, args: dict) -> dict:
        computer = Computer(self.held_desktop(), self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.type, args["text"])
        return {"content": [{"type": "text", "text": "Typed."}]}

    async def key(self, args: dict) -> dict:
        computer = Computer(self.held_desktop(), self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.key, args["keys"])
        return {"content": [{"type": "text", "text": f"Pressed {args['keys']}."}]}

    async def scroll(self, args: dict) -> dict:
        record = self.held_vm()
        desktop = record.holding(self.agent_id)
        computer = Computer(record.desktop_vm(desktop), self.tag)
        await asyncio.to_thread(computer.check)
        # Its cursor glides there on the VM page first.
        width, height = await asyncio.to_thread(computer.screen_size)
        pointer = {"agent": self.agent_id, "x": args["x"], "y": args["y"], "width": width, "height": height}
        record.pointers = {**record.pointers, desktop: pointer}
        self.vms.changed()
        await asyncio.sleep(GLIDE_SECONDS)
        if record.holding(self.agent_id) != desktop:
            raise ValueError(NOT_HOLDER)
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
        desktop = record.holding(self.agent_id)
        computer = Computer(record.desktop_vm(desktop), self.tag)
        await asyncio.to_thread(computer.check)
        if not args.get("visible") and not args.get("background"):
            output = await asyncio.to_thread(computer.bash, args["command"], 600)
            # The desktop may have been taken from it while the command ran: then its output is not its to see.
            if record.holding(self.agent_id) != desktop:
                raise ValueError("You lost the VM while the command ran; it was stopped. " + NOT_HOLDER)
            # Read after the command: the user may have changed them meanwhile.
            # Longest first, so a value that contains another one is hidden whole.
            values = sorted(list(record.global_env.values()) + list(record.env.values()), key=len, reverse=True)
            for value in values:
                if len(value) >= HIDE_MIN_LENGTH:
                    output = output.replace(value, "[hidden]")
            return {"content": [{"type": "text", "text": output}]}

        # A visible or background command is a run (long_runs.py): it goes on in the VM by itself.
        label = args["command"].strip().replace("\n", " ")[:300]
        run = await asyncio.to_thread(long_runs.start, record, self.agent_id, desktop, "bash", args["command"], label)
        self.queue.add_run(record.name, run)
        later = (
            f"you get its result in a message when it ends (all its output is in {run['log']} in the VM). If you have more "
            f"to do in {record.name} that doesn't touch what it works on, do it; otherwise end your turn: you keep your desktop "
            "meanwhile."
        )
        if args.get("background"):
            return {"content": [{"type": "text", "text": f"Started in the background as {run['id']}: " + later}]}
        result = await long_runs.wait(record, run, long_runs.FOREGROUND_SECONDS)
        if result is None or not self.queue.claim_run(run["id"]):
            text = f"Still running after {long_runs.FOREGROUND_SECONDS // 60} minutes, so it goes on in the background as {run['id']}: " + later
            return {"content": [{"type": "text", "text": text}]}
        text = self.bash_result(record, run, result)
        self.queue.finish_run(record.name, run["id"])
        return {"content": [{"type": "text", "text": text}]}

    def bash_result(self, record: VMRecord, run: dict, result: dict) -> str:
        """What the agent gets when its bash run ended (long_runs.check's result): how, and the end of its output, with
        the user's secrets hidden. Also for a run in the background, which agents.py collects."""
        seconds = result["seconds"]
        took = f"{seconds // 60}m {seconds % 60}s" if seconds >= 60 else f"{seconds}s"
        text = f"exit code {result['exit_code']}, after {took}"
        if result["ended"] == "timeout":
            text = f"Stopped after {long_runs.RUN_LIMIT_SECONDS // 3600} hours, the longest a run may take"
        if result["ended"] == "gone" and run["stopped_by_user"]:
            text = f"The user stopped it after {took}"
        if result["ended"] == "gone" and not run["stopped_by_user"]:
            text = "It ended without finishing: the VM stopped or restarted"
        output = result["output"]
        if len(output.encode()) >= long_runs.OUTPUT_LIMIT:
            output = f"[cut: only the last {long_runs.OUTPUT_LIMIT} bytes; all of it is in {run['log']}]\n{output}"
        text += f"\n--- output (stdout and stderr) ---\n{output}"
        # Read now: the user may have changed them while it ran. Longest first, so a value that contains another one is hidden whole.
        values = sorted(list(record.global_env.values()) + list(record.env.values()), key=len, reverse=True)
        for value in values:
            if len(value) >= HIDE_MIN_LENGTH:
                text = text.replace(value, "[hidden]")
        return text

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
            text = (
                f"Added {name} for all VMs, empty. Say in your message that it is for them to fill in, in Settings (at the bottom "
                "of the sidebar); no draft_question. You'll get a message once it has a value: go on with what doesn't need it."
            )
            return {"content": [{"type": "text", "text": text}]}
        record = self.held_vm()
        if name in record.env:
            raise ValueError(f"{name} already exists")
        if record.global_env.get(name):
            raise ValueError(f"{name} is already set, for all VMs")
        env = dict(record.env)
        env[name] = ""
        await asyncio.to_thread(record.set_env, env)
        text = (
            f"Added {name}, empty. Say in your message that it is for them to fill in, in the VM's Settings tab; no "
            "draft_question. You'll get a message once it has a value: go on with what doesn't need it."
        )
        return {"content": [{"type": "text", "text": text}]}

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
        # Another agent's run, or its work on another desktop, would end with it.
        others = [run for run in record.runs if run["agent"] != self.agent_id]
        if others:
            raise ValueError(f"Another agent's run is going in this VM (`{others[0]['label'][:100]}`); shutting it down would end it. Leave the VM on.")
        working = [line["holder"] for line in record.desktops.values() if line["holder"] not in [None, self.agent_id]]
        if working:
            raise ValueError("Someone else works on another desktop of this VM; shutting it down would end their work. Leave the VM on.")
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
        # Another agent's run, or its work on another desktop, would end with it; a VM that no longer answers has lost
        # them anyway.
        others = [run for run in record.runs if run["agent"] != self.agent_id]
        working = [line["holder"] for line in record.desktops.values() if line["holder"] not in [None, self.agent_id]]
        if (others or working) and await asyncio.to_thread(record.vm.responds):
            what = "Someone else works on another desktop of this VM"
            if others:
                what = f"Another agent's run is going in this VM (`{others[0]['label'][:100]}`)"
            raise ValueError(f"{what}; a restart would end it. Restart only if the VM stops answering (vm_health).")
        await asyncio.to_thread(record.restart)
        return {"content": [{"type": "text", "text": "The VM restarted and its desktop is up. Everything that was running in it has ended."}]}

    async def desktop_log_out(self, args: dict) -> dict:
        computer = Computer(self.held_desktop(), self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.log_out)
        return {"content": [{"type": "text", "text": "Logged out. The desktop shows the login screen until desktop_log_in."}]}

    async def desktop_log_in(self, args: dict) -> dict:
        computer = Computer(self.held_desktop(), self.tag)
        await asyncio.to_thread(computer.check)
        await asyncio.to_thread(computer.log_in)
        return {"content": [{"type": "text", "text": "Logged in; the desktop is up."}]}

    async def lock_desktop(self, args: dict) -> dict:
        record = self.held_vm()
        desktop = record.holding(self.agent_id)
        if self.locked_this_turn:
            raise ValueError("The desktop was already locked once this turn; it can't be locked again until your next turn")
        if record.locked_by.get(desktop) is not None:
            return {"content": [{"type": "text", "text": "The desktop is already locked (by the user)."}]}
        self.locked_this_turn = True
        self.locked_record = record
        self.locked_desktop = desktop
        # A new dict, so a reader never sees one half changed.
        record.locked_by = {**record.locked_by, desktop: "agent"}
        # Not saved (runtime only), so tell the live feed directly.
        self.vms.changed()
        return {"content": [{"type": "text", "text": "Locked. It unlocks when your turn ends, or when the user unlocks it."}]}

    async def unlock_desktop(self, args: dict) -> dict:
        record = self.held_vm()
        desktop = record.holding(self.agent_id)
        if record.locked_by.get(desktop) == "user":
            return {"content": [{"type": "text", "text": "The user locked it themselves; leave it to them."}]}
        if record.locked_by.get(desktop) is None:
            return {"content": [{"type": "text", "text": "It isn't locked."}]}
        record.locked_by = {number: who for number, who in record.locked_by.items() if number != desktop}
        self.locked_record = None
        self.vms.changed()
        return {"content": [{"type": "text", "text": "Unlocked. You can't lock again this turn."}]}

    async def browser_open(self, args: dict) -> dict:
        return await self.browser("open", args)

    async def browser_read(self, args: dict) -> dict:
        return await self.browser("read", args)

    async def browser_click(self, args: dict) -> dict:
        return await self.browser("click", args)

    async def browser_type(self, args: dict) -> dict:
        return await self.browser("type", args)

    async def browser_select(self, args: dict) -> dict:
        return await self.browser("select", args)

    async def browser_fetch(self, args: dict) -> dict:
        return await self.browser("fetch", args)

    async def browser_screenshot(self, args: dict) -> dict:
        return await self.browser("screenshot", args)

    async def browser_close(self, args: dict) -> dict:
        return await self.browser("close", args)

    async def browser(self, action: str, args: dict) -> dict:
        """One call to the agents' browser of the held desktop, in this agent's own session (its id)."""
        record = self.held_vm()
        desktop = record.holding(self.agent_id)
        request = dict(args)
        request["action"] = action
        request["session"] = self.agent_id
        call = f"SANDBOX_BROWSER_PORT={BROWSER_PORT + desktop - 1} {BROWSER_CALL}"
        result = await asyncio.to_thread(record.desktop_vm(desktop).exec, call, 180, json.dumps(request), self.tag)
        if record.holding(self.agent_id) != desktop:
            raise ValueError("You lost the VM meanwhile. " + NOT_HOLDER)
        if result.returncode != 0 or not result.stdout.strip():
            raise ValueError(f"The browser gave no answer: {result.stderr.strip()[-500:]}")
        # The answer is one line, the last: a login shell may print something before it.
        answer = json.loads(result.stdout.strip().split("\n")[-1])

        # Not answering: still installing (the first time in a VM), starting, or failed (its log says why).
        if answer.get("not_running"):
            unit = "sandbox-browser" if desktop == 1 else f"sandbox-browser-{desktop}"
            state = await asyncio.to_thread(record.vm.exec_root, f"systemctl is-active {unit}; journalctl -u {unit} -n 8 --no-pager -o cat", 30)
            lines = state.stdout.strip().split("\n")
            if lines[0] == "activating":
                raise ValueError("The browser is still starting. The first time in a VM it installs itself first, which takes a few minutes: wait 30 and try again.")
            if lines[0] == "active":
                raise ValueError("The browser is starting Firefox: wait 3 and try again.")
            log = "\n".join(lines[1:])
            raise ValueError(f"The browser isn't running ({lines[0]}); it tries again by itself every 30 seconds. Its last log lines:\n{log}")
        if "error" in answer:
            raise ValueError(answer["error"])

        # Pages can show the user's secrets too (a settings page, an echo of a form): hidden as in bash.
        text = answer["text"]
        for value in sorted(list(record.global_env.values()) + list(record.env.values()), key=len, reverse=True):
            if len(value) >= HIDE_MIN_LENGTH:
                text = text.replace(value, "[hidden]")
        content = [{"type": "text", "text": text}]
        if answer.get("image"):
            content.append({"type": "image", "data": answer["image"], "mimeType": "image/jpeg"})
        return {"content": content}

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
        record = self.locked_record
        if record is not None and record.locked_by.get(self.locked_desktop) == "agent":
            record.locked_by = {number: who for number, who in record.locked_by.items() if number != self.locked_desktop}
            self.vms.changed()
        self.locked_record = None
        self.locked_this_turn = False
