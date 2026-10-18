"""The desktop of one VM: look at it, click, type, scroll. Knows nothing about agents.

Everything runs inside the VM through VM.exec, as the desktop user:
scrot takes the screenshots and xdotool moves the mouse and presses keys.
Both need the X11 display of the logged-in desktop (the image uses X11, not Wayland).

Coordinates are pixels of the VM's screen, the same size as the screenshot.

    computer = Computer(session.vm)
    jpeg = computer.screenshot()
    computer.click(400, 300)
    computer.type("hello")
    computer.key("Return")
"""

import base64
import shlex
import subprocess

from sandbox.vm import VM

# Use the display of the desktop the human sees: copy DISPLAY and XAUTHORITY from
# x11vnc, which noVNC shows and which starts inside the desktop session.
X11 = (
    'pid=$(pgrep -o -u "$(id -u)" x11vnc); '
    '[ -n "$pid" ] || { echo "The desktop is not up yet (x11vnc is not running)." >&2; exit 1; }; '
    "export $(tr '\\0' '\\n' < /proc/$pid/environ | grep -E '^(DISPLAY|XAUTHORITY)='); "
)
# JPEG, not PNG: a PNG of the screen is over 1MB, too big for one message to Claude.
SCREENSHOT_PATH = "/tmp/computer-use-screen.jpg"
SCREENSHOT_QUALITY = 60


class ComputerError(Exception):
    pass


class Computer:
    def __init__(self, vm: VM):
        self.vm = vm

    def check(self) -> None:
        """Raise ComputerError if the VM can't be used now: missing, stopped, starting, ..."""
        status = self.vm.status()
        if status is None:
            raise ComputerError("The VM does not exist anymore.")
        if status != "Running":
            raise ComputerError(f"The VM is not running (it is {status.lower()}). Ask the user to start the session.")
        # Running can still mean booting or hung: then commands don't get through.
        try:
            result = self.vm.exec("true", timeout=10)
        except subprocess.TimeoutExpired:
            raise ComputerError("The VM is not responding. Wait a bit, or ask the user to restart the session.")
        if result.returncode != 0:
            raise ComputerError(f"The VM is not responding ({result.stderr.strip()}). It may still be starting up.")

    def screen_size(self) -> tuple[int, int]:
        result = self.vm.exec(f"{X11} xdotool getdisplaygeometry", timeout=30)
        if result.returncode != 0:
            raise ComputerError(f"Could not read the screen size: {result.stderr.strip()}")
        width, height = result.stdout.split()
        return int(width), int(height)

    def screenshot(self) -> bytes:
        """The whole screen as a JPEG."""
        result = self.vm.exec(f"{X11} scrot --overwrite --quality {SCREENSHOT_QUALITY} {SCREENSHOT_PATH} && base64 -w0 {SCREENSHOT_PATH}", timeout=30)
        if result.returncode != 0:
            raise ComputerError(f"Could not take a screenshot: {result.stderr.strip()}")
        return base64.b64decode(result.stdout)

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> None:
        """Click at (x, y). button: left, middle or right. count 2 is a double click."""
        buttons = {"left": 1, "middle": 2, "right": 3}
        if button not in buttons:
            raise ComputerError(f"Unknown button {button!r}, use left, middle or right")
        command = f"{X11} xdotool mousemove {int(x)} {int(y)} click --repeat {int(count)} {buttons[button]}"
        result = self.vm.exec(command, timeout=30)
        if result.returncode != 0:
            raise ComputerError(f"Could not click: {result.stderr.strip()}")

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> None:
        """Hold the left button at (x1, y1), move to (x2, y2), let go."""
        command = f"{X11} xdotool mousemove {int(x1)} {int(y1)} mousedown 1 mousemove {int(x2)} {int(y2)} mouseup 1"
        result = self.vm.exec(command, timeout=30)
        if result.returncode != 0:
            raise ComputerError(f"Could not drag: {result.stderr.strip()}")

    def type(self, text: str) -> None:
        """Type text as if on a keyboard, where the keyboard focus is."""
        result = self.vm.exec(f"{X11} xdotool type --delay 20 -- {shlex.quote(text)}", timeout=300)
        if result.returncode != 0:
            raise ComputerError(f"Could not type: {result.stderr.strip()}")

    def key(self, keys: str) -> None:
        """Press a key or combo in xdotool names, e.g. Return, Escape, ctrl+l, ctrl+shift+t."""
        result = self.vm.exec(f"{X11} xdotool key -- {shlex.quote(keys)}", timeout=30)
        if result.returncode != 0:
            raise ComputerError(f"Could not press {keys}: {result.stderr.strip()}")

    def scroll(self, x: int, y: int, direction: str, amount: int = 3) -> None:
        """Scroll at (x, y). direction: up, down, left or right. amount: wheel clicks."""
        buttons = {"up": 4, "down": 5, "left": 6, "right": 7}
        if direction not in buttons:
            raise ComputerError(f"Unknown direction {direction!r}, use up, down, left or right")
        command = f"{X11} xdotool mousemove {int(x)} {int(y)} click --repeat {int(amount)} {buttons[direction]}"
        result = self.vm.exec(command, timeout=30)
        if result.returncode != 0:
            raise ComputerError(f"Could not scroll: {result.stderr.strip()}")

    def bash(self, command: str, timeout: float = 600) -> str:
        """Run a shell command as the desktop user. Returns what it printed and its exit code."""
        result = self.vm.exec(command, timeout=timeout)
        return f"exit code {result.returncode}\n--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
