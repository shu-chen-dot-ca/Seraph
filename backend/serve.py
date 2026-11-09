"""Starts the backend (`uv run serve`), reloading it when the code changes (in the dev copy only, see main).

Apart from backend/app.py on purpose: with reload, this process only watches the files and restarts
the server process, which imports the app. Importing the app here too would make a second set of
stores (backend/shared.py) in this process, whose threads (VM watchers, the image task follower)
would keep writing to data/ with the code from when it started.
"""

import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)


def main() -> None:
    # The dev copy (./run.sh) reloads on every code change. The live copy (deploy/, the service sets SERAPH_HOME) only
    # changes by an update, so a save in the dev copy never restarts it.
    reload = os.environ.get("SERAPH_HOME", "") == ""
    # A restart waits at most this long for open connections: a browser that stopped reading its live feed (a dead tab
    # behind the dev server's proxy) would otherwise hold every reload up forever.
    uvicorn.run("backend.app:app", host="127.0.0.1", port=int(os.environ["BACKEND_PORT"]), reload=reload, timeout_graceful_shutdown=10)
