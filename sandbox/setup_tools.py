"""The setup agent's tools. Each one works inside the sandbox VM, nothing else.

The agent has no built-in Claude Code tools (no shell, files or web on this
machine), so these are all it can do. They're thin: the work is in sandbox/vm.py.
The tools are bound to one VM and to a SetupState, which tells the manager what
the agent started and reported.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass

from claude_agent_sdk import SdkMcpTool, ToolAnnotations, tool

from sandbox.incus import ClippedText, IncusError
from sandbox.vm import PROJECT_DIR, RESERVED_PORTS, AppStart, HttpCheck, SandboxVM, SandboxVMError, absolute

# How much of a command's output the agent sees. The UI streams more of it.
MAX_RESULT_CHARS = 16_000
# Terminal colors and cursor movement: noise for the agent and the log.
ANSI_ESCAPES = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
READ_LIMIT_LINES = 500
MAX_LINE_CHARS = 2_000


@dataclass
class SetupResult:
    success: bool
    summary: str


@dataclass
class SetupState:
    """What the agent did that the manager cares about."""

    app_port: int | None = None
    app_path: str = "/"
    result: SetupResult | None = None  # Set by finish_setup.
    # Called after start_app or finish_setup changed the state, so the UI updates right away.
    on_change: Callable[[], None] | None = None

    def changed(self) -> None:
        if self.on_change:
            self.on_change()


# Tool name -> streaming output callback: on_output(tool_name, text).
OutputCallback = Callable[[str, str], None]


def build_setup_tools(vm: SandboxVM, state: SetupState, on_output: OutputCallback | None = None) -> list[SdkMcpTool]:
    """Create the agent's tools for one run, bound to its VM and state."""

    @tool(
        "run_command",
        "Run a bash command in the sandbox as the user dev (login shell, passwordless sudo) and wait "
        "for it to finish. Returns the exit code and the output (stdout and stderr together; the middle "
        "of long output is cut). There is no input: commands that ask questions fail, so pass -y/--yes "
        "and similar flags. Never use it for servers, watchers or anything else that doesn't finish: it "
        "would hang until the timeout. Run the demo with start_app instead.",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The bash command."},
                "cwd": {"type": "string", "description": f"Folder to run it in. Default {PROJECT_DIR}."},
                "timeout_seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 3600,
                    "description": "Kill the command after this many seconds. Default 600.",
                },
            },
            "required": ["command"],
        },
        annotations=ToolAnnotations(maxResultSizeChars=MAX_RESULT_CHARS * 2),
    )
    async def run_command(args: dict) -> dict:
        timeout = args.get("timeout_seconds") or 600
        output = (lambda text: on_output("run_command", plain(text))) if on_output else None
        try:
            result = await vm.run(
                args["command"], cwd=absolute(args.get("cwd") or PROJECT_DIR), timeout=timeout, on_output=output
            )
        except IncusError as error:
            return _error(f"Couldn't run the command: {error}")

        if result.timed_out or result.exit_code == 124:
            header = f"Killed after {timeout} seconds (timeout)."
        elif result.exit_code == 137:
            header = "Exit code: 137 (killed: out of memory, or it ignored the timeout)"
        else:
            header = f"Exit code: {result.exit_code}"
        return _text(
            f"{header}\n{_clip(plain(result.output).strip(), MAX_RESULT_CHARS)}", is_error=result.exit_code != 0
        )

    @tool(
        "read_file",
        "Read a text file in the sandbox. Returns numbered lines. For long files, read more with offset. "
        f"Relative paths are relative to {PROJECT_DIR}.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "minimum": 1, "description": "First line to show (1-based). Default 1."},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": f"How many lines to show. Default {READ_LIMIT_LINES}.",
                },
            },
            "required": ["path"],
        },
        annotations=ToolAnnotations(readOnlyHint=True, maxResultSizeChars=MAX_RESULT_CHARS * 4),
    )
    async def read_file(args: dict) -> dict:
        try:
            content = await vm.read_text(args["path"])
        except (SandboxVMError, IncusError) as error:
            return _error(str(error))

        lines = content.splitlines()
        offset = args.get("offset") or 1
        limit = args.get("limit") or READ_LIMIT_LINES
        shown = lines[offset - 1 : offset - 1 + limit]
        if not shown:
            return _text(f"The file has {len(lines)} lines; nothing at line {offset}.")
        numbered = "\n".join(f"{number:>6}\t{_cut_line(line)}" for number, line in enumerate(shown, start=offset))
        last = offset + len(shown) - 1
        if offset > 1 or last < len(lines):
            numbered += f"\n(lines {offset}-{last} of {len(lines)})"
        return _text(numbered)

    @tool(
        "write_file",
        "Create or overwrite a file in the sandbox, as dev; missing folders are created. For files only "
        "root may write (e.g. in /etc), write to /tmp and move them with sudo in run_command. "
        f"Relative paths are relative to {PROJECT_DIR}.",
        {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    )
    async def write_file(args: dict) -> dict:
        try:
            await vm.write_text(args["path"], args["content"])
        except (SandboxVMError, IncusError) as error:
            return _error(str(error))
        return _text(f"Wrote {absolute(args['path'])}.")

    @tool(
        "edit_file",
        "Replace text in a file in the sandbox. old_text must match the file exactly (whitespace "
        "included) and appear once, unless replace_all is true. "
        f"Relative paths are relative to {PROJECT_DIR}.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_text": {"type": "string"},
                "new_text": {"type": "string"},
                "replace_all": {"type": "boolean", "description": "Replace every match. Default false."},
            },
            "required": ["path", "old_text", "new_text"],
        },
    )
    async def edit_file(args: dict) -> dict:
        old, new = args["old_text"], args["new_text"]
        if not old:
            return _error("old_text is empty. Use write_file to create a file.")
        try:
            content = await vm.read_text(args["path"])
            count = content.count(old)
            if count == 0 and "\r\n" in content:
                # read_file shows lines without their \r, so match Windows line endings too.
                old, new = old.replace("\n", "\r\n"), new.replace("\n", "\r\n")
                count = content.count(old)
            if count == 0:
                return _error("old_text isn't in the file. Read the file again and copy the text exactly.")
            if count > 1 and not args.get("replace_all"):
                return _error(f"old_text is in the file {count} times. Add more context, or set replace_all.")
            await vm.write_text(args["path"], content.replace(old, new))
        except (SandboxVMError, IncusError) as error:
            return _error(str(error))
        return _text(f"Replaced {count} match{'es' if count > 1 else ''} in {absolute(args['path'])}.")

    @tool(
        "start_app",
        "Start the demo for the user, or restart it with a new command. It runs as the `demo` systemd "
        "service (as dev, in a bash login shell), so it keeps running after you finish and comes back "
        "when the sandbox restarts. This is the only way to run something the user can open. Put "
        "everything the demo needs when it starts into the command, e.g. "
        "`docker compose up -d db && npm run dev -- --host 0.0.0.0 --port 3000`. The app must listen on "
        "0.0.0.0 at `port`. Waits until the port answers HTTP, then returns the result and the service's logs.",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Bash command that runs the app in the foreground."},
                "port": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 65535,
                    "description": "Port the app serves the user on.",
                },
                "path": {"type": "string", "description": "Page the user's preview opens first. Default /."},
                "cwd": {"type": "string", "description": f"Folder to run the command in. Default {PROJECT_DIR}."},
                "wait_seconds": {
                    "type": "integer",
                    "minimum": 10,
                    "maximum": 900,
                    "description": "How long to wait for the port to answer. Default 180.",
                },
            },
            "required": ["command", "port"],
        },
    )
    async def start_app(args: dict) -> dict:
        port = args["port"]
        if port in RESERVED_PORTS:
            return _error(f"Port {port} is taken by the sandbox's editor or terminal. Use another port.")
        path = _page_path(args.get("path"))
        try:
            started = await vm.start_app(
                args["command"],
                port,
                path=path,
                cwd=args.get("cwd") or PROJECT_DIR,
                wait=args.get("wait_seconds") or 180,
            )
        except (SandboxVMError, IncusError) as error:
            return _error(str(error))

        state.app_port, state.app_path = port, path
        state.changed()
        return _text(_describe_start(port, path, started), is_error=not started.answered)

    @tool(
        "check_app",
        "Look at a page of the running demo the way the user will see it: first an HTTP request through "
        "the user's preview address, then the page loaded in headless Chromium inside the sandbox. "
        "Returns the status, console errors, failed requests, requests to other local ports (which the "
        "user's browser can't reach), the visible text and a screenshot.",
        {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Page to open. Default: the app's start page."}},
        },
        annotations=ToolAnnotations(readOnlyHint=True),
    )
    async def check_app(args: dict) -> dict:
        if state.app_port is None:
            return _error("No app yet. Start it with start_app first.")
        port = state.app_port
        path = _page_path(args.get("path") or state.app_path)
        try:
            http = await vm.http_get(port, path)
            page = await vm.look_at_page(port, path) if http.status is not None else None
        except (SandboxVMError, IncusError) as error:
            return _error(str(error))

        content = [{"type": "text", "text": _describe_page(port, path, http, page)}]
        if page and page.get("screenshot"):
            content.append({"type": "image", "data": page["screenshot"], "mimeType": "image/jpeg"})
        return {"content": content}

    @tool(
        "finish_setup",
        "Report the result to the user, who sees `summary` at the top of the sandbox page. Use "
        "success=true only when check_app shows the demo working. Call it again later if the result "
        "changes (e.g. after a follow-up request fixed a failed setup).",
        {
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "summary": {
                    "type": "string",
                    "description": (
                        "Short Markdown for the user: what the app is, how it runs (command, port), demo "
                        "logins if any, every change you made to the repo's files, and what doesn't work."
                    ),
                },
            },
            "required": ["success", "summary"],
        },
    )
    async def finish_setup(args: dict) -> dict:
        if args["success"]:
            if state.app_port is None:
                return _error("There's no running app. Start it with start_app, or report success=false.")
            http = await vm.http_get(state.app_port, state.app_path)
            if http.status is None or http.status >= 500:
                problem = http.error or f"HTTP {http.status}"
                return _error(f"The app doesn't work right now ({problem}). Fix it, or report success=false.")

        state.result = SetupResult(success=args["success"], summary=args["summary"].strip())
        state.changed()
        return _text("Reported. End with one short sentence for the user; the summary is already shown.")

    return [run_command, read_file, write_file, edit_file, start_app, check_app, finish_setup]


TOOL_NAMES = ["run_command", "read_file", "write_file", "edit_file", "start_app", "check_app", "finish_setup"]


def describe_call(name: str, args: dict) -> str:
    """One line for the activity log: what a tool call does."""
    if name == "run_command":
        cwd = args.get("cwd")
        return f"{args.get('command', '')}" + (f"  (in {cwd})" if cwd and absolute(cwd) != PROJECT_DIR else "")
    if name in ("read_file", "write_file", "edit_file"):
        return absolute(args.get("path", ""))
    if name == "start_app":
        return f"{args.get('command', '')}  (port {args.get('port')})"
    if name == "check_app":
        return args.get("path") or "start page"
    if name == "finish_setup":
        return "success" if args.get("success") else "failure"
    return ""


# ----------------------------------------------------------------------
# Formatting
# ----------------------------------------------------------------------


def _describe_start(port: int, path: str, started: AppStart) -> str:
    seconds = round(started.seconds)
    if started.answered:
        lines = [f"Port {port} answered after {seconds} s: {_describe_http(started.http)}"]
    else:
        lines = [f"Nothing answered on port {port} within {seconds} s ({started.http.error})."]
    restarts = f", restarted {started.restarts} times after crashing" if started.restarts else ""
    lines.append(f"Service: {started.service_state}{restarts}.")
    if started.answered and path != "/":
        lines.append(f"The preview opens {path}.")
    lines.append(f"Service logs (journalctl -u demo):\n{_clip(plain(started.logs), 6_000) or '(empty)'}")
    if started.answered:
        lines.append("Next: look at it with check_app.")
    return "\n".join(lines)


def _describe_http(http: HttpCheck) -> str:
    text = f"HTTP {http.status}"
    if http.content_type:
        text += f" ({http.content_type.split(';')[0]})"
    if http.location:
        text += f", redirects to {http.location}"
    if http.status is not None and http.status >= 400 and http.body_start:
        text += f"\nResponse starts with: {http.body_start[:300]}"
    return text


def _describe_page(port: int, path: str, http: HttpCheck, page: dict | None) -> str:
    if http.status is None:
        return f"Nothing answers on port {port} ({http.error}). Is the demo service running? Check its logs."
    lines = [f"Through the user's preview address: {_describe_http(http)}"]
    if page is None:
        return "\n".join(lines)

    lines.append(f"In the browser: HTTP {page.get('status')}, title {page.get('title')!r}")
    other_ports = (
        f"Requests to other local ports (the user's browser can't reach these; serve them through port {port})"
    )
    for label, key in (
        ("Console errors", "errors"),
        ("Failed requests", "failed_requests"),
        (other_ports, "other_ports"),
    ):
        items = page.get(key) or []
        if items:
            lines.append(f"{label}:")
            lines += [f"- {item}" for item in items]
    text = (page.get("text") or "").strip()
    lines.append(f"Visible text:\n{text[:1500] if text else '(none: the page looks empty)'}")
    return "\n".join(lines)


def plain(text: str) -> str:
    """Text without terminal escape codes (colors), and lines redrawn with \\r (progress bars) as last drawn."""
    text = ANSI_ESCAPES.sub("", text)
    if "\r" not in text:
        return text
    return "\n".join(line.rstrip("\r").rsplit("\r", 1)[-1] for line in text.split("\n"))


def _page_path(path: str | None) -> str:
    path = (path or "/").strip()
    return path if path.startswith("/") else "/" + path


def _cut_line(line: str) -> str:
    return line if len(line) <= MAX_LINE_CHARS else line[:MAX_LINE_CHARS] + " [... line cut]"


def _clip(text: str, limit: int) -> str:
    clipped = ClippedText(limit)
    clipped.add(text)
    return clipped.text()


def _text(text: str, is_error: bool = False) -> dict:
    result: dict = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["is_error"] = True
    return result


def _error(message: str) -> dict:
    return _text(f"Error: {message}", is_error=True)
