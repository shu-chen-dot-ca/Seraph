"""The agent's tools: the Computer's actions, as tools Claude can call.

Only turns tool calls into Computer calls and Computer results into tool
results. What each action does inside the VM lives in computer_use.py.
A ComputerError raised here reaches Claude as a failed tool call.

Every tool that touches the VM checks it first, so if the VM stops in the
middle of a task the next tool call fails with the reason. The agent never has
to poll; the check tool is there for asking up front.

Each action adds an "activity" line to the agent's history, which the chat
shows while the agent works (like the GitHub searcher's chat).

Computer calls block (they run `incus exec`), so they run in a thread and the
backend keeps answering other requests meanwhile.

    tools = ComputerTools(Computer(session.vm), agent.history).list()
"""

import asyncio
import base64

from claude_agent_sdk import tool

from sandbox.agent.computer_use import Computer

# The only waits the agent can pick. Short ones are for things that are about
# instant; for something slow it waits 10s at a time and looks in between.
WAIT_SECONDS = [1, 3, 10, 30]


class ComputerTools:
    def __init__(self, computer: Computer, history: list):
        self.computer = computer
        # The agent's history (the same list): activity lines go here.
        self.history = history

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
            tool("bash", "Run a shell command in the VM as the desktop user, in their home folder.", {"command": str})(self.bash),
        ]

    async def check(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        width, height = await asyncio.to_thread(self.computer.screen_size)
        self.history.append({"role": "activity", "text": "Checked the VM: running"})
        return {"content": [{"type": "text", "text": f"The VM is running and its desktop is up ({width}x{height} pixels)."}]}

    async def screenshot(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        width, height = await asyncio.to_thread(self.computer.screen_size)
        jpeg = await asyncio.to_thread(self.computer.screenshot)
        self.history.append({"role": "activity", "text": "Took a screenshot"})
        return {
            "content": [
                {"type": "text", "text": f"Screen is {width}x{height} pixels."},
                {"type": "image", "data": base64.b64encode(jpeg).decode(), "mimeType": "image/jpeg"},
            ]
        }

    async def click(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.click, args["x"], args["y"], args["button"], args["count"])
        self.history.append({"role": "activity", "text": f"Clicked at ({args['x']}, {args['y']})"})
        return {"content": [{"type": "text", "text": "Clicked."}]}

    async def drag(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.drag, args["x1"], args["y1"], args["x2"], args["y2"])
        self.history.append({"role": "activity", "text": f"Dragged from ({args['x1']}, {args['y1']}) to ({args['x2']}, {args['y2']})"})
        return {"content": [{"type": "text", "text": "Dragged."}]}

    async def type(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.type, args["text"])
        text = args["text"].replace("\n", " ").replace("`", "'")[:80]
        self.history.append({"role": "activity", "text": f"Typed `{text}`"})
        return {"content": [{"type": "text", "text": "Typed."}]}

    async def key(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.key, args["keys"])
        self.history.append({"role": "activity", "text": f"Pressed `{args['keys']}`"})
        return {"content": [{"type": "text", "text": f"Pressed {args['keys']}."}]}

    async def scroll(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        await asyncio.to_thread(self.computer.scroll, args["x"], args["y"], args["direction"], args["amount"])
        self.history.append({"role": "activity", "text": f"Scrolled {args['direction']}"})
        return {"content": [{"type": "text", "text": "Scrolled."}]}

    async def wait(self, args: dict) -> dict:
        seconds = args["seconds"]
        if seconds not in WAIT_SECONDS:
            raise ValueError(f"seconds must be one of {WAIT_SECONDS}")
        await asyncio.sleep(seconds)
        self.history.append({"role": "activity", "text": f"Waited {seconds} seconds"})
        return {"content": [{"type": "text", "text": f"Waited {seconds} seconds."}]}

    async def bash(self, args: dict) -> dict:
        await asyncio.to_thread(self.computer.check)
        output = await asyncio.to_thread(self.computer.bash, args["command"])
        command = args["command"].replace("\n", " ").replace("`", "'")[:100]
        self.history.append({"role": "activity", "text": f"Ran `{command}` → {output.splitlines()[0]}"})
        return {"content": [{"type": "text", "text": output}]}
