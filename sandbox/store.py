"""Sandbox records and activity logs on disk.

One folder per sandbox in SANDBOX_STATE_DIR:
    <id>/sandbox.json   the Sandbox record
    <id>/events.jsonl   its activity log, one SandboxEvent per line
"""

import json
import logging
import shutil
from pathlib import Path

from pydantic import ValidationError

from sandbox.models import Sandbox, SandboxEvent

logger = logging.getLogger(__name__)


class SandboxStore:
    def __init__(self, root: Path):
        self._root = root

    def load_all(self) -> list[Sandbox]:
        sandboxes = []
        for path in sorted(self._root.glob("*/sandbox.json")):
            try:
                sandboxes.append(Sandbox.model_validate_json(path.read_text()))
            except (OSError, ValidationError) as error:
                logger.warning("Skipping unreadable sandbox record %s: %s", path, error)
        return sandboxes

    def save(self, sandbox: Sandbox) -> None:
        folder = self._root / sandbox.id
        folder.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a record.
        temporary = folder / "sandbox.json.tmp"
        temporary.write_text(sandbox.model_dump_json(indent=2))
        temporary.replace(folder / "sandbox.json")

    def load_events(self, sandbox_id: str) -> list[SandboxEvent]:
        path = self._root / sandbox_id / "events.jsonl"
        if not path.exists():
            return []
        events = []
        for line in path.read_text().splitlines():
            try:
                events.append(SandboxEvent.model_validate(json.loads(line)))
            except (ValueError, ValidationError):
                continue  # A line cut short by a crash.
        return events

    def append_event(self, sandbox_id: str, event: SandboxEvent) -> None:
        folder = self._root / sandbox_id
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / "events.jsonl").open("a") as file:
            file.write(event.model_dump_json() + "\n")

    def delete(self, sandbox_id: str) -> None:
        shutil.rmtree(self._root / sandbox_id, ignore_errors=True)
