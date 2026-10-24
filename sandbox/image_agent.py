"""The agent of an image (the Agent tab of its Details): a Claude conversation that keeps the image's description
and builds the image from it.

The description (spec.md, see images.py) says what the image should have: system, desktop (GNOME, KDE Plasma, or
none: terminal only), its dependencies, comments. Two kinds of turns:
- Chat: the user asks for changes, and the agent edits the description. Nothing changes in the image until the
  user rebuilds it (the Images tab marks it with a dot meanwhile).
- Build (New image, Rebuild): the agent starts a builder VM from an official system image, installs everything
  as root, makes what the app needs work (CHECK_SCRIPT and check_vm() test it), and calls finish, which reboots
  the VM, checks again, cleans up, and publishes it as the image (Images.publish_build). Its steps go to the
  build task's log too, so the task row above the image list shows what it is doing.
Its tools come from one in-process MCP server, and Claude Code's own tools are off: it runs commands only inside
the builder VM, never on this machine.

One conversation per image, kept with the description (so a rename takes it along):

    chat.json   {"session_id", "history": [entry, ...], "cost_usd"}

with history entries like the main agents' (agent.py), fewer kinds:

    {"type": "user", "text", "time"}        {"type": "text", "text"}       {"type": "system", "text", "time"}
    {"type": "tool", "id", "name", "summary"}   {"type": "tool_result", "id", "text", "is_error"}
    {"type": "turn_end", "stopped", "cost_usd", "time"}

Each turn connects to Claude Code, resumes the conversation by its session id, and disconnects at the end:
turns are rare, and nothing stays connected for an image that is renamed or deleted. A turn runs on the
backend's event loop; the browser asks for the chat again while it runs.

    image_agents = ImageAgents(images)
    image_agents.send("ubuntu-1", "add Rust and use KDE")
    image_agents.build("ubuntu-1")
"""

import asyncio
import base64
import functools
import json
import os
import re
import subprocess
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, SystemMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage, create_sdk_mcp_server, tool
from dotenv import load_dotenv

from sandbox.agent.computer_use import Computer
from sandbox.images import SYSTEMS, Images, ImagesError, load_inventory
from sandbox.vm import NO_DESKTOP_FILE, VM, VMError

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
# run gives back the last this many characters of a command's output: where errors and summaries are.
OUTPUT_LIMIT = 20_000
# The builder VM, like the old build.sh's.
PROFILE = os.environ["SANDBOX_PROFILE"]
BUILD_CPUS = os.environ["SANDBOX_BUILD_CPUS"]
BUILD_MEMORY = os.environ["SANDBOX_BUILD_MEMORY"]
BUILD_DISK = os.environ["SANDBOX_BUILD_DISK"]
# Where things are inside every VM: the app and the main agents count on these.
VNC_PORT = os.environ["SANDBOX_VM_VNC_PORT"]
NOVNC_PORT = os.environ["SANDBOX_VM_NOVNC_PORT"]
TERMINAL_PORT = os.environ["SANDBOX_VM_TERMINAL_PORT"]
DEMO_DIR = os.environ["SANDBOX_VM_DEMO_DIR"]
PY_VENV = os.environ["SANDBOX_VM_PY_VENV"]
PLAYWRIGHT_DIR = os.environ["SANDBOX_VM_PLAYWRIGHT_DIR"]
RUST_DIR = os.environ["SANDBOX_VM_RUST_DIR"]
FALLBACK_USER = os.environ["SANDBOX_VM_FALLBACK_USER"]
# The script that made the first Ubuntu image: how each of the app's needs was done there, for the agent to adapt.
REFERENCE = PROJECT_ROOT / "sandbox" / "image" / "provision.sh"
SOURCES = [source for system in SYSTEMS for source in system["sources"]]

PROMPT = f"""You look after one VM image, {{name}}, in an app where AI agents work on GitHub issues inside VMs made from
images, and a human watches those VMs in the browser.

The image has a description (spec.md, markdown): its system, desktop, browser, dependencies, and comments.
There are two kinds of work.

1. Chat: the user asks for a change ("add Rust", "use KDE"). Change the description with read_spec and edit_spec
(or write_spec). Nothing changes in the image until the user rebuilds it, so say what you changed in the description
and never claim anything is installed. find_installed shows what the current build has. Ask when a request is unclear.

2. Build: a [System] message asks you to build the image from its description. start_vm gives you a fresh VM from an
official image ({", ".join(SOURCES)}); pick the one for the description's system (Ubuntu's /desktop variant only for
Ubuntu's own GNOME desktop). run runs bash as root in it; long installs need a long timeout_seconds. When everything
is in and check passes, call finish: it reboots the VM, checks again, cleans up and publishes the image. If something
can't be done, say why and end without finish.

Where the description leaves something open, pick a sensible default and say which: the distribution's own packages
first, official installers or repositories (nodejs.org, go.dev, rustup, uv, VS Code's repository, Docker's) where the
distribution's are missing or too old. Write in the description anything you decided that a rebuild should keep.

The desktop is GNOME, KDE Plasma, or None (terminal only):
- GNOME or KDE Plasma: the full desktop, with Firefox as its browser (the distribution's package, or Mozilla's own
  repository where the distribution only has a snap). The agents drive the desktop through X11 (xdotool, scrot), so it
  must log in to an X11 (Xorg) session, never Wayland. If that desktop has no X11 session on this system (newer GNOME
  and Plasma releases dropped it), use the other one if it has, change the description to match, and say so. If neither
  has, say so, suggest a system that does, and end without finish.
- None (terminal only): no desktop, display manager, X server, noVNC, x11vnc or browser at all, and the empty file
  {NO_DESKTOP_FILE}, so the app shows the VM's terminal instead of a desktop. Everything else below still applies
  (headless tools like Playwright's Chromium are fine when they are dependencies).

What the app needs in every image (check tests it):
- A desktop user with uid 1000 and passwordless sudo: the image's own if it has one, otherwise make "{FALLBACK_USER}".
  The app runs commands as this user in a login shell after `. /etc/environment`, so /etc/environment must exist,
  with a PATH that has every tool's folder (and PLAYWRIGHT_BROWSERS_PATH={PLAYWRIGHT_DIR}/browsers, RUSTUP_HOME={RUST_DIR}
  when those are in).
- With a desktop: an X11 session that logs the desktop user in by itself at boot and never locks or blanks the screen.
  No welcome wizard, update notifier, or crash report popups.
- With a desktop: x11vnc started inside that session (an /etc/xdg/autostart entry), on localhost only:
  x11vnc -forever -shared -nopw -localhost -rfbport {VNC_PORT} -noxdamage
- With a desktop: noVNC on port {NOVNC_PORT}, a systemd service running websockify --web <noVNC's web folder> {NOVNC_PORT}
  localhost:{VNC_PORT} (noVNC from the distribution, or from its GitHub release when the distribution has none).
- Nothing that runs the package manager in the background (automatic updates).
- Terminals in the browser: ttyd on port {TERMINAL_PORT} as a systemd service (--writable --url-arg), running
  /usr/local/bin/sandbox-terminal, which takes a terminal number (?arg=<n>) and attaches tmux session <n> as the desktop
  user in a login shell; /etc/tmux.conf with mouse on. Copy the script and settings from reference.
- tmux, python3, iptables, curl and git; with a desktop also xdotool and scrot.
- The demo service: {DEMO_DIR}/run.sh (a placeholder, owned by the desktop user) and demo.service running it as the desktop
  user, not enabled (the main agents enable it).
- Python, when it's in: a shared venv at {PY_VENV} that everyone may write to, first on PATH. Playwright, when it's in:
  in {PLAYWRIGHT_DIR}, its browsers in {PLAYWRIGHT_DIR}/browsers. Rust, when it's in: the toolchain in {RUST_DIR}.
- Docker, when it's in: the desktop user in the docker group.
- fwupd masked and the kernel argument clearcpuid=user_shstk (shadow stacks crash VMs on this host). start_vm does both.
reference shows the script that made the first Ubuntu image: each of these done with apt and GNOME. Adapt it; don't copy
its GNOME-only or apt-only parts to other systems. finish does the cleanup (package caches, /tmp, machine-id).

When a build is done, say in a few plain sentences what the image has and which defaults you picked.
"""

BUILD_MESSAGE = """[System] Build {name} now, from its description below (spec.md). Start a VM with start_vm, set up \
everything in the description and everything the app needs, check, then finish. The user follows your steps in the image list.

{spec}"""

CHECK_SCRIPT = f"""
desktop_tools="xdotool scrot x11vnc websockify"
if [ -f {NO_DESKTOP_FILE} ]; then
    echo "OK terminal only ({NO_DESKTOP_FILE}): no desktop checks"
    desktop_tools=""
fi
user=$(id -nu 1000 2>/dev/null)
if [ -n "$user" ]; then echo "OK desktop user $user (uid 1000)"; else echo "FAIL no user with uid 1000"; fi
if [ -n "$user" ] && runuser -u "$user" -- sudo -n true 2>/dev/null; then echo "OK passwordless sudo"; else echo "FAIL the desktop user has no passwordless sudo"; fi
if [ -f /etc/environment ]; then echo "OK /etc/environment"; else echo "FAIL no /etc/environment"; fi
for tool in $desktop_tools ttyd tmux python3 iptables curl git ss; do
    if command -v "$tool" > /dev/null; then echo "OK $tool"; else echo "FAIL $tool is missing"; fi
done
if [ -x /usr/local/bin/sandbox-terminal ]; then echo "OK /usr/local/bin/sandbox-terminal"; else echo "FAIL no /usr/local/bin/sandbox-terminal"; fi
if [ -x {DEMO_DIR}/run.sh ] && systemctl cat demo.service > /dev/null 2>&1; then echo "OK demo service"; else echo "FAIL no {DEMO_DIR}/run.sh or no demo.service"; fi
if [ -n "$desktop_tools" ]; then
    if ss -ltn | grep -q ':{VNC_PORT} '; then echo "OK VNC server on port {VNC_PORT}"; else echo "FAIL nothing listens on port {VNC_PORT} (x11vnc in the desktop session)"; fi
fi
if [ "$(systemctl is-enabled fwupd.service 2>/dev/null)" = masked ] || ! systemctl cat fwupd.service > /dev/null 2>&1; then echo "OK fwupd off"; else echo "FAIL fwupd is not masked"; fi
if grep -q clearcpuid=user_shstk /proc/cmdline; then
    echo "OK clearcpuid=user_shstk"
elif grep -rqs clearcpuid=user_shstk /etc/default/grub /etc/default/grub.d /boot/loader/entries /etc/kernel/cmdline; then
    echo "OK clearcpuid=user_shstk is set for the next boot"
else
    echo "FAIL the kernel argument clearcpuid=user_shstk is not set"
fi
"""

# Run as root right before publishing: nothing of the build that a VM made from the image doesn't need.
# Each VM gets its own machine-id on first boot, so copies don't look like the same machine on the network (DHCP).
CLEANUP_SCRIPT = """
if command -v apt-get > /dev/null; then apt-get clean; fi
if command -v dnf > /dev/null; then dnf clean all > /dev/null; fi
rm -rf /tmp/* /var/tmp/*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
fstrim -av > /dev/null 2>&1 || true
"""


class ImageAgents:
    def __init__(self, images: Images):
        self.images = images
        # The turns running now, by image name:
        # {"client", "chat", "stopped", "task", "build" (the build task, or None in a chat turn), "vm_up", "published"}.
        self.running: dict[str, dict] = {}

    def load(self, name: str) -> dict:
        path = self.images.spec_dir(name) / "chat.json"
        if not path.exists():
            return {"session_id": None, "history": [], "cost_usd": 0.0}
        return json.loads(path.read_text())

    def save(self, name: str, chat: dict) -> None:
        folder = self.images.spec_dir(name)
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
        self.running[name] = {"client": None, "chat": chat, "stopped": False, "task": None, "build": None, "vm_up": False, "published": False}
        # Kept, so the task isn't garbage collected while it runs.
        self.running[name]["task"] = asyncio.get_running_loop().create_task(self.run(name, text.strip()))

    def build(self, name: str) -> None:
        """Start a build turn: the agent makes the image from its description (New image, Rebuild). Answers at once."""
        if name in self.running:
            raise ImagesError(f"{name}'s agent is still working. Wait, or stop it.")
        spec = self.images.read_spec(name)
        build = self.images.start_agent_build(name)
        self.images.log_task(build["id"], "The agent is starting")
        chat = self.load(name)
        chat["history"].append({"type": "system", "text": "Build started, from the description", "time": datetime.now(UTC).isoformat()})
        self.save(name, chat)
        self.running[name] = {"client": None, "chat": chat, "stopped": False, "task": None, "build": build, "vm_up": False, "published": False}
        message = BUILD_MESSAGE.format(name=name, spec=spec)
        self.running[name]["task"] = asyncio.get_running_loop().create_task(self.run(name, message))

    async def interrupt(self, name: str) -> None:
        running = self.running.get(name)
        if running is None:
            return
        # Also seen by run() when the turn is still starting.
        running["stopped"] = True
        if running["client"] is None:
            return
        try:
            await running["client"].interrupt()
        except Exception:
            # Not connected yet, or the turn just ended.
            pass

    def clear(self, name: str) -> None:
        """Start a new conversation: the old one is forgotten. The description stays as it is."""
        name = self.images.find(name)["name"]
        if name in self.running:
            raise ImagesError(f"{name}'s agent is still working. Stop it first.")
        (self.images.spec_dir(name) / "chat.json").unlink(missing_ok=True)

    async def run(self, name: str, text: str) -> None:
        """One turn: send the message and add to the chat until the agent ends its turn."""
        AGENT_HOME.mkdir(parents=True, exist_ok=True)
        running = self.running[name]
        chat = running["chat"]
        history = chat["history"]
        build = running["build"]
        tools = [
            tool("read_spec", "Read the image's description (spec.md) as it is now.", {})(functools.partial(self.read_spec, name)),
            tool(
                "edit_spec",
                "Replace old_text with new_text in the description. old_text must be in it exactly once (copy it from read_spec).",
                {"old_text": str, "new_text": str},
            )(functools.partial(self.edit_spec, name)),
            tool("write_spec", "Replace the whole description with text (markdown).", {"text": str})(functools.partial(self.write_spec, name)),
            tool(
                "changes",
                "What changed in the description since the image was built, as a diff. The image has none of it until it is rebuilt.",
                {},
            )(functools.partial(self.changes, name)),
            tool(
                "find_installed",
                "Look up what the current build has: languages, tools and packages (apt, rpm, pip, npm, cargo, snap, flatpak, "
                "VS Code, Docker images, Playwright) whose name contains text.",
                {"text": str},
            )(functools.partial(self.find_installed, name)),
        ]
        # The builder VM's tools, only while building.
        if build is not None:
            tools += [
                tool(
                    "start_vm",
                    f"Start the builder VM from an official image: one of {', '.join(SOURCES)}. Takes a minute or a few (it downloads "
                    "the first time). Again later: starts over from a clean system.",
                    {"source": str},
                )(functools.partial(self.start_vm, name)),
                tool(
                    "run",
                    "Run a bash command as root in the builder VM. Gives back the exit code and the end of the output. "
                    "timeout_seconds: up to 3600 (default 600); big installs need more.",
                    {"command": str, "timeout_seconds": int},
                )(functools.partial(self.run_command, name)),
                tool(
                    "write_vm_file",
                    "Write a file in the builder VM as root (owner root). mode like 0644 or 0755.",
                    {"path": str, "content": str, "mode": str},
                )(functools.partial(self.write_vm_file, name)),
                tool("screenshot", "See the builder VM's desktop (once x11vnc runs in the desktop session).", {})(functools.partial(self.screenshot, name)),
                tool("check", "Test what the app needs in the builder VM, as it is now. Each line says OK or FAIL.", {})(functools.partial(self.check, name)),
                tool("reference", "Read the script that made the first Ubuntu image (apt, GNOME): how each of the app's needs was done there.", {})(
                    functools.partial(self.reference, name)
                ),
                tool(
                    "finish",
                    "Reboot the builder VM, check that everything comes up by itself, clean up and publish it as the image. "
                    "Fails with what is missing; fix it and call finish again.",
                    {},
                )(functools.partial(self.finish, name)),
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
                # Screenshots make big messages; the default limit is 1MB.
                max_buffer_size=10 * 1024 * 1024,
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
                        if build is not None:
                            self.images.log_task(build["id"], f"Error: {error}")
                    history.append({"type": "turn_end", "stopped": stopped, "cost_usd": cost, "time": datetime.now(UTC).isoformat()})

                # Text and tool calls come in the agent's messages; tool results come back in user messages.
                blocks = []
                if isinstance(message, (AssistantMessage, UserMessage)) and isinstance(message.content, list):
                    blocks = message.content
                for block in blocks:
                    if isinstance(block, TextBlock) and isinstance(message, AssistantMessage) and block.text.strip():
                        history.append({"type": "text", "text": block.text})
                        if build is not None:
                            self.images.log_task(build["id"], block.text)
                    if isinstance(block, ToolUseBlock):
                        tool_name = block.name.removeprefix(f"mcp__{TOOL_SERVER}__")
                        summary = tool_name
                        if tool_name == "read_spec":
                            summary = "Read the description"
                        if tool_name in ["edit_spec", "write_spec"]:
                            summary = "Changed the description"
                        if tool_name == "changes":
                            summary = "Looked at the changes since the build"
                        if tool_name == "find_installed":
                            summary = f"Looked for {block.input.get('text', '')} in the build"
                        if tool_name == "start_vm":
                            summary = f"Started a VM from {block.input.get('source', '')}"
                        if tool_name == "run":
                            summary = "$ " + str(block.input.get("command", "")).strip().split("\n")[0][:200]
                        if tool_name == "write_vm_file":
                            summary = f"Wrote {block.input.get('path', '')}"
                        if tool_name == "screenshot":
                            summary = "Looked at the screen"
                        if tool_name == "check":
                            summary = "Checked what the app needs"
                        if tool_name == "reference":
                            summary = "Read the first image's script"
                        if tool_name == "finish":
                            summary = "Finishing: reboot, check, publish"
                        history.append({"type": "tool", "id": block.id, "name": tool_name, "summary": summary})
                        if build is not None:
                            self.images.log_task(build["id"], summary)
                    if isinstance(block, ToolResultBlock):
                        # A result is text, or a list of text and image parts (screenshots). Images are not kept.
                        parts = block.content if isinstance(block.content, list) else [{"type": "text", "text": block.content or ""}]
                        result = "\n".join(part.get("text", "") for part in parts if part.get("type") == "text")
                        history.append({"type": "tool_result", "id": block.tool_use_id, "text": result[:RESULT_CUT], "is_error": bool(block.is_error)})
                        if build is not None and block.is_error:
                            self.images.log_task(build["id"], f"Error: {result}")
                self.save(name, chat)
        except Exception as error:
            history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
            if build is not None:
                self.images.log_task(build["id"], f"Error: {error}")
        finally:
            del self.running[name]
            self.save(name, chat)
            try:
                await client.disconnect()
            except Exception:
                # A Claude Code that already died has nothing left to close.
                pass
            # A build that didn't publish failed; its builder VM goes (the task stays, with its log, until dismissed).
            if build is not None and not running["published"]:
                error = "The agent ended without publishing the image; its log says why."
                if running["stopped"]:
                    error = "Stopped by you."
                await asyncio.to_thread(self.images.end_agent_build, build["id"], error)

    # --- Tools ---------------------------------------------------------------------
    # An exception here reaches the agent as a failed tool call.

    async def read_spec(self, name: str, args: dict) -> dict:
        return {"content": [{"type": "text", "text": self.images.read_spec(name)}]}

    async def edit_spec(self, name: str, args: dict) -> dict:
        text = self.images.read_spec(name)
        count = text.count(args["old_text"]) if args["old_text"] else 0
        if count == 0:
            raise ValueError("old_text is not in the description. read_spec it again and copy the text exactly.")
        if count > 1:
            raise ValueError(f"old_text is in the description {count} times. Add words around it so it is there once.")
        self.images.write_spec(name, text.replace(args["old_text"], args["new_text"]))
        return {"content": [{"type": "text", "text": "Changed the description. A rebuild applies it."}]}

    async def write_spec(self, name: str, args: dict) -> dict:
        text = args["text"]
        if not text.endswith("\n"):
            text += "\n"
        self.images.write_spec(name, text)
        return {"content": [{"type": "text", "text": "Wrote the description. A rebuild applies it."}]}

    async def changes(self, name: str, args: dict) -> dict:
        diff = self.images.spec_diff(name)
        if not diff:
            return {"content": [{"type": "text", "text": "Nothing changed: the description is what the image was built from."}]}
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

    async def start_vm(self, name: str, args: dict) -> dict:
        running = self.running[name]
        vm = VM(running["build"]["builder"])
        if args["source"] not in SOURCES:
            raise ValueError(f"source must be one of: {', '.join(SOURCES)}")
        # Again: start over from a clean system.
        await asyncio.to_thread(vm.delete)
        command = [
            "incus", "launch", f"images:{args['source']}", vm.name, "--vm", "--profile", PROFILE,
            "--config", f"limits.cpu={BUILD_CPUS}", "--config", f"limits.memory={BUILD_MEMORY}", "--device", f"root,size={BUILD_DISK}",
        ]
        result = await asyncio.to_thread(subprocess.run, command, capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise ValueError(f"Could not start a VM from images:{args['source']}: {result.stderr.strip()}")
        running["vm_up"] = True
        responds = False
        for _ in range(150):
            responds = await asyncio.to_thread(vm.responds)
            if responds:
                break
            await asyncio.sleep(2)
        if not responds:
            raise ValueError("The VM started, but it didn't answer commands within 5 minutes. start_vm again to start over.")
        note = ""
        try:
            await asyncio.to_thread(vm.guard_shadow_stack)
        except VMError as error:
            note = f"\nCould not set the shadow stack guard ({error}): mask fwupd and add the kernel argument clearcpuid=user_shstk yourself."
        release = await asyncio.to_thread(vm.exec_root, '. /etc/os-release && echo "$PRETTY_NAME"', 30)
        text = f"The VM is up: {release.stdout.strip()}. fwupd is masked and clearcpuid=user_shstk is set for the next boot." + note
        return {"content": [{"type": "text", "text": text}]}

    async def run_command(self, name: str, args: dict) -> dict:
        running = self.running[name]
        if not running["vm_up"]:
            raise ValueError("There is no builder VM yet: start_vm first.")
        vm = VM(running["build"]["builder"])
        timeout = max(10, min(int(args.get("timeout_seconds") or 600), 3600))
        try:
            result = await asyncio.to_thread(vm.exec_root, args["command"], timeout)
        except subprocess.TimeoutExpired:
            raise ValueError(f"No answer after {timeout} s; the command may still run in the VM. Check with run, and give long ones more time.")
        output = result.stdout
        if result.stderr.strip():
            output += "\n[stderr]\n" + result.stderr
        if len(output) > OUTPUT_LIMIT:
            output = "[...cut]\n" + output[-OUTPUT_LIMIT:]
        return {"content": [{"type": "text", "text": f"exit code {result.returncode}\n{output}"}]}

    async def write_vm_file(self, name: str, args: dict) -> dict:
        running = self.running[name]
        if not running["vm_up"]:
            raise ValueError("There is no builder VM yet: start_vm first.")
        mode = args.get("mode") or "0644"
        if not re.fullmatch(r"0?[0-7]{3}", mode):
            raise ValueError("mode is like 0644 or 0755")
        if not args["path"].startswith("/"):
            raise ValueError("path must start with /")
        await asyncio.to_thread(VM(running["build"]["builder"]).write_file, args["path"], args["content"], mode)
        return {"content": [{"type": "text", "text": f"Wrote {args['path']}."}]}

    async def screenshot(self, name: str, args: dict) -> dict:
        running = self.running[name]
        if not running["vm_up"]:
            raise ValueError("There is no builder VM yet: start_vm first.")
        computer = Computer(VM(running["build"]["builder"]))
        width, height = await asyncio.to_thread(computer.screen_size)
        jpeg = await asyncio.to_thread(computer.screenshot)
        return {
            "content": [
                {"type": "text", "text": f"Screen is {width}x{height} pixels."},
                {"type": "image", "data": base64.b64encode(jpeg).decode(), "mimeType": "image/jpeg"},
            ]
        }

    async def check(self, name: str, args: dict) -> dict:
        running = self.running[name]
        if not running["vm_up"]:
            raise ValueError("There is no builder VM yet: start_vm first.")
        works, report = await asyncio.to_thread(self.check_vm, VM(running["build"]["builder"]))
        heading = "Everything the app needs works." if works else "Not everything works yet:"
        return {"content": [{"type": "text", "text": f"{heading}\n{report}"}]}

    async def reference(self, name: str, args: dict) -> dict:
        return {"content": [{"type": "text", "text": REFERENCE.read_text()}]}

    async def finish(self, name: str, args: dict) -> dict:
        running = self.running[name]
        if not running["vm_up"]:
            raise ValueError("There is no builder VM yet: start_vm first.")
        vm = VM(running["build"]["builder"])
        # A fresh boot, so everything must come up by itself, as in every VM made from the image.
        await asyncio.to_thread(vm.stop)
        await asyncio.to_thread(vm.start)
        try:
            await asyncio.to_thread(vm.wait_ready, 300)
        except VMError as error:
            raise ValueError(f"After a reboot: {error}. Fix it, then finish again.")
        works, report = await asyncio.to_thread(self.check_vm, vm)
        if not works:
            raise ValueError(f"After a reboot, not everything works:\n{report}\nFix it, then finish again.")
        kernel = await asyncio.to_thread(vm.exec_root, "grep -q clearcpuid=user_shstk /proc/cmdline", 30)
        if kernel.returncode != 0:
            raise ValueError("After a reboot the kernel still runs without clearcpuid=user_shstk. Set it the system's way, then finish again.")
        await asyncio.to_thread(vm.exec_root, CLEANUP_SCRIPT, 600)
        await asyncio.to_thread(self.images.publish_build, running["build"]["id"], name, vm.name)
        running["published"] = True
        text = f"Published {name}. Its contents are being listed now (about two minutes). Tell the user what it has and which defaults you picked."
        return {"content": [{"type": "text", "text": text}]}

    def check_vm(self, vm: VM) -> tuple[bool, str]:
        """Test what the app needs in a running VM: CHECK_SCRIPT inside it, then noVNC, the terminals and the desktop from here."""
        result = vm.exec_root(CHECK_SCRIPT, 60)
        lines = result.stdout.strip().splitlines()
        desktop = vm.has_desktop()
        address = vm.address()
        if address is None:
            lines.append("FAIL the VM has no network address")
        if address is not None and desktop:
            try:
                urllib.request.urlopen(f"http://{address}:{NOVNC_PORT}/vnc.html", timeout=5)
                lines.append(f"OK noVNC answers on port {NOVNC_PORT}")
            except OSError as error:
                lines.append(f"FAIL noVNC doesn't answer on port {NOVNC_PORT} ({error})")
        if address is not None:
            try:
                urllib.request.urlopen(f"http://{address}:{TERMINAL_PORT}/", timeout=5)
                lines.append(f"OK the terminals (ttyd) answer on port {TERMINAL_PORT}")
            except OSError as error:
                lines.append(f"FAIL ttyd doesn't answer on port {TERMINAL_PORT} ({error})")
        # The same way the main agents reach the screen: the desktop user, X11's display from x11vnc.
        if desktop:
            try:
                width, height = Computer(vm).screen_size()
                lines.append(f"OK the agents can reach the screen ({width}x{height}, X11)")
            except Exception as error:
                lines.append(f"FAIL the agents can't reach the screen: {error}")
        works = not any(line.startswith("FAIL") for line in lines)
        return works, "\n".join(lines)
