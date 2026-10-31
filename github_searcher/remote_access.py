"""Remote access: opening this app from your phone (or any device) at REMOTE_ACCESS_DOMAIN, signed in with a passkey.

The way there (remote_access/README.md has the setup): this computer keeps an SSH connection open to a small server,
the forwarder (an AWS Lightsail one), which sends whatever reaches the domain's ports 443 and 80 back through that
connection, still encrypted, to Caddy on this computer. Caddy holds the domain's certificate, so the forwarder only
ever sees encrypted bytes. Caddy passes /api/* to the backend and everything else to the Vite dev server, the latter
only after asking the backend whether the request is signed in (GET /api/remote_access/check). This computer dials
out, so nothing depends on the router or the network it is on.

Who gets in:
- On this computer (localhost) nothing changes: no sign in.
- Through the domain, every request needs a session: a cookie a device gets by signing in with its passkey (Face ID,
  Touch ID, Windows Hello or a security key). backend/app.py checks it on every API call and on the live websocket;
  Caddy asks for everything else. Only the sign-in pages and ping are open (backend/remote_access_api.py).
  A request came through the domain (from_outside) when its Host is the domain or it carries X-Forwarded-For, which
  Caddy always adds and nothing on this computer sends (the Vite dev server's proxy doesn't).
- A device gets its passkey from a link that Settings → Remote access → Add a device makes, only on this computer:
  a QR code to scan with the phone, good for LINK_MINUTES and used once. The link opens the Add this device page,
  which makes the passkey and signs the device in. All passkeys are for one account (user_id), so a phone added
  again replaces its old passkey there.
- A session lasts SESSION_DAYS; then the device signs in again with its passkey. Remove (Settings) forgets a
  device's passkey and ends its sessions at once (its open live feed too); Sign out ends only that device's session.

DATA_DIR/remote_access.json, readable by this computer's user only:

    {"user_id",
     "devices": [{"id", "name", "credential_id", "public_key" (SPKI, base64url), "algorithm" (-7 ES256, -257 RS256),
                  "added_at", "last_used_at"}],
     "sessions": [{"hash" (sha256 of its cookie), "device", "expires_at"}],
     "links": [{"hash" (sha256 of its token), "expires_at"}]}

Cookies and link tokens are kept only as their hash. expires_at is seconds since 1970; the other times are ISO.

Passkeys are WebAuthn without attestation. At Add, the browser hands over the new public key (getPublicKey()); the
one-time link is what makes that safe. At sign in, the passkey's signature over the authenticator data and the hash
of clientDataJSON is checked with that key. clientDataJSON must carry a challenge this app gave out in the last
CHALLENGE_SECONDS and the domain's origin, and the authenticator data the domain's hash and "user verified".
Challenges live only in memory: a backend restart in the middle of a sign in just means trying again.
Every method runs on the event loop (the router's endpoints are async), so there is no lock.
"""

import base64
import hashlib
import json
import os
import secrets
import time
from datetime import UTC, datetime
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.serialization import load_der_public_key
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Empty: remote access isn't set up, and only this computer can open the app.
DOMAIN = os.environ["REMOTE_ACCESS_DOMAIN"].strip()
ORIGIN = f"https://{DOMAIN}"
COOKIE = "seraph_session"
SESSION_DAYS = 30
LINK_MINUTES = 10
CHALLENGE_SECONDS = 300
# More challenges than this waiting at once means someone is hammering the sign-in page.
CHALLENGES_MAX = 1000
# Authenticator data flags: the user was there, and was verified (Face ID, fingerprint or PIN).
USER_PRESENT = 0x01
USER_VERIFIED = 0x04
LINK_GONE = "This link is used or too old. On the computer, Settings → Remote access → Add a device makes a new one."


class RemoteAccessError(Exception):
    pass


class RemoteAccess:
    def __init__(self):
        self.path = DATA_DIR / "remote_access.json"
        # Challenges given out for a passkey to sign, and when: {challenge (base64url): time.time()}.
        self.challenges = {}
        if self.path.is_file():
            self.data = json.loads(self.path.read_text())
        else:
            self.data = {"user_id": secrets.token_urlsafe(16), "devices": [], "sessions": [], "links": []}

    def save(self) -> None:
        # Old sessions and links go whenever anything is saved.
        now = time.time()
        self.data["sessions"] = [session for session in self.data["sessions"] if session["expires_at"] > now]
        self.data["links"] = [link for link in self.data["links"] if link["expires_at"] > now]
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        # Readable by this computer's user only. Write, then rename.
        temporary = self.path.with_name("remote_access.json.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(json.dumps(self.data, indent=2))
        temporary.replace(self.path)

    def from_outside(self, headers) -> bool:
        """Whether a request came through the domain rather than from this computer (module docstring)."""
        host = headers.get("host", "").split(":")[0]
        return (DOMAIN != "" and host == DOMAIN) or "x-forwarded-for" in headers

    def device_for(self, cookie: str | None) -> dict | None:
        """The device a session cookie belongs to, or None when it isn't a session (any more)."""
        if not cookie:
            return None
        hashed = hashlib.sha256(cookie.encode()).hexdigest()
        now = time.time()
        for session in self.data["sessions"]:
            if session["hash"] != hashed or session["expires_at"] <= now:
                continue
            for device in self.data["devices"]:
                if device["id"] == session["device"]:
                    return device
        return None

    def devices(self) -> list[dict]:
        """The devices, for Settings: never their keys."""
        return [{"id": device["id"], "name": device["name"], "added_at": device["added_at"], "last_used_at": device["last_used_at"]} for device in self.data["devices"]]

    def make_link(self) -> str:
        """A new Add a device link, good for LINK_MINUTES and once."""
        token = secrets.token_urlsafe(32)
        self.data["links"].append({"hash": hashlib.sha256(token.encode()).hexdigest(), "expires_at": time.time() + LINK_MINUTES * 60})
        self.save()
        return f"{ORIGIN}/api/remote_access/add?token={token}"

    def link_works(self, token: str) -> bool:
        hashed = hashlib.sha256(token.encode()).hexdigest()
        now = time.time()
        for link in self.data["links"]:
            if link["hash"] == hashed and link["expires_at"] > now:
                return True
        return False

    def new_challenge(self) -> str:
        """A challenge for a passkey to sign (base64url, as the browser puts it in clientDataJSON). Old ones go."""
        now = time.time()
        self.challenges = {challenge: given for challenge, given in self.challenges.items() if now - given < CHALLENGE_SECONDS}
        if len(self.challenges) >= CHALLENGES_MAX:
            raise RemoteAccessError("Too many sign ins at once. Try again in a few minutes.")
        challenge = secrets.token_urlsafe(32)
        self.challenges[challenge] = now
        return challenge

    def add_device(self, token: str, name: str, credential: dict) -> str:
        """Keeps a new passkey from the Add this device page and signs that device in. Returns its session cookie.

        credential: {"id", "public_key", "algorithm", "client_data", "authenticator_data"}, base64url but algorithm.
        """
        if not self.link_works(token):
            raise RemoteAccessError(LINK_GONE)
        client_data = json.loads(base64.urlsafe_b64decode(credential["client_data"] + "=="))
        if client_data.get("type") != "webauthn.create" or client_data.get("origin") != ORIGIN:
            raise RemoteAccessError("The passkey wasn't made for this address. Try again.")
        given = self.challenges.pop(client_data.get("challenge"), None)
        if given is None or time.time() - given > CHALLENGE_SECONDS:
            raise RemoteAccessError("That took too long. Try again.")
        authenticator_data = base64.urlsafe_b64decode(credential["authenticator_data"] + "==")
        if len(authenticator_data) < 37 or authenticator_data[:32] != hashlib.sha256(DOMAIN.encode()).digest():
            raise RemoteAccessError("The passkey wasn't made for this address. Try again.")
        if (authenticator_data[32] & USER_PRESENT) == 0 or (authenticator_data[32] & USER_VERIFIED) == 0:
            raise RemoteAccessError("The passkey didn't check it's you (Face ID, fingerprint or PIN). Try again.")
        public_key = load_der_public_key(base64.urlsafe_b64decode(credential["public_key"] + "=="))
        es256 = credential["algorithm"] == -7 and isinstance(public_key, ec.EllipticCurvePublicKey) and public_key.curve.name == "secp256r1"
        rs256 = credential["algorithm"] == -257 and isinstance(public_key, rsa.RSAPublicKey)
        if not es256 and not rs256:
            raise RemoteAccessError("This device's kind of passkey can't be used here.")
        # Used once: the link goes now.
        hashed = hashlib.sha256(token.encode()).hexdigest()
        self.data["links"] = [link for link in self.data["links"] if link["hash"] != hashed]
        now = datetime.now(UTC).isoformat()
        # The same passkey added again (a new link on the same phone) replaces its old line.
        self.data["devices"] = [device for device in self.data["devices"] if device["credential_id"] != credential["id"]]
        device = {
            "id": "device_" + secrets.token_hex(4),
            "name": name.strip()[:60] or "Device",
            "credential_id": credential["id"],
            "public_key": credential["public_key"],
            "algorithm": credential["algorithm"],
            "added_at": now,
            "last_used_at": now,
        }
        self.data["devices"].append(device)
        cookie = secrets.token_urlsafe(32)
        self.data["sessions"].append({"hash": hashlib.sha256(cookie.encode()).hexdigest(), "device": device["id"], "expires_at": time.time() + SESSION_DAYS * 86400})
        self.save()
        return cookie

    def sign_in(self, assertion: dict) -> str:
        """Checks a passkey's answer from the Sign in page and starts a session. Returns its cookie.

        assertion: {"id", "client_data", "authenticator_data", "signature"}, all base64url.
        """
        device = None
        for each in self.data["devices"]:
            if each["credential_id"] == assertion["id"]:
                device = each
        if device is None:
            raise RemoteAccessError("This passkey isn't one of Seraph's devices (it may have been removed). On the computer, Settings → Remote access → Add a device.")
        client_data_bytes = base64.urlsafe_b64decode(assertion["client_data"] + "==")
        client_data = json.loads(client_data_bytes)
        if client_data.get("type") != "webauthn.get" or client_data.get("origin") != ORIGIN:
            raise RemoteAccessError("The passkey answered for another address. Try again.")
        given = self.challenges.pop(client_data.get("challenge"), None)
        if given is None or time.time() - given > CHALLENGE_SECONDS:
            raise RemoteAccessError("That took too long. Try again.")
        authenticator_data = base64.urlsafe_b64decode(assertion["authenticator_data"] + "==")
        if len(authenticator_data) < 37 or authenticator_data[:32] != hashlib.sha256(DOMAIN.encode()).digest():
            raise RemoteAccessError("The passkey answered for another address. Try again.")
        if (authenticator_data[32] & USER_PRESENT) == 0 or (authenticator_data[32] & USER_VERIFIED) == 0:
            raise RemoteAccessError("The passkey didn't check it's you (Face ID, fingerprint or PIN). Try again.")
        public_key = load_der_public_key(base64.urlsafe_b64decode(device["public_key"] + "=="))
        signed = authenticator_data + hashlib.sha256(client_data_bytes).digest()
        signature = base64.urlsafe_b64decode(assertion["signature"] + "==")
        try:
            if device["algorithm"] == -7:
                public_key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
            else:
                public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
        except InvalidSignature:
            raise RemoteAccessError("That passkey's answer doesn't check out. Try again.")
        device["last_used_at"] = datetime.now(UTC).isoformat()
        cookie = secrets.token_urlsafe(32)
        self.data["sessions"].append({"hash": hashlib.sha256(cookie.encode()).hexdigest(), "device": device["id"], "expires_at": time.time() + SESSION_DAYS * 86400})
        self.save()
        return cookie

    def sign_out(self, cookie: str | None) -> None:
        """Ends one session: the device it was on has to sign in again."""
        if not cookie:
            return
        hashed = hashlib.sha256(cookie.encode()).hexdigest()
        self.data["sessions"] = [session for session in self.data["sessions"] if session["hash"] != hashed]
        self.save()

    def remove_device(self, device_id: str) -> None:
        """Forgets a device's passkey and ends its sessions at once."""
        if not any(device["id"] == device_id for device in self.data["devices"]):
            raise RemoteAccessError("No such device.")
        self.data["devices"] = [device for device in self.data["devices"] if device["id"] != device_id]
        self.data["sessions"] = [session for session in self.data["sessions"] if session["device"] != device_id]
        self.save()
