"""Every GitHub request goes through here. It spreads them over all the GitHub tokens in .env,
paces them and waits out rate limits, so agents searching hard don't get errors back.

Tokens: GITHUB_TOKEN, then GITHUB_TOKEN_2, GITHUB_TOKEN_3, ... in .env (any number; empty ones
are skipped). Each should come from a different GitHub account: GitHub counts every limit per
account, so two tokens of one account share one quota and add nothing.

GitHub has two sorts of limits, each per account and per kind of request:
- Quotas: core (REST, 5,000 an hour), graphql (5,000 points an hour), search (30 a minute) and
  code_search (10 a minute). Every answer says what is left (X-RateLimit-Remaining, -Reset).
- Secondary limits: too many requests at the same time or in a burst. GitHub answers 403 or 429
  with "secondary rate limit", often with Retry-After. This is what the agents hit: a few
  searches at once, right after a burst of heavy GraphQL queries.

So for every request this:
1. waits for a token that may go now: not paused, quota left, fewer than RUNNING[kind] of its
   requests of that kind running, and at least GAP[kind] seconds after its last one of that kind.
   Of those it takes the one with the most quota left;
2. on a rate-limit answer pauses that token for that kind (Retry-After, else until its quota
   resets, else PAUSE seconds) and sends the request again with the next token that may go;
3. gives up when that would take more than MAX_WAIT seconds, with a 429 answer that says when a
   token is free again, so callers handle it like any other GitHub error.

Requests run in threads (the agents' tools use asyncio.to_thread, FastAPI runs plain endpoints
in threads), so waiting here only holds up that one request.

status() is what the Explore page shows as bars: per kind and token, what is left of the quota and when it
fills up again, pauses, running and waiting requests. version goes up whenever any of that changes, so the
live feed knows when to send it. prime() asks GitHub for every quota once (/rate_limit costs nothing), so
the bars are right before the first request of a kind.

own_token: a request about one of your repositories (the GitHub tab's thread pop-up, which may show a private one) goes
with your own sign-in's token instead (github_searcher/your_repositories.py), sent as it is: not spread, paced or
counted in the bars, since the search tokens can't see private repos.

    response = BALANCER.request("GET", "https://api.github.com/search/issues", params={"q": q})

    python -m github_searcher.token_balancer     # each token's account and what is left of its quotas
"""

import os
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

# Per kind of request and per token: how many may run at once, and the least seconds between two
# starts. Search is 30 a minute (one every 2 s), code search 10 a minute (one every 6 s).
RUNNING = {"core": 4, "graphql": 2, "search": 1, "code_search": 1}
GAP = {"core": 0, "graphql": 0, "search": 2, "code_search": 6}
# A secondary limit without Retry-After: GitHub asks to wait at least a minute.
PAUSE = 60
MAX_WAIT = 120


class TokenBalancer:
    def __init__(self):
        # GITHUB_TOKEN first, then GITHUB_TOKEN_2, _3, ... in number order.
        names = ["GITHUB_TOKEN"]
        numbers = []
        for key in os.environ:
            if key.startswith("GITHUB_TOKEN_") and key.removeprefix("GITHUB_TOKEN_").isdigit():
                numbers.append(int(key.removeprefix("GITHUB_TOKEN_")))
        for number in sorted(numbers):
            names.append(f"GITHUB_TOKEN_{number}")

        self.tokens = []
        for name in names:
            value = os.environ.get(name, "").strip()
            if not value:
                continue
            kinds = {}
            for kind in RUNNING:
                # remaining None: not known yet. Times are time.monotonic().
                kinds[kind] = {"running": 0, "next_at": 0.0, "paused_until": 0.0, "remaining": None, "limit": None, "reset_at": 0.0}
            self.tokens.append({"name": name, "value": value, "kinds": kinds})
        if not self.tokens:
            raise KeyError("GITHUB_TOKEN is not set in .env")
        # Guards every token's counters. Waiting requests are woken when one ends.
        self.condition = threading.Condition()
        # Requests of each kind waiting for a token right now.
        self.waiting = {kind: 0 for kind in RUNNING}
        self.version = 0

    def slots(self, kind: str) -> int:
        """How many requests of this kind can run at once over all tokens."""
        return RUNNING[kind] * len(self.tokens)

    def request(self, method: str, url: str, accept: str = "application/vnd.github+json", params: dict | None = None, json: dict | None = None, timeout: float = 30, own_token: str | None = None) -> httpx.Response:
        """Send one request with the best token right now. Waits as needed, up to MAX_WAIT seconds."""
        if own_token is not None:
            headers = {"Accept": accept, "Authorization": f"Bearer {own_token}", "X-GitHub-Api-Version": "2022-11-28"}
            return httpx.request(method, url, headers=headers, params=params, json=json, timeout=timeout)
        kind = "core"
        if url.endswith("/graphql"):
            kind = "graphql"
        elif "/search/code" in url:
            kind = "code_search"
        elif "/search/" in url:
            kind = "search"

        deadline = time.monotonic() + MAX_WAIT
        while True:
            token = self.take(kind, deadline)
            if not isinstance(token, dict):
                free_at = datetime.fromtimestamp(token).strftime("%H:%M:%S")
                message = (
                    f"GitHub rate limit: all {len(self.tokens)} tokens are paused for {kind} requests until {free_at}. "
                    "Try again after that."
                )
                return httpx.Response(429, json={"message": message}, request=httpx.Request(method, url))

            headers = {"Accept": accept, "Authorization": f"Bearer {token['value']}", "X-GitHub-Api-Version": "2022-11-28"}
            try:
                response = httpx.request(method, url, headers=headers, params=params, json=json, timeout=timeout)
            except Exception:
                self.done(token, kind, None)
                raise
            if not self.done(token, kind, response):
                return response
            print(f"[github] {token['name']} hit a {kind} rate limit, trying again")

    def take(self, kind: str, deadline: float) -> dict | float:
        """Wait for a token that may send a request of this kind now, and count it as running.

        Returns the token. When no token is free before the deadline, returns the time
        (time.time()) the first one is, for the error message.
        """
        with self.condition:
            self.waiting[kind] += 1
            self.version += 1
            while True:
                now = time.monotonic()
                best = None
                best_left = -1
                # When the first token that is waiting out a gap, pause or quota may go again.
                soonest = None
                # Whether a token is only full of running requests: free as soon as one ends.
                busy = False
                for token in self.tokens:
                    state = token["kinds"][kind]
                    if state["running"] >= RUNNING[kind]:
                        busy = True
                        continue
                    ready = max(state["next_at"], state["paused_until"])
                    if state["remaining"] == 0:
                        ready = max(ready, state["reset_at"])
                    if ready > now:
                        if soonest is None or ready < soonest:
                            soonest = ready
                        continue
                    # Unknown quota counts as full: the token hasn't been used for this yet.
                    left = state["remaining"] if state["remaining"] is not None else 1_000_000
                    if left > best_left:
                        best = token
                        best_left = left

                if best is not None:
                    state = best["kinds"][kind]
                    state["running"] += 1
                    state["next_at"] = now + GAP[kind]
                    self.waiting[kind] -= 1
                    self.version += 1
                    return best
                if not busy and soonest > deadline:
                    self.waiting[kind] -= 1
                    self.version += 1
                    return time.time() + (soonest - now)
                # Woken early when a request ends; otherwise when the first gap or pause is over.
                wait = 1.0 if soonest is None else min(soonest - now, 1.0)
                self.condition.wait(wait)

    def done(self, token: dict, kind: str, response: httpx.Response | None) -> bool:
        """A request ended: note what GitHub says is left. Returns whether it was rate limited (then the token is paused)."""
        with self.condition:
            state = token["kinds"][kind]
            state["running"] -= 1
            self.version += 1
            self.condition.notify_all()
            if response is None:
                return False

            now = time.monotonic()
            remaining = response.headers.get("x-ratelimit-remaining", "")
            limit = response.headers.get("x-ratelimit-limit", "")
            reset = response.headers.get("x-ratelimit-reset", "")
            if remaining.isdigit():
                state["remaining"] = int(remaining)
            if limit.isdigit():
                state["limit"] = int(limit)
            if reset.isdigit():
                state["reset_at"] = now + max(0, int(reset) - time.time())

            retry_after = response.headers.get("retry-after", "")
            limited = False
            if response.status_code in (403, 429):
                limited = retry_after.isdigit() or remaining == "0" or "rate limit" in response.text.lower()
            # GraphQL says a used-up quota with a 200 and an error of type RATE_LIMITED.
            if kind == "graphql" and response.status_code == 200 and '"RATE_LIMITED"' in response.text:
                limited = True
            if not limited:
                return False

            if retry_after.isdigit():
                state["paused_until"] = now + int(retry_after)
            elif remaining == "0" and state["reset_at"] > now:
                state["paused_until"] = state["reset_at"]
            else:
                state["paused_until"] = now + PAUSE
            return True

    def prime(self) -> None:
        """Ask GitHub what is left of every quota of every token. /rate_limit costs no quota. Blocking."""
        for token in self.tokens:
            headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token['value']}"}
            try:
                response = httpx.get("https://api.github.com/rate_limit", headers=headers, timeout=30)
                resources = response.json()["resources"]
            except Exception:
                # A token that doesn't work, or GitHub down: its bars fill in with its first requests.
                continue
            with self.condition:
                now = time.monotonic()
                for kind in RUNNING:
                    if kind not in resources:
                        continue
                    state = token["kinds"][kind]
                    state["remaining"] = resources[kind]["remaining"]
                    state["limit"] = resources[kind]["limit"]
                    state["reset_at"] = now + max(0, resources[kind]["reset"] - time.time())
                self.version += 1

    def status(self) -> dict:
        """Per kind: waiting requests, and per token (by its .env name, never its value) what is left, its limit,
        when the quota fills up again and until when it is paused (wall-clock ISO times, None when not so).
        A quota whose reset time has passed is shown full: GitHub has filled it, it just wasn't used since.
        """
        result = {}
        with self.condition:
            now = time.monotonic()
            wall = time.time()
            for kind in RUNNING:
                tokens = []
                for token in self.tokens:
                    state = token["kinds"][kind]
                    remaining = state["remaining"]
                    reset_at = None
                    if state["reset_at"] > now:
                        reset_at = datetime.fromtimestamp(wall + state["reset_at"] - now).astimezone().isoformat()
                    elif state["limit"] is not None:
                        remaining = state["limit"]
                    paused_until = None
                    if state["paused_until"] > now:
                        paused_until = datetime.fromtimestamp(wall + state["paused_until"] - now).astimezone().isoformat()
                    tokens.append(
                        {
                            "name": token["name"],
                            "remaining": remaining,
                            "limit": state["limit"],
                            "reset_at": reset_at,
                            "paused_until": paused_until,
                            "running": state["running"],
                        }
                    )
                result[kind] = {"waiting": self.waiting[kind], "tokens": tokens}
        return result


BALANCER = TokenBalancer()


def main():
    """Show each token's account and what is left of its quotas. /user and /rate_limit cost no quota."""
    logins = []
    for token in BALANCER.tokens:
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token['value']}"}
        user = httpx.get("https://api.github.com/user", headers=headers, timeout=30)
        if user.status_code != 200:
            print(f"{token['name']}: does not work (GitHub answered {user.status_code}: {user.json().get('message', '')})")
            continue
        login = user.json()["login"]
        logins.append(login)
        resources = httpx.get("https://api.github.com/rate_limit", headers=headers, timeout=30).json()["resources"]
        quotas = []
        for kind in RUNNING:
            quotas.append(f"{kind} {resources[kind]['remaining']}/{resources[kind]['limit']}")
        print(f"{token['name']}: {login}  " + "  ".join(quotas))

    for login in sorted(set(logins)):
        if logins.count(login) > 1:
            print(f"Warning: {logins.count(login)} tokens belong to {login}. They share one quota; use one token per account.")


if __name__ == "__main__":
    main()
