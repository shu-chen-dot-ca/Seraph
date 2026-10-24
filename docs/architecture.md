# Architecture

Seraph is a harness for finding and fixing GitHub good first issues, with a human in the loop.
Agents search GitHub, keep the lists and do the hands-on work in sandbox VMs. Nothing reaches GitHub until you send it yourself.

The diagrams are SVG files in this folder and follow your light or dark theme.

## System overview

![The browser talks to a FastAPI backend and opens VM desktops directly; each agent is a Claude Code process whose tools run in the backend, which reads GitHub and drives VMs through Incus.](system-overview.svg)

- **Browser:** the React app gets all its data over one websocket (`/api/live`). Every 250 ms the backend sends only the topics whose version changed, so the page never polls.
- **Backend:** one Python process (`backend/app.py`) owns the stores (`data/*.json`), the agents manager (`github_searcher/agents.py`) and the sandbox managers (`sandbox/`).
- **Agents:** each agent is its own Claude Code process. Its only built-in tool is TodoWrite. Every other tool it calls is served by the in-process MCP server "agent", so those tools run in the backend, not in Claude Code.
- **GitHub:** read only. Every request goes through `token_balancer.py`, which spreads requests over the tokens in `.env` and waits out rate limits.
- **VMs:** Incus VMs on their own bridge. The backend drives them with `incus`; the browser shows each desktop by loading its noVNC page straight from the VM.

## From good first issue to draft PR

![Swimlanes for you, agents, the VM and GitHub: find, assign, queue, work in the VM, draft, decide in the Inbox, then you open the PR yourself.](issue-to-draft.svg)

- A **job** is the smallest unit of work. You make one by assigning an issue or with New job, and an agent can also make its own.
- In the VM, the agent must get the project's full test suite passing **before** it changes anything. It must pass again **after** the change, with the same command.
- `draft_pr` is refused without before/after evidence and both passing test runs.
- **Reply** sends the job back to the agent with your notes. **Reject** tells it to change course or cancel. **Approve** marks it done and sends nothing; you open the PR on GitHub yourself.

## Who holds a VM

![State diagram of one agent and one VM: no VM, waiting in line, holding; agent transitions in grey, your controls in amber.](vm-queue.svg)

- VMs aren't tied to repos or agents. Each one keeps a holder and a line of waiting agents (`sandbox/vm_queue.py`), saved with the VM, so both survive a restart.
- An agent uses VM tools only while it holds its target VM. Once it gets the VM, it does all its jobs there, then releases it.
- When you take a VM away or remove an agent from the line, that agent is interrupted, and every command it started in the VM is killed.

## Data model

![Records and their links: Repo, Issue and Tracked repo lists; Agent, Job and Draft; VM and Image.](data-model.svg)

- The Repos, Issues and Tracked lists have undo/redo, which also undoes changes agents made. GitHub facts about issues and tracked repos are kept in separate files, so undo never brings back old facts.
- Jobs and drafts are never deleted. When an agent is deleted, its open jobs become cancelled.
- Incus is the truth for VMs: an Incus VM without a record gets one again.

## What stays where

![Trust boundaries between your browser, the host, a VM and the internet; green lines are allowed, red crossed lines are blocked.](trust-boundaries.svg)

- The GitHub and Claude tokens stay on the host. They never enter a VM, and the backend only reads GitHub with them.
- A VM's own secrets (set in its Settings tab) reach commands in the VM. The agent sees only their names: any value that shows up in output reads `[hidden]`, and a PR diff that contains one is refused.
- A VM can reach the internet but not this machine or the LAN. The API answers only pages on localhost, so a VM's desktop page gets 403.
