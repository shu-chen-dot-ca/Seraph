"""The agent of an image (the Agent tab of its Details): a Claude conversation that writes the image's image.yaml.

An image is defined by one file, image.yaml (images.py), and the app builds it, mechanically, from official
sources only (image_build.py). A new image's image.yaml starts as a copy of the defaults (the Defaults tab) with the
system, desktop and description picked, saved by New image with no agent. Once the image is
built, the user can ask its agent for changes: it adds and takes out on top of what is there, reads the defaults but
never changes them, and never builds or publishes anything by hand. Nothing changes in the image until it is
rebuilt: by the user (Rebuild), or by the agent with build (the same build, as a "build" task) when the user asks
for it. last_build shows the agent why a Rebuild failed. The user can also edit image.yaml in Details > Definition.
To try things first (a package's name on a system), start_try_vm starts a throwaway VM and run runs commands in it;
it is deleted when the turn ends and nothing in it goes into the image.
Its tools come from one in-process MCP server, and Claude Code's own tools are off: it runs commands only inside
the throwaway VM, never on this machine.

One conversation per image, kept with its image.yaml (so a rename takes it along):

    chat.json   {"session_id", "history": [entry, ...], "cost_usd"}

with history entries like the main agents' (agent.py), fewer kinds:

    {"type": "user", "text", "time"}        {"type": "text", "text"}       {"type": "system", "text", "time"}
    {"type": "tool", "id", "name", "summary"}   {"type": "tool_result", "id", "text", "is_error"}
    {"type": "turn_end", "stopped", "cost_usd", "time"}

Each turn connects to Claude Code, resumes the conversation by its session id, and disconnects at the end:
turns are rare, and nothing stays connected for an image that is renamed or deleted. A turn runs on the
backend's event loop; the browser asks for the chat again while it runs.

    image_agents = ImageAgents(images)
    image_agents.send("ubuntu-1", "add pydantic")
"""

import asyncio
import functools
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, SystemMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage, create_sdk_mcp_server, tool
from dotenv import load_dotenv

from sandbox import image_build
from sandbox.images import Images, ImagesError, load_inventory
from sandbox.vm import VM

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

# Claude Code runs here. With no file tools this only decides where it keeps the conversations.
AGENT_HOME = PROJECT_ROOT / os.environ["DATA_DIR"] / "image_agent_home"
TOOL_SERVER = "image"
# How much of a tool's result the chat keeps. The agent gets it in full.
RESULT_CUT = 4000
# How many matches find_installed lists.
FIND_LIMIT = 80
# run and build give back the last this many characters of the output: where errors and summaries are.
OUTPUT_LIMIT = 20_000
# The throwaway VM of image <name>, for trying things. Not named like the app's VMs, so the VM list never picks it up.
TRY_PREFIX = "image-try-"
SETTINGS_TEXT = ", ".join(f"{key} (now {os.environ[key]})" for key in image_build.SCRIPT_SETTINGS)
SYSTEMS_TEXT = "; ".join(f"{system['id']} ({', '.join(system['sources'])})" for system in image_build.SYSTEMS)

PROMPT = f"""You look after one VM image, {{name}}, in an app where AI agents work on GitHub issues inside VMs made from
images, and a human watches those VMs in the browser.

The image is defined by one file, image.yaml, and nothing else: the app builds the image from it, mechanically,
from official sources only. read_definition, edit_definition and write_definition work on it. Every change is
checked, and a wrong one is refused with the reason. The user sees it (Details > Definition) and may change it too.

A new image's image.yaml starts as a copy of the defaults: the user's starting point for every image (the Defaults
tab), with the system, desktop and description picked. You work on top of what is there: add what the user asks for
and take out what they don't want; keep the rest as it is. The defaults themselves are the user's and you never change them
(read_defaults shows them, e.g. to put back something taken out). An image with an empty image.yaml (saved from a
VM) starts from them too.

image.yaml has these keys, and no others:
  system: the system and the desktops it offers: {SYSTEMS_TEXT}
  desktop: gnome, kde or none (terminal only)
  description: optional, what the image is for and needs, in plain words. The user's: keep it true to what they
    asked (when they ask for a change in chat, update it to match), and don't add your own notes to it.
  packages: the system's own packages (apt on Ubuntu and Debian, dnf on Fedora), by their names there. One list, or
    split into apt: and dnf: lists (as the defaults are, since names differ); a build takes only the system's.
  python: Python, uv and a shared venv at $SANDBOX_VM_PY_VENV, first on PATH, that everyone may write to
    packages: pip packages for that venv
  node: Node.js from nodejs.org
    version: its major version ({image_build.NODE_MAJOR} when left out)
    packages: global npm packages
  docker: Docker with Compose from Docker's own repository; the desktop user may use it without sudo
    images: Docker images pulled into the image
  steps: anything the lists can't say, in order. Each has name:, an optional description: (what it does and why,
    for a person reading it) and run: (bash, run as root after
    "set -euxo pipefail", with DEBIAN_FRONTEND=noninteractive and these settings in its environment: {SETTINGS_TEXT};
    also SANDBOX_FAMILY, apt or dnf, and SANDBOX_DESKTOP, gnome, kde or none).
Leave out what isn't wanted: without python:, there is no venv. Lists are names only, one per item (pip and npm
version specs are fine, without spaces). Never write # comments, in the YAML or in a step's run: nothing reads them.
What a person should know goes in a description.

Every image already has the app's base layer (read_base_layer shows it), so image.yaml never has any of it: the
desktop with an X11 session that logs in by itself, Firefox, x11vnc and noVNC, browser terminals (ttyd, tmux), the
desktop user (uid 1000) with passwordless sudo, the demo service, sudo, curl, git, python3, iptables and xz, and
/etc/environment with a PATH that already has $SANDBOX_VM_PY_VENV/bin, /usr/local/go/bin and
$SANDBOX_VM_RUST_DIR/cargo/bin, RUSTUP_HOME=$SANDBOX_VM_RUST_DIR and
PLAYWRIGHT_BROWSERS_PATH=$SANDBOX_VM_PLAYWRIGHT_DIR/browsers. So steps put Rust in $SANDBOX_VM_RUST_DIR (RUSTUP_HOME,
and CARGO_HOME=$SANDBOX_VM_RUST_DIR/cargo), Go in /usr/local/go, Playwright in $SANDBOX_VM_PLAYWRIGHT_DIR with its
browsers in $SANDBOX_VM_PLAYWRIGHT_DIR/browsers, all readable by everyone.

Sources: the system's own packages first; where they are missing or too old, the official installer or repository
(VS Code's, GitHub CLI's, rustup, go.dev, Playwright's own install). Never a third-party mirror or a random script.

A build goes: the base layer, then packages, the runtimes (python, node, docker) and the steps, then the lists
(Docker images, npm packages, Python packages), then a reboot, a check of what the app needs, and publishing.
It keeps a snapshot after the base layer and after the steps, so the next build only runs again from the first part
that changed: a changed list takes a few minutes, a changed package or step runs the steps and lists again, a changed
system or desktop runs everything. So builds stay quick: put what changes often in the lists, nothing big is built
from source or downloaded only to warm a cache, and each script ends within 30 minutes.

The user asks for a change ("add pydantic", "use KDE"). Change image.yaml and say what you changed. Make sure a
package exists on that system: to find out (its name there), start_try_vm and run; nothing you do there goes into
the image. Nothing changes in the image until it is rebuilt, and the user does that with Rebuild: only build when
they ask you to. When a build fails, its log says where: fix image.yaml and build again. When a Rebuild failed,
last_build shows why. find_installed shows what the current build has. Ask when a request is unclear.
When a build is done, say in a few plain sentences what the image has.
"""

class ImageAgents:
    def __init__(self, images: Images):
        self.images = images
        # The turns running now, by image name:
        # {"client", "chat", "stopped", "task", "build_task" (the id of a build it waits for, or None),
        #  "try_vm" (its throwaway VM is up)}.
        self.running: dict[str, dict] = {}

    def load(self, name: str) -> dict:
        path = self.images.image_dir(name) / "chat.json"
        if not path.exists():
            return {"session_id": None, "history": [], "cost_usd": 0.0}
        return json.loads(path.read_text())

    def save(self, name: str, chat: dict) -> None:
        folder = self.images.image_dir(name)
        # Write, then rename: a crash never leaves half a chat.
        (folder / "chat.json.tmp").write_text(json.dumps(chat))
        (folder / "chat.json.tmp").replace(folder / "chat.json")

    def busy(self, name: str) -> bool:
        return name in self.running

    def chat(self, name: str) -> dict:
        """For the Agent tab: the conversation, whether a turn runs, and what it cost so far."""
        name = self.images.find(name)["name"]
        if name in self.running:
            chat = self.running[name]["chat"]
        else:
            chat = self.load(name)
        return {"history": chat["history"], "busy": name in self.running, "cost_usd": chat["cost_usd"]}

    def send(self, name: str, text: str) -> None:
        """Start a chat turn with the user's message. Answers at once; call it on the event loop."""
        name = self.images.find(name)["name"]
        if name in self.running:
            raise ImagesError(f"{name}'s agent is still working. Wait, or stop it.")
        if not text.strip():
            raise ImagesError("The message is empty")
        chat = self.load(name)
        chat["history"].append({"type": "user", "text": text.strip(), "time": datetime.now(UTC).isoformat()})
        self.save(name, chat)
        self.running[name] = {"client": None, "chat": chat, "stopped": False, "task": None, "build_task": None, "try_vm": False}
        # Kept, so the task isn't garbage collected while it runs.
        self.running[name]["task"] = asyncio.get_running_loop().create_task(self.run(name, text.strip()))

    async def interrupt(self, name: str) -> None:
        running = self.running.get(name)
        if running is None:
            return
        # Also seen by run() when the turn is still starting, and by build while it waits.
        running["stopped"] = True
        if running["client"] is None:
            return
        try:
            await running["client"].interrupt()
        except Exception:
            # Not connected yet, or the turn just ended.
            pass

    def clear(self, name: str) -> None:
        """Start a new conversation: the old one is forgotten. image.yaml stays as it is."""
        name = self.images.find(name)["name"]
        if name in self.running:
            raise ImagesError(f"{name}'s agent is still working. Stop it first.")
        (self.images.image_dir(name) / "chat.json").unlink(missing_ok=True)

    async def run(self, name: str, text: str) -> None:
        """One turn: send the message and add to the chat until the agent ends its turn."""
        AGENT_HOME.mkdir(parents=True, exist_ok=True)
        running = self.running[name]
        chat = running["chat"]
        history = chat["history"]
        tools = [
            tool(
                "read_definition",
                "Read image.yaml as it is now.",
                {},
            )(functools.partial(self.read_definition, name)),
            tool("read_defaults", "Read the defaults: the user's starting point for every new image.yaml. You can't change them.", {})(
                functools.partial(self.read_defaults, name)
            ),
            tool(
                "edit_definition",
                "Replace old_text with new_text in image.yaml. old_text must be in it exactly once (copy it from read_definition). "
                "Refused, with the reason, when the result isn't a right image.yaml.",
                {"old_text": str, "new_text": str},
            )(functools.partial(self.edit_definition, name)),
            tool(
                "write_definition",
                "Replace the whole image.yaml with text. Refused, with the reason, when it isn't a right image.yaml.",
                {"text": str},
            )(functools.partial(self.write_definition, name)),
            tool(
                "changes",
                "What changed in image.yaml since the image was last built, as a diff. The image has none of it until it is rebuilt.",
                {},
            )(functools.partial(self.changes, name)),
            tool(
                "find_installed",
                "Look up what the current build has: languages, tools and packages (apt, rpm, pip, npm, cargo, snap, flatpak, "
                "VS Code, Docker images, Playwright) whose name contains text.",
                {"text": str},
            )(functools.partial(self.find_installed, name)),
            tool("last_build", "Why the image's last failed build failed: its error and the end of its log.", {})(
                functools.partial(self.last_build, name)
            ),
            tool("read_base_layer", "Read the base layer every image gets before image.yaml (the desktop, Firefox, what the app needs).", {})(
                functools.partial(self.read_base_layer, name)
            ),
            tool(
                "build",
                "Build the image from image.yaml as it is now and publish it, replacing the image of this name: the same build "
                "as Rebuild, from the first part that changed since the last build. Waits until it is done (minutes; a first "
                "build longer). Fails with the build's error and the end of its log.",
                {},
            )(functools.partial(self.build_image, name)),
            tool(
                "start_try_vm",
                "Start a throwaway VM, fresh, from a system's official image (no desktop, no base layer), to try things out with "
                f"run. system: one of {', '.join(system['id'] for system in image_build.SYSTEMS)}. Takes a minute or a few (it "
                "downloads the first time). Again later: starts over. It is deleted when your turn ends.",
                {"system": str},
            )(functools.partial(self.start_try_vm, name)),
            tool(
                "run",
                "Run a bash command as root in the throwaway VM. Nothing it does goes into the image. Gives back the exit code and "
                "the end of the output. timeout_seconds: up to 1800.",
                {"command": str, "timeout_seconds": int},
            )(functools.partial(self.run_command, name)),
        ]
        client = ClaudeSDKClient(
            ClaudeAgentOptions(
                model=os.environ["CLAUDE_MODEL"],
                system_prompt=PROMPT.format(name=name),
                # No built-in tools: nothing on this machine is in reach.
                tools=[],
                allowed_tools=[f"mcp__{TOOL_SERVER}__{item.name}" for item in tools],
                mcp_servers={TOOL_SERVER: create_sdk_mcp_server(name=TOOL_SERVER, tools=tools)},
                permission_mode="dontAsk",
                setting_sources=[],
                strict_mcp_config=True,
                resume=chat["session_id"],
                cwd=str(AGENT_HOME),
                # The backend runs in this repo: its CLAUDE.md and Claude Code's memory are not for this agent.
                env={"CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"},
            )
        )
        running["client"] = client
        try:
            await client.connect()
            await client.query(text)
            if running["stopped"]:
                await client.interrupt()
            async for message in client.receive_response():
                # The conversation's id comes first, so a turn cut off by a restart can still be continued.
                if isinstance(message, SystemMessage) and message.subtype == "init" and message.data.get("session_id"):
                    chat["session_id"] = message.data["session_id"]

                if isinstance(message, ResultMessage):
                    chat["session_id"] = message.session_id
                    # Each turn has its own connection, so the connection's total is this turn's cost.
                    cost = message.total_cost_usd or 0.0
                    chat["cost_usd"] += cost
                    stopped = running["stopped"] or message.terminal_reason in ["aborted_streaming", "aborted_tools"]
                    if message.is_error and not stopped:
                        error = "; ".join(message.errors or []) or message.result or message.subtype
                        history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
                    history.append({"type": "turn_end", "stopped": stopped, "cost_usd": cost, "time": datetime.now(UTC).isoformat()})

                # Text and tool calls come in the agent's messages; tool results come back in user messages.
                blocks = []
                if isinstance(message, (AssistantMessage, UserMessage)) and isinstance(message.content, list):
                    blocks = message.content
                for block in blocks:
                    if isinstance(block, TextBlock) and isinstance(message, AssistantMessage) and block.text.strip():
                        history.append({"type": "text", "text": block.text})
                    if isinstance(block, ToolUseBlock):
                        tool_name = block.name.removeprefix(f"mcp__{TOOL_SERVER}__")
                        summary = tool_name
                        if tool_name == "read_definition":
                            summary = "Read image.yaml"
                        if tool_name == "read_defaults":
                            summary = "Read the defaults"
                        if tool_name in ["edit_definition", "write_definition"]:
                            summary = "Changed image.yaml"
                        if tool_name == "changes":
                            summary = "Looked at the changes since the build"
                        if tool_name == "find_installed":
                            summary = f"Looked for {block.input.get('text', '')} in the build"
                        if tool_name == "last_build":
                            summary = "Read the last failed build"
                        if tool_name == "read_base_layer":
                            summary = "Read the base layer"
                        if tool_name == "build":
                            summary = "Building the image"
                        if tool_name == "start_try_vm":
                            summary = f"Started a throwaway VM from {block.input.get('system', '')}"
                        if tool_name == "run":
                            summary = "$ " + str(block.input.get("command", "")).strip().split("\n")[0][:200]
                        history.append({"type": "tool", "id": block.id, "name": tool_name, "summary": summary})
                    if isinstance(block, ToolResultBlock):
                        parts = block.content if isinstance(block.content, list) else [{"type": "text", "text": block.content or ""}]
                        result = "\n".join(part.get("text", "") for part in parts if part.get("type") == "text")
                        history.append({"type": "tool_result", "id": block.tool_use_id, "text": result[:RESULT_CUT], "is_error": bool(block.is_error)})
                self.save(name, chat)
        except Exception as error:
            history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
        finally:
            del self.running[name]
            self.save(name, chat)
            try:
                await client.disconnect()
            except Exception:
                # A Claude Code that already died has nothing left to close.
                pass
            # A build the turn still waited for (it was cut off) doesn't go on without it.
            if running["build_task"] is not None:
                try:
                    await asyncio.to_thread(self.images.stop, running["build_task"])
                except ImagesError:
                    pass
            if running["try_vm"]:
                await asyncio.to_thread(VM(TRY_PREFIX + name).delete)

    # --- Tools ---------------------------------------------------------------------
    # An exception here reaches the agent as a failed tool call.

    async def read_definition(self, name: str, args: dict) -> dict:
        text = self.images.read_definition(name)
        return {"content": [{"type": "text", "text": text or "image.yaml is empty: not written yet. Start from read_defaults."}]}

    async def read_defaults(self, name: str, args: dict) -> dict:
        return {"content": [{"type": "text", "text": self.images.read_defaults()["defaults"]}]}

    async def edit_definition(self, name: str, args: dict) -> dict:
        text = self.images.read_definition(name)
        count = text.count(args["old_text"]) if args["old_text"] else 0
        if count == 0:
            raise ValueError("old_text is not in image.yaml. read_definition it again and copy the text exactly.")
        if count > 1:
            raise ValueError(f"old_text is in image.yaml {count} times. Add lines around it so it is there once.")
        try:
            self.images.write_definition(name, text.replace(args["old_text"], args["new_text"]))
        except ImagesError as error:
            raise ValueError(f"Not changed: {error}")
        return {"content": [{"type": "text", "text": "Changed image.yaml."}]}

    async def write_definition(self, name: str, args: dict) -> dict:
        text = args["text"]
        if not text.endswith("\n"):
            text += "\n"
        try:
            self.images.write_definition(name, text)
        except ImagesError as error:
            raise ValueError(f"Not written: {error}")
        return {"content": [{"type": "text", "text": "Wrote image.yaml."}]}

    async def changes(self, name: str, args: dict) -> dict:
        diff = self.images.definition(name)["diff"]
        if not diff:
            return {"content": [{"type": "text", "text": "Nothing changed: image.yaml is what the image was built from (or it was never built)."}]}
        return {"content": [{"type": "text", "text": diff}]}

    async def find_installed(self, name: str, args: dict) -> dict:
        image = self.images.find(name)
        inventory = await asyncio.to_thread(load_inventory, image["fingerprint"])
        if inventory is None:
            return {"content": [{"type": "text", "text": f"{name} wasn't inspected, so what it has isn't known."}]}
        needle = args["text"].strip().lower()
        lines = []
        for item in inventory["languages"]:
            if needle in item["name"].lower():
                lines.append(f"language {item['name']} {item['version']}")
        for item in inventory["tools"]:
            if needle in item["name"].lower():
                lines.append(f"tool {item['name']} {item['version']}")
        for package in inventory["packages"]:
            if needle in package["name"].lower():
                lines.append(f"{package['kind']} {package['name']} {package['version']}")
        if not lines:
            return {"content": [{"type": "text", "text": f"Nothing named like {args['text']} in the build."}]}
        text = "\n".join(lines[:FIND_LIMIT])
        if len(lines) > FIND_LIMIT:
            text += f"\n... and {len(lines) - FIND_LIMIT} more. Search for something narrower."
        return {"content": [{"type": "text", "text": text}]}

    async def last_build(self, name: str, args: dict) -> dict:
        failed = self.images.last_failed_build(name)
        if failed is None:
            return {"content": [{"type": "text", "text": "No failed build of this image is listed."}]}
        log = failed["log"]
        if len(log) > OUTPUT_LIMIT:
            log = "[...cut]\n" + log[-OUTPUT_LIMIT:]
        return {"content": [{"type": "text", "text": f"It failed: {failed['error']}\n\nIts log:\n{log}"}]}

    async def read_base_layer(self, name: str, args: dict) -> dict:
        return {"content": [{"type": "text", "text": image_build.BASE_LAYER.read_text()}]}

    async def build_image(self, name: str, args: dict) -> dict:
        running = self.running[name]
        try:
            task = await asyncio.to_thread(self.images.build, name)
        except ImagesError as error:
            raise ValueError(str(error))
        running["build_task"] = task["id"]
        status, error = "running", None
        while status == "running" and not running["stopped"]:
            await asyncio.sleep(3)
            status, error = self.images.task_state(task["id"])
        if status == "running":
            raise ValueError("Stopped by the user; the build stops too.")
        running["build_task"] = None
        if status == "done":
            text = f"Built and published {name}, and listed what it has. Tell the user what it has."
            return {"content": [{"type": "text", "text": text}]}
        log = self.images.read_log(task["id"])
        if len(log) > OUTPUT_LIMIT:
            log = "[...cut]\n" + log[-OUTPUT_LIMIT:]
        raise ValueError(f"The build failed: {error}\n\nIts log:\n{log}")

    async def start_try_vm(self, name: str, args: dict) -> dict:
        systems = [system for system in image_build.SYSTEMS if system["id"] == args["system"]]
        if not systems:
            raise ValueError(f"system must be one of {', '.join(system['id'] for system in image_build.SYSTEMS)}")
        running = self.running[name]
        running["try_vm"] = True
        release = await asyncio.to_thread(image_build.launch, VM(TRY_PREFIX + name), systems[0]["sources"]["none"])
        return {"content": [{"type": "text", "text": f"A fresh throwaway VM is up: {release}. It has none of the base layer."}]}

    async def run_command(self, name: str, args: dict) -> dict:
        running = self.running[name]
        if not running["try_vm"]:
            raise ValueError("There is no throwaway VM yet: start_try_vm first.")
        timeout = max(10, min(int(args.get("timeout_seconds") or 600), image_build.SCRIPT_TIMEOUT))
        try:
            result = await asyncio.to_thread(VM(TRY_PREFIX + name).exec_root, args["command"], timeout)
        except subprocess.TimeoutExpired:
            raise ValueError(f"No answer after {timeout} s; the command may still run in the VM. Check with run, and give long ones more time.")
        output = result.stdout
        if result.stderr.strip():
            output += "\n[stderr]\n" + result.stderr
        if len(output) > OUTPUT_LIMIT:
            output = "[...cut]\n" + output[-OUTPUT_LIMIT:]
        return {"content": [{"type": "text", "text": f"exit code {result.returncode}\n{output}"}]}
