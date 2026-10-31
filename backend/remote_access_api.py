"""Remote access, Settings → Remote access: the sign-in pages at REMOTE_ACCESS_DOMAIN, and the devices that may sign in.
How it works is in github_searcher/remote_access.py, the one-time setup in remote_access/README.md.

Open without a sign in (OPEN_PATHS; backend/app.py lets them through):
- GET /api/remote_access/check: Caddy asks this before it passes on a request for the app's own files (the Vite dev
  server). 200 when signed in, else a redirect to the Sign in page.
- GET /api/remote_access/sign_in: the Sign in page. A plain page from here, since the app's own files are only served
  after a sign in. It gets a challenge as soon as it opens (POST /api/remote_access/sign_in/options; Safari only asks
  a passkey right on a tap), and Sign in with passkey sends the passkey's answer (POST /api/remote_access/sign_in),
  which sets the session cookie, then opens the app.
- GET /api/remote_access/add?token=...: the Add this device page, from Add a device's link: the device's name (guessed
  from the browser) and Create passkey. POST /api/remote_access/add/options, then POST /api/remote_access/add, which
  keeps the passkey, sets the session cookie and opens the app.
- GET /api/remote_access/ping: this backend's PING_ID, so the status can tell the domain really reaches this computer.

Signed in, or on this computer:
- GET /api/remote_access: the domain, whether it reaches this computer right now (asked through the domain from here:
  out to the forwarder and back), the devices, whether this request is on this computer, and which device it is.
- POST /api/remote_access/links: a new Add a device link. Only on this computer.
- DELETE /api/remote_access/devices/{id}: Remove. POST /api/remote_access/sign_out: this device signs out.
"""

import secrets

import httpx
from cryptography.exceptions import UnsupportedAlgorithm
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from backend.shared import remote_access
from github_searcher.remote_access import COOKIE, DOMAIN, LINK_GONE, LINK_MINUTES, SESSION_DAYS, RemoteAccessError

router = APIRouter(prefix="/api")

OPEN_PATHS = [
    "/api/remote_access/check",
    "/api/remote_access/sign_in",
    "/api/remote_access/sign_in/options",
    "/api/remote_access/add",
    "/api/remote_access/add/options",
    "/api/remote_access/ping",
]
# Tells ping's answer apart from any other server's: only this backend knows it.
PING_ID = secrets.token_hex(8)

# The two pages' look: the app's own colors (index.css), light or dark like the device.
PAGE_HEAD = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg: #faf9f7; --fg: #211e1a; --muted: #6f6a62; --card: #ffffff; --border: #e5e0d8; --primary: oklch(0.546 0.245 262.881); --error: #c42b1c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0e1015; --fg: #e6e6ea; --muted: #8b8b94; --card: #161920; --border: #262a33; --primary: oklch(0.623 0.214 259.815); --error: #f87171; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { box-sizing: border-box; width: min(360px, calc(100vw - 32px)); padding: 28px 24px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: var(--muted); }
  label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
  input { box-sizing: border-box; width: 100%; margin-bottom: 14px; padding: 10px 12px; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; }
  button { width: 100%; padding: 11px; font: inherit; font-weight: 600; color: #fff; background: var(--primary); border: 0; border-radius: 8px; }
  button:disabled { opacity: 0.6; }
  #message { min-height: 1.5em; margin-top: 14px; color: var(--error); }
</style>
"""

# base64url to and from the bytes WebAuthn wants, the same encoding the backend reads.
PAGE_SCRIPT_START = """<script>
const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64 = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
const button = document.getElementById("go");
const message = document.getElementById("message");
let options = null;
"""

SIGN_IN_PAGE = PAGE_HEAD + """<title>Sign in · Seraph</title>
<main>
  <h1>Sign in to Seraph</h1>
  <p>With this device's passkey.</p>
  <button id="go" disabled>Sign in with passkey</button>
  <div id="message"></div>
</main>
""" + PAGE_SCRIPT_START + """
async function getOptions() {
  options = null;
  button.disabled = true;
  try {
    const response = await fetch("/api/remote_access/sign_in/options", { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      message.textContent = body.detail;
      return;
    }
    options = body;
    button.disabled = false;
  } catch {
    message.textContent = "Can't reach Seraph right now.";
  }
}

button.onclick = async () => {
  message.textContent = "";
  try {
    const credential = await navigator.credentials.get({
      publicKey: { challenge: unb64(options.challenge), rpId: options.rp_id, userVerification: "required", timeout: 120000 },
    });
    const response = await fetch("/api/remote_access/sign_in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: b64(credential.rawId),
        client_data: b64(credential.response.clientDataJSON),
        authenticator_data: b64(credential.response.authenticatorData),
        signature: b64(credential.response.signature),
      }),
    });
    if (response.ok) {
      location.href = "/";
      return;
    }
    message.textContent = (await response.json()).detail;
  } catch (error) {
    message.textContent = error.name === "NotAllowedError" ? "Cancelled, or this device has no passkey for Seraph." : String(error);
  }
  getOptions();
};

getOptions();
</script>
"""

ADD_PAGE = PAGE_HEAD + """<title>Add this device · Seraph</title>
<main>
  <h1>Add this device</h1>
  <p>It gets a passkey for Seraph, so it can sign in from anywhere.</p>
  <label for="device-name">Device name</label>
  <input id="device-name" maxlength="60" autocomplete="off">
  <button id="go" disabled>Create passkey</button>
  <div id="message"></div>
</main>
""" + PAGE_SCRIPT_START + """
const token = new URLSearchParams(location.search).get("token") ?? "";
const nameField = document.getElementById("device-name");
const agent = navigator.userAgent;
nameField.value = /iPhone/.test(agent) ? "iPhone" : /iPad/.test(agent) ? "iPad" : /Android/.test(agent) ? "Android phone" : /Macintosh/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows PC" : "Device";

async function getOptions() {
  options = null;
  button.disabled = true;
  try {
    const response = await fetch("/api/remote_access/add/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    });
    const body = await response.json();
    if (!response.ok) {
      message.textContent = body.detail;
      return;
    }
    options = body;
    button.disabled = false;
  } catch {
    message.textContent = "Can't reach Seraph right now.";
  }
}

button.onclick = async () => {
  message.textContent = "";
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: unb64(options.challenge),
        rp: { id: options.rp_id, name: "Seraph" },
        user: { id: unb64(options.user_id), name: "Seraph", displayName: "Seraph" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 120000,
      },
    });
    const publicKey = credential.response.getPublicKey();
    if (publicKey === null) {
      message.textContent = "This device's kind of passkey can't be used here.";
      return;
    }
    const response = await fetch("/api/remote_access/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token,
        name: nameField.value,
        id: b64(credential.rawId),
        public_key: b64(publicKey),
        algorithm: credential.response.getPublicKeyAlgorithm(),
        client_data: b64(credential.response.clientDataJSON),
        authenticator_data: b64(credential.response.getAuthenticatorData()),
      }),
    });
    if (response.ok) {
      location.href = "/";
      return;
    }
    message.textContent = (await response.json()).detail;
  } catch (error) {
    message.textContent = error.name === "NotAllowedError" ? "Cancelled. Tap Create passkey to try again." : String(error);
  }
  getOptions();
};

getOptions();
</script>
"""


class SignInRequest(BaseModel):
    id: str
    client_data: str
    authenticator_data: str
    signature: str


class OptionsRequest(BaseModel):
    token: str


class AddRequest(BaseModel):
    token: str
    name: str
    id: str
    public_key: str
    algorithm: int
    client_data: str
    authenticator_data: str


@router.get("/remote_access/check")
async def check(request: Request) -> Response:
    if remote_access.device_for(request.cookies.get(COOKIE)) is None:
        return RedirectResponse("/api/remote_access/sign_in", status_code=302)
    return Response(status_code=200)


@router.get("/remote_access/sign_in")
async def sign_in_page() -> HTMLResponse:
    return HTMLResponse(SIGN_IN_PAGE)


@router.post("/remote_access/sign_in/options")
async def sign_in_options() -> dict:
    try:
        challenge = remote_access.new_challenge()
    except RemoteAccessError as error:
        raise HTTPException(status_code=429, detail=str(error))
    return {"challenge": challenge, "rp_id": DOMAIN}


@router.post("/remote_access/sign_in")
async def sign_in(body: SignInRequest) -> JSONResponse:
    try:
        cookie = remote_access.sign_in(body.model_dump())
    except RemoteAccessError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except (ValueError, UnsupportedAlgorithm):
        raise HTTPException(status_code=400, detail="That passkey's answer couldn't be read. Try again.")
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, cookie, max_age=SESSION_DAYS * 86400, httponly=True, secure=True, samesite="lax")
    return response


@router.get("/remote_access/add")
async def add_page() -> HTMLResponse:
    # The page reads the token itself and sends it with each step, so a used or old link says so there.
    return HTMLResponse(ADD_PAGE)


@router.post("/remote_access/add/options")
async def add_options(body: OptionsRequest) -> dict:
    if not remote_access.link_works(body.token):
        raise HTTPException(status_code=400, detail=LINK_GONE)
    try:
        challenge = remote_access.new_challenge()
    except RemoteAccessError as error:
        raise HTTPException(status_code=429, detail=str(error))
    return {"challenge": challenge, "rp_id": DOMAIN, "user_id": remote_access.data["user_id"]}


@router.post("/remote_access/add")
async def add(body: AddRequest) -> JSONResponse:
    try:
        cookie = remote_access.add_device(body.token, body.name, body.model_dump())
    except RemoteAccessError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except (ValueError, UnsupportedAlgorithm):
        raise HTTPException(status_code=400, detail="This device's passkey couldn't be read. Try again.")
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, cookie, max_age=SESSION_DAYS * 86400, httponly=True, secure=True, samesite="lax")
    return response


@router.get("/remote_access/ping")
async def ping() -> dict:
    return {"id": PING_ID}


@router.get("/remote_access")
async def status(request: Request) -> dict:
    # None: not set up. Otherwise whether ping, asked through the domain, comes back from this very backend.
    reachable = None
    if DOMAIN != "":
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                answer = await client.get(f"https://{DOMAIN}/api/remote_access/ping")
            reachable = answer.status_code == 200 and answer.json().get("id") == PING_ID
        except (httpx.HTTPError, ValueError):
            reachable = False
    outside = remote_access.from_outside(request.headers)
    device = remote_access.device_for(request.cookies.get(COOKIE)) if outside else None
    return {
        "domain": DOMAIN,
        "reachable": reachable,
        "on_this_computer": not outside,
        "devices": remote_access.devices(),
        "this_device": device["id"] if device is not None else None,
    }


@router.post("/remote_access/links")
async def make_link(request: Request) -> dict:
    if remote_access.from_outside(request.headers):
        raise HTTPException(status_code=403, detail="Devices are added on the computer Seraph runs on.")
    if DOMAIN == "":
        raise HTTPException(status_code=409, detail="Remote access isn't set up: REMOTE_ACCESS_DOMAIN in .env is empty.")
    return {"link": remote_access.make_link(), "minutes": LINK_MINUTES}


@router.delete("/remote_access/devices/{device_id}")
async def remove_device(device_id: str) -> dict:
    try:
        remote_access.remove_device(device_id)
    except RemoteAccessError as error:
        raise HTTPException(status_code=404, detail=str(error))
    return {"ok": True}


@router.post("/remote_access/sign_out")
async def sign_out(request: Request) -> JSONResponse:
    remote_access.sign_out(request.cookies.get(COOKIE))
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, secure=True, httponly=True, samesite="lax")
    return response
