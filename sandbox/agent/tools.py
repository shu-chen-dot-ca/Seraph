"""The agent's tools: the Computer's actions, as tools Claude can call.

Only turns tool calls into Computer calls and Computer results into tool
results. What each action does inside the VM lives in computer_use.py.
A ComputerError raised here reaches Claude as a failed tool call.

Every tool that touches the VM checks it first, so if the VM stops in the
middle of a task the next tool call fails with the reason. The agent never has
to poll; the check tool is there for asking up front.

Each action shows as an "activity" line in the agent's history the moment it
starts (Agent.run adds describe()'s line), which the chat shows while the agent
works (like the GitHub searcher's chat). Commands also get a line when they end.

The session's environment variables are the user's secrets: the agent may see
their names and whether each has a value, never the values. It may add a new,
empty one (for the user to fill in) and remove ones that are still empty; it can
never set, change or remove a value. Commands it runs
do get them (they are in every login shell), and any value that shows up in a
command's output is replaced by [hidden] before the agent sees it.

The agent may lock the human's mouse and keyboard out of the desktop while it
works there: once per turn (one message from the user). The user can unlock it
any time, and then it stays unlocked for the rest of the turn. A lock the agent
set ends with its turn (Agent.run calls end_turn).

Computer calls block (they run `incus exec`), so they run in a thread and the
backend keeps answering other requests meanwhile.

    tools = ComputerTools(Computer(session.vm), session, agent.history).list()
"""

import asyncio
import base64

from claude_agent_sdk import tool

from sandbox.agent.computer_use import Computer
from sandbox.session import Session

# The only waits the agent can pick. Short ones are for things that are about
# instant; for something slow it waits 10s at a time and looks in between.
WAIT_SECONDS = [1, 3, 10, 30]
# Values shorter than this are not hidden in output: hiding "1" or "yes" would garble
# everything, and values that short are not secrets.
HIDE_MIN_LENGTH = 4


class ComputerTools:
    def __init__(self, computer: Computer, session: Session, history: list):
        self.computer = computer
        # For its environment variables, read fresh each time (the user can change them any time).
        self.session = session
        # The agent's history (the same list): activity lines go here.
        self.history = history
        # Whether lock_desktop was used in this turn (allowed once per turn).
        self.locked_this_turn = False

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
                "The user's environment variables are set in it; their values are replaced by [hidden] in the output.",
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
                "List the environment variables the user set for this VM: each name and whether it has a value. "
                "Never the values; use them in commands as $NAME.",
                {},
            )(self.env_vars),
            tool(
                "env_var_add",
                "Add a new, empty environment variable for a secret the task needs (e.g. OPENAI_API_KEY), "
                "then ask the user to fill in its value in the Environment tab. Only for secrets: "
                "anything else (settings, config) goes in files in the VM.",
                {"name": str},
            )(self.env_var_add),
            tool(
                "env_var_remove",
                "Remove an environment variable that is still empty. Ones with a value can't be removed.",
                {"name": str},
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
        if name == "env_var_add":
            return f"Adding the environment variable `{args.get('name')}` (empty, for you to fill in)"
        if name == "env_var_remove":
            return f"Removing the empty environment variable `{args.get('name')}`"
        if name == "vm_start":
            return "Starting the VM"
        if name == "vm_stop":
            return "Shutting the VM down"
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
        await asyncio.to_thread(self.computer.check)
        width, height = await asyncio.to_thread(self.computer.screen_size)
        return {"content": [{"type": "text", "text": f"The VM is running and its desktop is up ({width}x{height} pixels)."}]}

    async def screenshot(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        width, height = await asyncio.to_thread(self.computer.screen_size)
        jpeg = await asyncio.to_thread(self.computer.screenshot)
        return {
            "content": [
                {"type": "text", "text": f"Screen is {width}x{height} pixels."},
                {"type": "image", "data": base64.b64encode(jpeg).decode(), "mimeType": "image/jpeg"},
            ]
        }

    async def click(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.click, args["x"], args["y"], args["button"], args["count"])
        return {"content": [{"type": "text", "text": "Clicked."}]}

    async def drag(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.drag, args["x1"], args["y1"], args["x2"], args["y2"])
        return {"content": [{"type": "text", "text": "Dragged."}]}

    async def type(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.type, args["text"])
        return {"content": [{"type": "text", "text": "Typed."}]}

    async def key(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.key, args["keys"])
        return {"content": [{"type": "text", "text": f"Pressed {args['keys']}."}]}

    async def scroll(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.scroll, args["x"], args["y"], args["direction"], args["amount"])
        return {"content": [{"type": "text", "text": "Scrolled."}]}

    async def wait(self, args: dict) -> dict:
        seconds = args["seconds"]
        if seconds not in WAIT_SECONDS:
            raise ValueError(f"seconds must be one of {WAIT_SECONDS}")
        await asyncio.sleep(seconds)
        return {"content": [{"type": "text", "text": f"Waited {seconds} seconds."}]}

    async def bash(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        output = await asyncio.to_thread(self.computer.bash, args["command"])
        # Longest first, so a value that contains another one is hidden whole.
        values = sorted(self.session.env.values(), key=len, reverse=True)
        for value in values:
            if len(value) >= HIDE_MIN_LENGTH:
                output = output.replace(value, "[hidden]")
        # The command itself was shown when it started (describe); now how it ended.
        self.history.append({"role": "activity", "text": f"Done: {output.splitlines()[0]}"})
        return {"content": [{"type": "text", "text": output}]}

    async def env_vars(self, args: dict) -> dict:
        lines = []
        for name, value in self.session.env.items():
            lines.append(f"{name}: {'set' if value else 'empty'}")
        return {"content": [{"type": "text", "text": "\n".join(lines) or "No environment variables are set."}]}

    async def env_var_add(self, args: dict) -> dict:
        name = args["name"]
        if name in self.session.env:
            raise ValueError(f"{name} already exists")
        env = dict(self.session.env)
        env[name] = ""
        await asyncio.to_thread(self.session.set_env, env)
        return {"content": [{"type": "text", "text": f"Added {name}, empty. Ask the user to fill it in in the Environment tab."}]}

    async def env_var_remove(self, args: dict) -> dict:
        name = args["name"]
        if name not in self.session.env:
            raise ValueError(f"There is no {name}")
        if self.session.env[name] != "":
            raise ValueError(f"{name} has a value; only the user can remove it")
        env = dict(self.session.env)
        del env[name]
        await asyncio.to_thread(self.session.set_env, env)
        return {"content": [{"type": "text", "text": f"Removed {name}."}]}

    async def vm_start(self, args: dict) -> dict:
        if self.session.vm.status() == "Running":
            return {"content": [{"type": "text", "text": "The VM is already running."}]}
        await asyncio.to_thread(self.session.start)
        return {"content": [{"type": "text", "text": "The VM is running and its desktop is up."}]}

    async def vm_stop(self, args: dict) -> dict:
        if self.session.vm.status() != "Running":
            return {"content": [{"type": "text", "text": "The VM is already off."}]}
        await asyncio.to_thread(self.session.stop)
        return {"content": [{"type": "text", "text": "The VM is off."}]}

    async def desktop_log_out(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.log_out)
        return {"content": [{"type": "text", "text": "Logged out. The desktop shows the login screen until desktop_log_in."}]}

    async def desktop_log_in(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.log_in)
        return {"content": [{"type": "text", "text": "Logged in; the desktop is up."}]}

    async def lock_desktop(self, args: dict) -> dict:
        if self.locked_this_turn:
            raise ValueError("The desktop was already locked once this turn; it can't be locked again until the user's next message")
        if self.session.locked_by is not None:
            return {"content": [{"type": "text", "text": "The desktop is already locked (by the user)."}]}
        self.locked_this_turn = True
        self.session.locked_by = "agent"
        return {"content": [{"type": "text", "text": "Locked. It unlocks when your turn ends, or when the user unlocks it."}]}

    async def unlock_desktop(self, args: dict) -> dict:
        if self.session.locked_by == "user":
            return {"content": [{"type": "text", "text": "The user locked it themselves; leave it to them."}]}
        if self.session.locked_by is None:
            return {"content": [{"type": "text", "text": "It isn't locked."}]}
        self.session.locked_by = None
        return {"content": [{"type": "text", "text": "Unlocked. You can't lock again this turn."}]}

    def end_turn(self) -> None:
        """The agent's turn is over: undo its lock (not the user's), and allow locking again next turn."""
        if self.session.locked_by == "agent":
            self.session.locked_by = None
        self.locked_this_turn = False
