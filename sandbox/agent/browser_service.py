"""The agents' browser: a Firefox inside the VM that agents use through tools, without the desktop.

Runs inside every VM (not on this machine), one for each of its desktops, as that desktop's user: the systemd
service sandbox-browser for desktop 1, sandbox-browser-<n> for desktop n, each on its own port and display
(SANDBOX_BROWSER_PORT, SANDBOX_BROWSER_DISPLAY). VM.set_up_browser (sandbox/vm.py) copies this file in and starts
them, and installs what they need the first time. The browser_* tools (sandbox/agent/tools.py) talk to the one of
the agent's desktop: each call runs `python3 browser_service.py call` in the VM with that port, which sends one JSON
request to the service on localhost and prints its JSON answer. Nothing outside the VM can reach it.

One Firefox (Playwright's build of it) serves every agent on that desktop. Each agent has its own session: a private
browser context with its own cookies, tabs and logins, which no other agent sees. Up to MAX_SESSIONS at once. A session lives until the agent closes it, IDLE_SECONDS unused, or the service
restarting (the VM restarting). Different agents' calls run at the same time; one agent's calls one after the
other.

Firefox runs on a display of its own (Xvfb, nobody sees it), not headless: so it draws pages (WebGL too) the same
way the desktop's Firefox does. It tells sites the same graphics card name as the desktop's Firefox
(VM.set_firefox_graphics_name), since bot checks (Tesla's, for one) block a browser that says it draws in
software. The time zone is the VM's own (VM.use_host_timezone), the language US English.

What a call can do (its "action"):
- open: go to a URL. read: the page again (from a character on, or only what contains a word). Both, and click,
  type and select, answer with the page as text plus a numbered list of what can be clicked or filled in.
- click, type, select: act on one of those numbers. A link that opens a new tab moves the session to it.
- fetch: a URL's raw answer (JSON, CSV, a file) through the browser, with the session's cookies, back as text or
  saved to a file in the VM. A GET opens it in a tab of its own (like typing the address), anything else is sent
  with fetch() from the open page.
- screenshot: the open page as a JPEG. close: end the session.
A download a click starts is saved in ~/Downloads, and the next answer says where.
"""

import asyncio
import base64
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

# Where it listens, and the display Firefox runs on (Xvfb), and its size. Each desktop's service has its own.
PORT = int(os.environ.get("SANDBOX_BROWSER_PORT", "9230"))
DISPLAY = os.environ.get("SANDBOX_BROWSER_DISPLAY", ":99")
SCREEN = "1920x1080x24"
MAX_SESSIONS = 10
# A session nobody used for this long is closed, so its pages stop using memory.
IDLE_SECONDS = 30 * 60
# Characters of page text, and numbered things, in one answer.
TEXT_LIMIT = 20000
ELEMENTS_LIMIT = 300
# How long the client waits for an answer: longer than any one action takes.
CALL_SECONDS = 170
# The same graphics card name as the desktop's Firefox (VM.set_firefox_graphics_name in sandbox/vm.py).
# JSON as plain text, so a page that is JSON reads as it is.
PREFS = {
    "webgl.vendor-string-override": "Intel",
    "webgl.renderer-string-override": "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
    "devtools.jsonview.enabled": False,
}

# Runs in the page: numbers everything that can be clicked or filled in (data-sandbox-ref, so a later click finds
# it), and gives back the page's text and one line per numbered thing.
READ_PAGE = """() => {
    for (const old of document.querySelectorAll('[data-sandbox-ref]')) {
        old.removeAttribute('data-sandbox-ref');
    }
    const selector = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], '
        + '[role=radio], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=switch], [contenteditable=true], [onclick]';
    const lines = [];
    for (const el of document.querySelectorAll(selector)) {
        if (el.type === 'hidden') {
            continue;
        }
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') {
            continue;
        }
        const ref = lines.length + 1;
        el.setAttribute('data-sandbox-ref', String(ref));
        const tag = el.tagName.toLowerCase();
        let kind = el.getAttribute('role') || tag;
        if (tag === 'a') {
            kind = 'link';
        }
        if (tag === 'input') {
            kind = (el.type || 'text') + ' field';
        }
        const image = el.querySelector('img[alt]');
        let label = el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title')
            || el.getAttribute('name') || el.getAttribute('alt') || (image ? image.alt : '') || '';
        label = label.trim().replace(/\\s+/g, ' ').slice(0, 100);
        let line = '[' + ref + '] ' + kind + ' "' + label + '"';
        if (tag === 'a') {
            line += ' -> ' + el.href.slice(0, 150);
        }
        if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.type !== 'checkbox' && el.type !== 'radio' && el.value) {
            line += ' value "' + el.value.slice(0, 80) + '"';
        }
        if (tag === 'select') {
            const chosen = el.selectedOptions.length > 0 ? el.selectedOptions[0].text.trim() : '';
            const options = [...el.options].slice(0, 20).map((option) => option.text.trim());
            line += ' = "' + chosen + '", options: ' + options.join(' | ');
        }
        if (el.checked || el.getAttribute('aria-checked') === 'true') {
            line += ' (checked)';
        }
        if (el.disabled) {
            line += ' (disabled)';
        }
        lines.push(line);
    }
    const body = document.body || document.documentElement;
    return { title: document.title, url: location.href, text: body ? body.innerText : '', elements: lines };
}"""

# Runs in the page: a request with fetch(), with the page's cookies.
FETCH = """async ([url, method, body]) => {
    const options = { method: method, credentials: 'include' };
    if (body !== null) {
        options.body = body;
        options.headers = { 'Content-Type': body.trim().startsWith('{') || body.trim().startsWith('[') ? 'application/json' : 'text/plain' };
    }
    const response = await fetch(url, options);
    return { status: response.status, type: response.headers.get('content-type') || '', text: await response.text() };
}"""


def short_error(error: Exception) -> str:
    """Playwright's errors end with a long call log; the first lines say what went wrong."""
    lines = str(error).strip().split("\n")
    return "\n".join(lines[:3])


class Service:
    def __init__(self, playwright):
        self.playwright = playwright
        self.browser = None
        # Each agent's session: {"context", "page" (the tab it is on), "lock", "used", "downloads" (not told yet)}.
        self.sessions: dict[str, dict] = {}
        # So two first calls of one agent at the same moment don't make two sessions.
        self.create_lock = asyncio.Lock()

    async def launch(self) -> None:
        self.browser = await self.playwright.firefox.launch(headless=False, firefox_user_prefs=PREFS)

    async def get_session(self, name: str) -> dict:
        async with self.create_lock:
            # Firefox crashed or was killed (out of memory): start it again; its sessions are gone.
            if not self.browser.is_connected():
                self.sessions = {}
                await self.launch()
            session = self.sessions.get(name)
            if session is None:
                if len(self.sessions) >= MAX_SESSIONS:
                    raise ValueError(f"The browser already has {MAX_SESSIONS} sessions open (one per agent); try again once one has closed.")
                context = await self.browser.new_context(
                    locale="en-US",
                    viewport={"width": 1920, "height": 960},
                    screen={"width": 1920, "height": 1080},
                    accept_downloads=True,
                )
                session = {"context": context, "page": None, "lock": asyncio.Lock(), "used": time.time(), "downloads": []}
                # Every new tab (the first one, or one a link opens) becomes the one the session is on.
                context.on("page", lambda page: self.on_page(session, page))
                self.sessions[name] = session
        session["used"] = time.time()
        return session

    def on_page(self, session: dict, page) -> None:
        session["page"] = page
        page.on("download", lambda download: self.save_download(session, download))

    async def save_download(self, session: dict, download) -> None:
        folder = Path.home() / "Downloads"
        folder.mkdir(exist_ok=True)
        path = folder / download.suggested_filename
        await download.save_as(path)
        session["downloads"].append(str(path))

    async def current_page(self, session: dict):
        page = session["page"]
        if page is None or page.is_closed():
            open_pages = [each for each in session["context"].pages if not each.is_closed()]
            if open_pages:
                session["page"] = open_pages[-1]
            else:
                # Sets session["page"] through on_page.
                await session["context"].new_page()
        return session["page"]

    async def settle(self, page) -> None:
        """Let the page finish: what a click started, its load, and the scripts that draw it (or check for bots)."""
        await asyncio.sleep(0.5)
        try:
            await page.wait_for_load_state("load", timeout=10000)
        except Exception:
            # Still loading after 10 seconds (ads, a stream): read what is there.
            pass
        await asyncio.sleep(1)

    async def read(self, session: dict, start: int = 0, find: str = "") -> str:
        page = await self.current_page(session)
        try:
            snapshot = await page.evaluate(READ_PAGE)
        except Exception:
            # The page was still going somewhere else (a redirect, a bot check reloading it): once more when it's there.
            await self.settle(page)
            snapshot = await page.evaluate(READ_PAGE)
        text = re.sub(r"\n\s*\n+", "\n\n", snapshot["text"]).strip()
        elements = snapshot["elements"]
        if find:
            wanted = find.lower()
            text = "\n".join(line for line in text.split("\n") if wanted in line.lower())
            elements = [line for line in elements if wanted in line.lower()]
        lines = [snapshot["title"], snapshot["url"]]
        tabs = len([each for each in session["context"].pages if not each.is_closed()])
        if tabs > 1:
            lines.append(f"{tabs} tabs open; this is the one you are on (the newest).")
        for path in session["downloads"]:
            lines.append(f"Downloaded: {path}")
        session["downloads"] = []
        lines.append("")
        part = text[start:start + TEXT_LIMIT]
        lines.append(part)
        if start + len(part) < len(text):
            lines.append(f"[Characters {start} to {start + len(part)} of {len(text)}: browser_read with start {start + len(part)} for more.]")
        lines.append("")
        lines.append(f"Things to click or fill in ({len(elements)}), by number:")
        lines.extend(elements[:ELEMENTS_LIMIT])
        if len(elements) > ELEMENTS_LIMIT:
            lines.append(f"[{len(elements) - ELEMENTS_LIMIT} more: browser_read with find lists the ones that contain a word.]")
        return "\n".join(lines)

    async def element(self, session: dict, request: dict):
        page = await self.current_page(session)
        locator = page.locator(f'[data-sandbox-ref="{int(request["ref"])}"]').first
        if await locator.count() == 0:
            raise ValueError(f"There is no [{request['ref']}] on the page anymore (it changed): browser_read for fresh numbers.")
        return page, locator

    async def fetch(self, session: dict, request: dict) -> str:
        url = request["url"]
        method = (request.get("method") or "GET").upper()
        body = request.get("body")
        if method == "GET" and body is None:
            # In a tab of its own, like typing the address: no limits on other sites, and the tab the agent is on stays.
            current = session["page"]
            page = await session["context"].new_page()
            try:
                response = await page.goto(url, timeout=60000)
                if response is None:
                    raise ValueError(f"No answer from {url}")
                data = await response.body()
                status = response.status
                kind = response.headers.get("content-type", "")
            finally:
                await page.close()
                session["page"] = current
        else:
            page = await self.current_page(session)
            answer = await page.evaluate(FETCH, [url, method, body])
            data = answer["text"].encode()
            status = answer["status"]
            kind = answer["type"]

        lines = [f"{method} {url}: status {status}, {kind or 'no type'}, {len(data)} bytes."]
        save_to = request.get("save_to") or ""
        if save_to:
            path = Path(save_to).expanduser()
            if not path.is_absolute():
                path = Path.home() / path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            lines.append(f"Saved all of it to {path}. The start:")
            lines.append(data[:2000].decode("utf-8", "replace"))
            return "\n".join(lines)
        text = data.decode("utf-8", "replace")
        lines.append(text[:TEXT_LIMIT])
        if len(text) > TEXT_LIMIT:
            lines.append(f"[Cut at {TEXT_LIMIT} of {len(text)} characters: fetch it again with save_to to keep all of it.]")
        return "\n".join(lines)

    async def call(self, request: dict) -> dict:
        action = request.get("action")
        name = request["session"]
        if action == "close":
            session = self.sessions.pop(name, None)
            if session is not None:
                await session["context"].close()
            return {"text": "Closed: its tabs and cookies are gone."}

        session = await self.get_session(name)
        async with session["lock"]:
            if action == "open":
                page = await self.current_page(session)
                await page.goto(request["url"], timeout=60000)
                await self.settle(page)
                return {"text": await self.read(session)}
            if action == "read":
                return {"text": await self.read(session, int(request.get("start") or 0), request.get("find") or "")}
            if action == "click":
                page, locator = await self.element(session, request)
                await locator.click(timeout=10000)
                await self.settle(page)
                return {"text": await self.read(session)}
            if action == "type":
                page, locator = await self.element(session, request)
                await locator.click(timeout=10000)
                try:
                    await locator.fill("", timeout=10000)
                except Exception:
                    # Not a field that can be emptied (a custom one): typing still goes in.
                    pass
                # Key by key, like a person: some pages only notice typing, not a filled-in value.
                await locator.press_sequentially(request["text"], delay=30)
                if request.get("enter"):
                    await locator.press("Enter")
                await self.settle(page)
                return {"text": await self.read(session)}
            if action == "select":
                page, locator = await self.element(session, request)
                try:
                    await locator.select_option(label=request["option"], timeout=10000)
                except Exception:
                    await locator.select_option(value=request["option"], timeout=10000)
                await self.settle(page)
                return {"text": await self.read(session)}
            if action == "fetch":
                return {"text": await self.fetch(session, request)}
            if action == "screenshot":
                page = await self.current_page(session)
                image = await page.screenshot(type="jpeg", quality=70)
                return {"text": f"{await page.title()}\n{page.url}", "image": base64.b64encode(image).decode()}
        raise ValueError(f"Unknown action {action}")

    async def handle(self, reader, writer) -> None:
        """One connection: one JSON request in (until the client stops sending), one JSON answer out."""
        try:
            request = json.loads(await reader.read())
            answer = await self.call(request)
        except Exception as error:
            answer = {"error": short_error(error)}
        writer.write(json.dumps(answer).encode())
        await writer.drain()
        writer.close()

    async def close_idle(self) -> None:
        while True:
            await asyncio.sleep(60)
            for name, session in list(self.sessions.items()):
                if time.time() - session["used"] < IDLE_SECONDS or session["lock"].locked():
                    continue
                del self.sessions[name]
                try:
                    await session["context"].close()
                except Exception:
                    # Firefox is already gone.
                    pass


async def serve() -> None:
    # Only the service has Playwright (its own venv); the client runs on the VM's plain python3.
    from playwright.async_api import async_playwright

    # A lock left by an Xvfb that didn't end cleanly would stop the new one.
    lock = Path(f"/tmp/.X{DISPLAY[1:]}-lock")
    if lock.exists():
        lock.unlink()
    subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", SCREEN, "-nolisten", "tcp"])
    os.environ["DISPLAY"] = DISPLAY
    await asyncio.sleep(1)

    async with async_playwright() as playwright:
        service = Service(playwright)
        await service.launch()
        # Kept in a variable: a task nothing refers to can be garbage-collected while it runs.
        idle = asyncio.create_task(service.close_idle())
        server = await asyncio.start_server(service.handle, "127.0.0.1", PORT)
        async with server:
            await server.serve_forever()


def call() -> None:
    """The client: the JSON request on stdin to the service, its answer to stdout."""
    request = sys.stdin.buffer.read()
    try:
        connection = socket.create_connection(("127.0.0.1", PORT), timeout=CALL_SECONDS)
    except OSError:
        print(json.dumps({"not_running": True}))
        return
    connection.sendall(request)
    connection.shutdown(socket.SHUT_WR)
    chunks = []
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
    sys.stdout.buffer.write(b"".join(chunks))


if __name__ == "__main__":
    if sys.argv[1:] == ["call"]:
        call()
    else:
        asyncio.run(serve())
