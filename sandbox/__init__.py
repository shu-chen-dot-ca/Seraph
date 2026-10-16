"""Set up a GitHub repo in a sandbox VM, so you can try a demo of it and develop it in the browser.

Separate from the search (github_searcher/): it only needs a repo name.

Layers, from the bottom up:
    config.py         settings from .env
    models.py         Sandbox and SandboxEvent, shared with the backend and frontend
    incus.py          the `incus` command line (VMs, commands, state), nothing sandbox-specific
    vm.py             one sandbox VM: commands and files as `dev`, the demo service, page checks
    setup_tools.py    the setup agent's tools, each acting inside its VM only
    setup_agent.py    the setup agent: prompt, SDK options (no built-in tools), messages -> log
    store.py          sandbox records and activity logs on disk
    manager.py        lifecycle: create -> boot -> clone -> agent -> ready; messages, stop, start, delete
    preview.py        reverse proxy from <port>-<sandbox>.localhost to the VM (HTTP + WebSocket)

Host setup (once): setup_host.sh. The base image: image/build.sh.
The HTTP API is in backend/app.py and the React pages in frontend/src/sandbox/.
"""
