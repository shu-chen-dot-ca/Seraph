"""The preview proxy: how the user's browser reaches ports inside sandbox VMs.

Every port of every sandbox has its own address on this machine:

    http://<port>-<sandbox id>.localhost:<backend port>/

Browsers send *.localhost to 127.0.0.1, where the backend listens, and the
backend hands requests for these hosts to PreviewProxy (see backend/app.py),
which forwards them to the VM. HTTP (streamed both ways) and WebSockets work.
The Host header is passed on unchanged, so the app sees the address the
browser used. A separate host per port keeps apps at "/" and gives each one its
own origin, so it can't read the backend or other sandboxes.

So the sandbox page can show an app in an iframe (a cross-site one), the proxy
drops X-Frame-Options and CSP frame-ancestors from responses, and marks cookies
SameSite=None; Secure; Partitioned: browsers drop the default (Lax) cookies of
cross-site iframes, so logins would never stick. Browsers accept Secure cookies
on http://*.localhost.
"""

import asyncio
import html
import ipaddress
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from urllib.parse import urlsplit

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

logger = logging.getLogger(__name__)

HOST_PATTERN = re.compile(r"^(?P<port>\d{1,5})-(?P<sandbox>sb-[0-9a-f]{8})\.localhost(?::\d{1,5})?$")

# Not forwarded: they describe one connection, not the request or response.
HOP_BY_HOP = {
    b"connection",
    b"keep-alive",
    b"proxy-authenticate",
    b"proxy-authorization",
    b"proxy-connection",
    b"te",
    b"trailer",
    b"transfer-encoding",
    b"upgrade",
}
# Set by the websocket libraries on each side.
WEBSOCKET_HANDSHAKE = {
    b"host",
    b"origin",
    b"user-agent",
    b"sec-websocket-key",
    b"sec-websocket-version",
    b"sec-websocket-extensions",
    b"sec-websocket-protocol",
    b"sec-websocket-accept",
}

# sandbox id -> the VM's fixed address, or None if there's no such sandbox or it isn't running.
Resolver = Callable[[str], Awaitable[str | None]]
# Messages a VM sends over a WebSocket are held in memory: limit their size and number.
MAX_WEBSOCKET_MESSAGE = 16 * 1024 * 1024
MAX_WEBSOCKET_QUEUE = 4


def preview_host(sandbox_id: str, port: int, server_port: int) -> str:
    return f"{port}-{sandbox_id}.localhost:{server_port}"


def preview_url(sandbox_id: str, port: int, server_port: int, path: str = "/") -> str:
    return f"http://{preview_host(sandbox_id, port, server_port)}{path}"


def parse_preview_host(host: str) -> tuple[str, int] | None:
    """ "3000-sb-1a2b3c4d.localhost:8000" -> ("sb-1a2b3c4d", 3000). None for any other host."""
    match = HOST_PATTERN.match(host.lower())
    if not match or not 0 < int(match["port"]) < 65536:
        return None
    return match["sandbox"], int(match["port"])


class PreviewProxy:
    """An ASGI app forwarding preview hosts to sandbox VMs."""

    def __init__(self, resolve: Resolver):
        self._resolve = resolve
        # A page load can be hundreds of requests; keep httpx from logging each one.
        logging.getLogger("httpx").addFilter(_skip_requests_to_vms)
        self._client = httpx.AsyncClient(
            # Streams (server-sent events, long polling, dev servers) may stay open for good.
            timeout=httpx.Timeout(connect=10, read=None, write=60, pool=30),
            limits=httpx.Limits(max_connections=None, max_keepalive_connections=50),
            follow_redirects=False,
            trust_env=False,  # No HTTP proxy from the environment: VMs are local.
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __call__(self, scope, receive, send) -> None:
        host = _header(scope, b"host")
        target = parse_preview_host(host)
        if scope["type"] == "http":
            if target is None:
                await _plain_response(send, 404, "Not a sandbox preview address.")
                return
            await self._http(scope, receive, send, host, *target)
        elif scope["type"] == "websocket":
            if target is None:
                await send({"type": "websocket.close", "code": 1008})
                return
            await self._websocket(scope, receive, send, host, *target)

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    async def _http(self, scope, receive, send, host: str, sandbox_id: str, port: int) -> None:
        ip = await self._resolve(sandbox_id)
        if ip is None:
            await _unavailable(scope, send, f"Sandbox {sandbox_id} doesn't exist or isn't running.", retry=False)
            return

        headers = [(name, value) for name, value in scope["headers"] if name not in HOP_BY_HOP]
        headers += [(b"x-forwarded-proto", b"http"), (b"x-forwarded-for", (scope.get("client") or ("",))[0].encode())]
        has_body = any(name in (b"content-length", b"transfer-encoding") for name, _ in scope["headers"])
        body_done = asyncio.Event()  # The request body was read: from now on, receive() only reports a disconnect.

        async def body() -> AsyncIterator[bytes]:
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    raise _BrowserGone
                yield message.get("body", b"")
                if not message.get("more_body"):
                    break
            body_done.set()

        if not has_body:
            body_done.set()

        path = scope.get("raw_path") or scope["path"].encode()
        if scope["query_string"]:
            path += b"?" + scope["query_string"]
        request = self._client.build_request(
            scope["method"],
            httpx.URL(f"http://{ip}:{port}", raw_path=path),
            headers=headers,
            content=body() if has_body else None,
        )

        try:
            response = await self._client.send(request, stream=True)
        except httpx.ConnectError:
            await _unavailable(scope, send, f"Nothing answers on port {port} in sandbox {sandbox_id} yet.")
            return
        except httpx.HTTPError as error:
            await _unavailable(scope, send, f"The app in sandbox {sandbox_id} failed to answer: {error}")
            return
        except _BrowserGone:
            return

        try:
            await send(
                {
                    "type": "http.response.start",
                    "status": response.status_code,
                    "headers": _response_headers(response, host, ip, port),
                }
            )
            # Stream until the body ends or the browser goes away (e.g. it closed an event stream).
            streaming = asyncio.ensure_future(_stream_body(response, send))
            watching = asyncio.ensure_future(_wait_for_disconnect(receive, body_done))
            await asyncio.wait({streaming, watching}, return_when=asyncio.FIRST_COMPLETED)
            for task in (streaming, watching):
                task.cancel()
            if streaming.done() and not streaming.cancelled() and streaming.exception():
                logger.debug("Preview stream ended early: %s", streaming.exception())
        finally:
            await response.aclose()

    # ------------------------------------------------------------------
    # WebSockets
    # ------------------------------------------------------------------

    async def _websocket(self, scope, receive, send, host: str, sandbox_id: str, port: int) -> None:
        await receive()  # websocket.connect

        # Only pages from this same address may open a socket here: no other site
        # (or other sandbox) can drive the editor, the terminal or the app.
        origin = _header(scope, b"origin")
        if origin and urlsplit(origin).netloc.lower() != host.lower():
            await send({"type": "websocket.close", "code": 1008})
            return

        ip = await self._resolve(sandbox_id)
        if ip is None:
            await send({"type": "websocket.close", "code": 1011})
            return

        path = scope["raw_path"].decode() if scope.get("raw_path") else scope["path"]
        if scope["query_string"]:
            path += "?" + scope["query_string"].decode()
        forwarded = [
            (name.decode(), value.decode(errors="replace"))
            for name, value in scope["headers"]
            if name not in HOP_BY_HOP and name not in WEBSOCKET_HANDSHAKE
        ]
        try:
            upstream = await connect(
                f"ws://{host}{path}",
                host=ip,  # The TCP connection goes to the VM; the Host header stays the preview host.
                port=port,
                origin=origin or None,
                subprotocols=scope.get("subprotocols") or None,
                additional_headers=forwarded,
                user_agent_header=_header(scope, b"user-agent") or None,
                compression=None,
                proxy=None,
                max_size=MAX_WEBSOCKET_MESSAGE,
                max_queue=MAX_WEBSOCKET_QUEUE,
                ping_interval=None,
                open_timeout=10,
            )
        except (OSError, InvalidHandshake, TimeoutError) as error:
            status = error.response.status_code if isinstance(error, InvalidStatus) else None
            logger.info("Preview websocket to %s:%s failed: %s", sandbox_id, port, status or error)
            await send({"type": "websocket.close", "code": 1011})
            return

        async def browser_to_vm() -> None:
            while True:
                message = await receive()
                if message["type"] == "websocket.disconnect":
                    await upstream.close(_sendable_code(message.get("code")))
                    return
                if message.get("bytes") is not None:
                    await upstream.send(message["bytes"])
                elif message.get("text") is not None:
                    await upstream.send(message["text"])

        async def vm_to_browser() -> None:
            try:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await send({"type": "websocket.send", "bytes": message})
                    else:
                        await send({"type": "websocket.send", "text": message})
            except ConnectionClosed:
                pass
            await send({"type": "websocket.close", "code": _sendable_code(upstream.close_code)})

        tasks: list[asyncio.Task] = []
        try:
            await send({"type": "websocket.accept", "subprotocol": upstream.subprotocol})
            tasks = [asyncio.ensure_future(browser_to_vm()), asyncio.ensure_future(vm_to_browser())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if not task.cancelled() and task.exception():
                    logger.debug("Preview websocket ended: %s", task.exception())
        except OSError:
            pass  # The browser left (e.g. while we connected to the VM).
        finally:
            for task in tasks:
                task.cancel()
            # Also when the browser left early: don't leave the terminal's shell or the editor session open.
            await upstream.close()


def _sendable_code(code: int | None) -> int:
    """A close code that may be sent: 1005 and 1006 only describe a connection that ended without one."""
    if code is None or code in (1005, 1006, 1015) or not (1000 <= code < 5000):
        return 1000
    return code


def _skip_requests_to_vms(record: logging.LogRecord) -> bool:
    """Log filter: False for httpx's "HTTP Request: ..." lines about private addresses (the VMs)."""
    url = record.args[1] if isinstance(record.args, tuple) and len(record.args) > 1 else None
    if not isinstance(url, httpx.URL):
        return True
    try:
        return not ipaddress.ip_address(url.host).is_private
    except ValueError:
        return True  # A host name, like api.github.com.


def _response_headers(response: httpx.Response, host: str, ip: str, port: int) -> list[tuple[bytes, bytes]]:
    headers = []
    for name, value in response.headers.raw:
        name = name.lower()
        if name in HOP_BY_HOP or name == b"x-frame-options":
            continue
        if name == b"content-security-policy":
            value = _without_frame_ancestors(value)
            if not value:
                continue
        if name == b"location":
            value = _public_location(value, host, ip, port)
        if name == b"set-cookie":
            value = _cookie_for_iframes(value)
        headers.append((name, value))
    return headers


def _cookie_for_iframes(cookie: bytes) -> bytes:
    """A cookie the browser keeps and sends inside the sandbox page's iframe, too."""
    parts = [part.strip() for part in cookie.split(b";")]
    kept = [parts[0]] + [
        part
        for part in parts[1:]
        if part and part.split(b"=")[0].strip().lower() not in (b"samesite", b"secure", b"partitioned")
    ]
    return b"; ".join(kept + [b"SameSite=None", b"Secure", b"Partitioned"])


def _without_frame_ancestors(policy: bytes) -> bytes:
    directives = [part.strip() for part in policy.split(b";")]
    return b"; ".join(part for part in directives if part and not part.lower().startswith(b"frame-ancestors"))


def _public_location(location: bytes, host: str, ip: str, port: int) -> bytes:
    """Redirects to the app's own address inside the VM go to its preview address instead."""
    text = location.decode(errors="replace")
    for internal in (f"{ip}:{port}", f"localhost:{port}", f"127.0.0.1:{port}", f"0.0.0.0:{port}"):
        for scheme in ("http://", "https://"):
            if text.startswith(scheme + internal):
                return ("http://" + host + text[len(scheme + internal) :]).encode()
    return location


async def _stream_body(response: httpx.Response, send) -> None:
    async for chunk in response.aiter_raw():
        await send({"type": "http.response.body", "body": chunk, "more_body": True})
    await send({"type": "http.response.body", "body": b"", "more_body": False})


async def _wait_for_disconnect(receive, body_done: asyncio.Event) -> None:
    await body_done.wait()
    while (await receive())["type"] != "http.disconnect":
        pass


class _BrowserGone(Exception):
    """The browser disconnected while sending the request body."""


async def _unavailable(scope, send, message: str, retry: bool = True) -> None:
    """502 with a page that reloads itself, so a preview that's still starting shows up on its own."""
    accepts_html = "text/html" in _header(scope, b"accept")
    if not accepts_html:
        await _plain_response(send, 502, message)
        return
    refresh = '<meta http-equiv="refresh" content="3">' if retry else ""
    page = (
        f"<!doctype html><html><head><meta charset='utf-8'>{refresh}<title>Sandbox preview</title>"
        "<meta name='color-scheme' content='light dark'></head>"
        "<body style='font-family: system-ui, sans-serif; padding: 32px; color: #59636e'>"
        f"<p>{html.escape(message, quote=False)}</p>{'<p>Trying again every few seconds…</p>' if retry else ''}</body></html>"
    )
    await _send_response(send, 502, page.encode(), b"text/html; charset=utf-8")


async def _plain_response(send, status: int, message: str) -> None:
    await _send_response(send, status, message.encode(), b"text/plain; charset=utf-8")


async def _send_response(send, status: int, body: bytes, content_type: bytes) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", content_type), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


def _header(scope, name: bytes) -> str:
    for key, value in scope["headers"]:
        if key == name:
            return value.decode(errors="replace")
    return ""
