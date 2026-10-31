"""Remote access (github_searcher/remote_access.py): the one-time Add a device link, passkey sign in and sessions.

The passkey is a P-256 key made by the test, answering the way a phone's does (WebAuthn): it signs the authenticator
data followed by the sha256 of clientDataJSON. Everything is kept in pytest's temporary folder, never in DATA_DIR."""

import base64
import hashlib
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from github_searcher import remote_access
from github_searcher.remote_access import LINK_GONE, RemoteAccess, RemoteAccessError

DOMAIN = "seraph.example"
ORIGIN = "https://seraph.example"
# What a phone's passkey answers with: sha256 of the domain, its flags (user present 0x01, user verified 0x04),
# and a 4-byte sign counter.
AUTHENTICATOR_DATA = hashlib.sha256(DOMAIN.encode()).digest() + bytes([0x05]) + bytes(4)


@pytest.fixture
def access(tmp_path, monkeypatch):
    """Remote access for seraph.example, with its remote_access.json in a temporary folder."""
    monkeypatch.setattr(remote_access, "DATA_DIR", tmp_path)
    monkeypatch.setattr(remote_access, "DOMAIN", DOMAIN)
    monkeypatch.setattr(remote_access, "ORIGIN", ORIGIN)
    return RemoteAccess()


@pytest.fixture
def phone(access):
    """A phone added with an Add a device link: its passkey (private key and id), the link's token and its cookie."""
    key = ec.generate_private_key(ec.SECP256R1())
    token = access.make_link().split("token=")[1]
    client_data = json.dumps({"type": "webauthn.create", "challenge": access.new_challenge(), "origin": ORIGIN}).encode()
    public_key = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    credential = {
        "id": "phone-passkey",
        "public_key": base64.urlsafe_b64encode(public_key).decode().rstrip("="),
        "algorithm": -7,
        "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
        "authenticator_data": base64.urlsafe_b64encode(AUTHENTICATOR_DATA).decode().rstrip("="),
    }
    cookie = access.add_device(token, "iPhone", credential)
    return {"key": key, "id": "phone-passkey", "token": token, "cookie": cookie}


@pytest.mark.parametrize(
    "headers, outside",
    [
        ({"host": "localhost:5173"}, False),
        ({"host": "127.0.0.1:8001"}, False),
        ({"host": "seraph.example"}, True),
        ({"host": "seraph.example:443"}, True),
        ({"host": "localhost:8001", "x-forwarded-for": "203.0.113.7"}, True),
    ],
)
def test_from_outside(access, headers, outside):
    assert access.from_outside(headers) is outside


def test_without_a_domain_only_forwarded_requests_are_outside(access, monkeypatch):
    monkeypatch.setattr(remote_access, "DOMAIN", "")

    assert access.from_outside({}) is False
    assert access.from_outside({"host": ""}) is False
    assert access.from_outside({"x-forwarded-for": "203.0.113.7"}) is True


def test_new_link_works(access):
    token = access.make_link().split("token=")[1]

    assert access.link_works(token) is True
    assert access.link_works("made-up-token") is False


def test_old_link_does_not_work(access):
    token = access.make_link().split("token=")[1]
    access.data["links"][0]["expires_at"] = time.time() - 1

    assert access.link_works(token) is False


def test_link_works_once(access, phone):
    assert access.link_works(phone["token"]) is False
    with pytest.raises(RemoteAccessError, match=LINK_GONE):
        access.add_device(phone["token"], "Second phone", {})


def test_added_phone_is_signed_in(access, phone):
    assert access.device_for(phone["cookie"])["name"] == "iPhone"
    assert access.device_for("made-up-cookie") is None
    assert access.device_for(None) is None


def test_device_list_never_shows_keys(access, phone):
    devices = access.devices()

    assert len(devices) == 1
    assert sorted(devices[0]) == ["added_at", "id", "last_used_at", "name"]


def test_passkey_made_for_another_address_is_refused(access):
    key = ec.generate_private_key(ec.SECP256R1())
    token = access.make_link().split("token=")[1]
    client_data = json.dumps({"type": "webauthn.create", "challenge": access.new_challenge(), "origin": "https://evil.example"}).encode()
    public_key = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    credential = {
        "id": "evil-passkey",
        "public_key": base64.urlsafe_b64encode(public_key).decode().rstrip("="),
        "algorithm": -7,
        "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
        "authenticator_data": base64.urlsafe_b64encode(AUTHENTICATOR_DATA).decode().rstrip("="),
    }

    with pytest.raises(RemoteAccessError, match="wasn't made for this address"):
        access.add_device(token, "Evil", credential)
    assert access.devices() == []
    # A refused passkey doesn't use up the link.
    assert access.link_works(token) is True


def test_passkey_signs_in(access, phone):
    client_data = json.dumps({"type": "webauthn.get", "challenge": access.new_challenge(), "origin": ORIGIN}).encode()
    signature = phone["key"].sign(AUTHENTICATOR_DATA + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))

    cookie = access.sign_in({
        "id": phone["id"],
        "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
        "authenticator_data": base64.urlsafe_b64encode(AUTHENTICATOR_DATA).decode().rstrip("="),
        "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
    })

    assert cookie != phone["cookie"]
    assert access.device_for(cookie)["name"] == "iPhone"


def test_unknown_passkey_is_refused(access, phone):
    with pytest.raises(RemoteAccessError, match="isn't one of Seraph's devices"):
        access.sign_in({"id": "someone-elses-passkey"})


def test_answer_signed_by_another_key_is_refused(access, phone):
    other_key = ec.generate_private_key(ec.SECP256R1())
    client_data = json.dumps({"type": "webauthn.get", "challenge": access.new_challenge(), "origin": ORIGIN}).encode()
    signature = other_key.sign(AUTHENTICATOR_DATA + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))

    with pytest.raises(RemoteAccessError, match="doesn't check out"):
        access.sign_in({
            "id": phone["id"],
            "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
            "authenticator_data": base64.urlsafe_b64encode(AUTHENTICATOR_DATA).decode().rstrip("="),
            "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
        })


def test_same_answer_twice_is_refused(access, phone):
    client_data = json.dumps({"type": "webauthn.get", "challenge": access.new_challenge(), "origin": ORIGIN}).encode()
    signature = phone["key"].sign(AUTHENTICATOR_DATA + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
    assertion = {
        "id": phone["id"],
        "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
        "authenticator_data": base64.urlsafe_b64encode(AUTHENTICATOR_DATA).decode().rstrip("="),
        "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
    }
    access.sign_in(assertion)

    # Its challenge was used up by the first sign in, so a copied answer can't be replayed.
    with pytest.raises(RemoteAccessError, match="took too long"):
        access.sign_in(assertion)


def test_old_challenge_is_refused(access, phone):
    challenge = access.new_challenge()
    access.challenges[challenge] = time.time() - remote_access.CHALLENGE_SECONDS - 1
    client_data = json.dumps({"type": "webauthn.get", "challenge": challenge, "origin": ORIGIN}).encode()
    signature = phone["key"].sign(AUTHENTICATOR_DATA + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))

    with pytest.raises(RemoteAccessError, match="took too long"):
        access.sign_in({
            "id": phone["id"],
            "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
            "authenticator_data": base64.urlsafe_b64encode(AUTHENTICATOR_DATA).decode().rstrip("="),
            "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
        })


def test_answer_for_another_domain_is_refused(access, phone):
    # Signed by the right passkey, but its authenticator data is for another site.
    authenticator_data = hashlib.sha256(b"evil.example").digest() + bytes([0x05]) + bytes(4)
    client_data = json.dumps({"type": "webauthn.get", "challenge": access.new_challenge(), "origin": ORIGIN}).encode()
    signature = phone["key"].sign(authenticator_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))

    with pytest.raises(RemoteAccessError, match="another address"):
        access.sign_in({
            "id": phone["id"],
            "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
            "authenticator_data": base64.urlsafe_b64encode(authenticator_data).decode().rstrip("="),
            "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
        })


def test_answer_without_user_verified_is_refused(access, phone):
    # User present (0x01) but not verified: nobody did Face ID, a fingerprint or a PIN.
    authenticator_data = hashlib.sha256(DOMAIN.encode()).digest() + bytes([0x01]) + bytes(4)
    client_data = json.dumps({"type": "webauthn.get", "challenge": access.new_challenge(), "origin": ORIGIN}).encode()
    signature = phone["key"].sign(authenticator_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))

    with pytest.raises(RemoteAccessError, match="didn't check it's you"):
        access.sign_in({
            "id": phone["id"],
            "client_data": base64.urlsafe_b64encode(client_data).decode().rstrip("="),
            "authenticator_data": base64.urlsafe_b64encode(authenticator_data).decode().rstrip("="),
            "signature": base64.urlsafe_b64encode(signature).decode().rstrip("="),
        })


def test_too_many_challenges_at_once_are_refused(access):
    for _ in range(remote_access.CHALLENGES_MAX):
        access.new_challenge()

    with pytest.raises(RemoteAccessError, match="Too many sign ins"):
        access.new_challenge()


def test_old_session_is_signed_out(access, phone):
    access.data["sessions"][0]["expires_at"] = time.time() - 1

    assert access.device_for(phone["cookie"]) is None


def test_sign_out_ends_the_session(access, phone):
    access.sign_out(phone["cookie"])

    assert access.device_for(phone["cookie"]) is None
    assert len(access.devices()) == 1


def test_remove_ends_the_devices_sessions(access, phone):
    access.remove_device(access.devices()[0]["id"])

    assert access.devices() == []
    assert access.device_for(phone["cookie"]) is None
    with pytest.raises(RemoteAccessError, match="No such device"):
        access.remove_device("device_gone")


def test_file_is_private_and_keeps_only_hashes(access, phone, tmp_path):
    path = tmp_path / "remote_access.json"

    assert path.stat().st_mode & 0o777 == 0o600
    assert phone["cookie"] not in path.read_text()
    assert phone["token"] not in path.read_text()
    assert hashlib.sha256(phone["cookie"].encode()).hexdigest() in path.read_text()


def test_saved_devices_come_back_after_a_restart(access, phone):
    restarted = RemoteAccess()

    assert restarted.device_for(phone["cookie"])["name"] == "iPhone"
