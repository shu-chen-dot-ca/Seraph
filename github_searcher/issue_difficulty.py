"""How hard each issue in the Issues list is: easy, medium or hard, like LeetCode's levels.

One JSON file, DATA_DIR/issue_difficulty.json, by issue id:

    {"owner/name#n": {"level": "easy" | "medium" | "hard", "reason", "judged_at"}, ...}

Claude reads the issue (title, labels, body, comments) and what the repo is, and rates it on three things:
how much project and domain knowledge the fix needs, whether its effect can be seen plainly without
hidden knock-on effects elsewhere, and how easily the fix can be checked (LEVELS says what each level
means). reason is one plain sentence on why.

Each issue is judged once; the backend judges new ones in the background (backend/issues_api.py).
Kept apart from the Issues list on purpose, like issue_facts.py: undo/redo of the list shouldn't undo
judgments, and an issue that comes back with an undo keeps its level. version goes up on every change.
"""

import asyncio
import copy
import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.claude_judge import judge
from github_searcher.search import CACHE, get_repository, get_thread

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
LEVELS = """\
- easy: small and well defined, a general programming problem (a wrong condition, a missing check, a message,
  a small missing option). Little knowledge of this project or its field is needed. The change stays local, its
  effect is easy to see, and nothing else depends on it in a hidden way. It is easy to check: a short test or a
  visible result shows it works.
- medium: needs some knowledge of this project (how its code is organized, its conventions) or of its field
  (the library's concepts, a file format, a protocol). Still, the effect of the change can be observed well, and
  the project's test suite plus a focused new test are enough to know it is right.
- hard: needs real understanding of the project or its field, or touches central or shared code where a change
  can ripple (public API, performance, concurrency, data formats, security, numerical accuracy, platform
  differences). Hard to validate fully, or the change carries real responsibility: a design decision,
  compatibility, many users affected."""
BODY_CHARS = 6000
COMMENTS_KEPT = 15
COMMENT_CHARS = 800
REASON_CHARS = 240


class IssueDifficulty:
    def __init__(self):
        self.path = DATA_DIR / "issue_difficulty.json"
        self.lock = threading.Lock()
        self.version = 0
        self.levels = {}
        if self.path.exists():
            self.levels = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the levels to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.levels, indent=2))
        temporary.replace(self.path)

    def all(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.levels)

    async def judge(self, issue_id: str) -> dict:
        """Rate one issue ("owner/name#n") and keep it.

        Raises httpx.HTTPError when GitHub fails, ValueError when there is no such issue, JudgeError
        when Claude gives no usable answer.
        """
        name = issue_id.split("#")[0]
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        number = int(issue_id.split("#")[1])
        # The thread as it is now, not the one an agent read an hour ago.
        CACHE.pop(("thread", owner, repo, number), None)
        thread = await asyncio.to_thread(get_thread, owner, repo, number)
        if thread is None:
            raise ValueError(f"GitHub has no issue {issue_id}")
        info = await asyncio.to_thread(get_repository, owner, repo)

        comments = []
        for comment in thread["comments"]["nodes"][:COMMENTS_KEPT]:
            author = comment["author"]["login"] if comment["author"] else "ghost"
            comments.append(f"--- {author} ({comment['authorAssociation']}):\n{comment['body'][:COMMENT_CHARS]}")
        labels = ", ".join(label["name"] for label in thread["labels"]["nodes"]) or "none"
        topics = ", ".join(info.get("topics") or []) or "none"
        prompt = (
            "Rate how hard this GitHub issue is to fix well for a capable programmer who is new to the project, "
            "the way LeetCode rates problems. Judge three things: how much knowledge of this project and its field the "
            "fix needs; whether the effect of the fix can be seen plainly, without hidden knock-on effects elsewhere; and "
            "how easily the fix can be checked. Labels like 'good first issue' are the maintainers' hint, not the answer.\n\n"
            f"{LEVELS}\n\n"
            "reason: one short, plain sentence for the developer on why it is that level, at most 160 characters "
            "(no file or function names).\n\n"
            f"Project: {info['full_name']}, {info['stargazers_count']} stars, language {info.get('language') or 'unknown'}, "
            f"topics {topics}.\nWhat it is: {info.get('description') or 'no description'}\n\n"
            f"Issue #{number}: {thread['title']}\nLabels: {labels}\n\n{(thread['body'] or '(no description)')[:BODY_CHARS]}\n\n"
            + ("Comments:\n" + "\n".join(comments) if comments else "No comments.")
        )
        schema = {
            "type": "object",
            "properties": {
                "level": {"type": "string", "enum": ["easy", "medium", "hard"]},
                "reason": {"type": "string"},
            },
            "required": ["level", "reason"],
        }
        answer = await judge(prompt, schema, "medium")
        reason = answer["reason"].strip()
        if len(reason) > REASON_CHARS:
            reason = reason[:REASON_CHARS - 1].rstrip() + "…"
        level = {"level": answer["level"], "reason": reason, "judged_at": datetime.now(UTC).isoformat()}
        with self.lock:
            self.levels[issue_id] = level
            self.save()
        return copy.deepcopy(level)
