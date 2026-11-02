# Development

```text
github_searcher/    search, signals, Explore, lists, agents, jobs, Inbox, sending
  agent/            the agents' prompt and tools
sandbox/            Incus VMs, desktops, the VM queue, images, in-VM tools
backend/            FastAPI: one router per page, and the /api/live websocket
frontend/           React 19, Vite, Tailwind, shadcn/ui
deploy/             live copy install, switch, rollback
remote_access/      Caddy and the SSH tunnel for phone access
docs/               these pages
data/               runtime state, not in git
```

```bash
./run.sh                        # backend and frontend, both reloading
uv run pytest                   # tests
cd frontend && npm run build    # type-check and build
```

**CI** runs on pull requests. It builds the frontend, compiles every Python file, and runs the tests. It needs no tokens, no Incus and no Claude login.

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): one line, `type(scope): summary`, and exactly one scope per commit. [`CLAUDE.md`](../CLAUDE.md) has the full conventions.
