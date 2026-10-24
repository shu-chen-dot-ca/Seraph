"""Starts the backend (`uv run serve`), reloading it when the code changes.

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
    uvicorn.run("backend.app:app", host="127.0.0.1", port=int(os.environ["BACKEND_PORT"]), reload=True)
