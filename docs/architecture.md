# Architecture

Seraph is a harness for finding and fixing GitHub good first issues, with a human in the loop.
Agents search GitHub, keep the lists and do the hands-on work in sandbox VMs. Nothing reaches GitHub until you approve it.

The diagrams are SVG files in this folder and follow your light or dark theme.

## System overview

![The browser talks to a FastAPI backend and opens VM desktops directly; each agent is a Claude Code process whose tools run in the backend, which reads GitHub and drives VMs through Incus.](system-overview.svg)

- **Browser:** the React app gets all its data over one websocket (`/api/live`). Every 250 ms the backend sends only the topics whose version changed, so the page never polls.
- **Backend:** one Python process (`backend/app.py`) owns the stores (`data/*.json`), the agents manager (`github_searcher/agents.py`) and the sandbox managers (`sandbox/`).
- **Agents:** each agent is its own Claude Code process. Its only built-in tool is TodoWrite. Every other tool it calls is served by the in-process MCP server "agent", so those tools run in the backend, not in Claude Code.
- **GitHub:** agents and searches only read. Every such request goes through `token_balancer.py`, which spreads requests over the tokens in `.env` and waits out rate limits. The one writer is Approve in the Inbox: it sends a PR or comment with your own account's token (`github_searcher/github_account.py`, set on the GitHub page), never the search tokens. The GitHub page's buttons (close or reopen a PR, delete its branch from your fork, delete a comment the app posted) use it too, each after an "are you sure?".
- **VMs:** Incus VMs on their own bridge. The backend drives them with `incus`; the browser shows each desktop by loading its noVNC page straight from the VM. The agent page's view-only Desktop connects to the same VNC websocket with noVNC's client library, so it shows only the screen.

## From good first issue to draft PR

![Swimlanes for you, agents, the VM and GitHub: find, assign, queue, work in the VM, draft, decide in the Inbox, then Approve opens the PR from your account.](issue-to-draft.svg)

- A **job** is the smallest unit of work. You make one by assigning an issue, with Set up on the Repos page, or with New job, and an agent can also make its own.
- **Set up** (`set_up_repo`: understand → set up → show → introduce) has no fix and no draft. The agent reads the README and docs. An app with a clear frontend it sets up and leaves running on the VM's desktop; a server goes in the VM's demo service, so it keeps running after the agent lets go of the VM and after a restart. A library or other low-level repo it clones and opens in VS Code. Then it writes a short introduction to the repo, in its chat and in the job's notes.
- First the agent reads the project's rules for contributors (`contributing_guide`): every CONTRIBUTING file in any folder, developer guides in the docs, the PR template, AGENTS.md, and the guides the README and CONTRIBUTING link to, in the repo or on the project's website. `run_tests` and `draft_pr` refuse until it has.
- In the VM, it runs whatever the project's rules ask to run before a PR (its official checks), however long they take, or else the tests that cover the change (the basic checks). They must pass **before** it changes anything and again **after** the change, with the same command. The job and the Inbox say which ran.
- A project already set up in the VM isn't set up again: a passing full-suite run from an earlier job on the same repo and VM counts for the next one.
- `draft_pr` is refused without before/after evidence and both passing test runs.
- Evidence pictures are real screenshots of the project running on the VM's desktop (its window, or a terminal running it) and screen recordings; never charts or images the agent drew (`evidence_add` refuses matplotlib images).
- A PR is written from the project's rules and its recently merged PRs: the agent must read its main contributors' latest merged PRs first (`pr_examples`). No draft has emoji. Every commit is the agent's own: `draft_pr` refuses a branch with anyone else's commits or a Co-authored-by line. The before/after screenshots go in the PR body; the Inbox shows them in place. Sending uploads them to your fork's `pr-pictures` branch and links them there (Copy picture and Download are for sending by hand).
- What the agent does in the VM is meant to be watched: it runs the app on the desktop where it can, and test runs and other long commands show live in a terminal window there.
- **Reply** sends the job back to the agent with your notes. **Reject** tells it to change course or cancel. **Approve** marks it done. With your GitHub account connected, it first asks "are you sure?", then opens the PR as you: the agent's commits replayed on the commit it started from (their messages, all with your name), on a new branch in your fork, into the branch the agent started from. What goes out ends at exactly the diff you reviewed, rebuilt on the host from GitHub's copy of the files, never read from the VM again; anything uncommitted goes in one last commit. The draft keeps what was sent (`sent`: the PR's link, number, fork, branch and commit). Without an account, Approve sends nothing and you open the PR yourself.
- The **GitHub** page follows every PR you sent, from the app or by hand (`github_searcher/pr_tracking.py`, read with the search tokens every few minutes and right after a send): its state, its checks (including runs that wait for a maintainer to approve them, as GitHub does for a first-time contributor), reviews, the latest comment, and the issues it fixes.
- If an issue an agent has a job for goes from free to assigned (someone else is on it now), the app puts a **Taken** item in the Inbox: **Keep working** lets the agent go on, **Stop the agent** cancels the job and stops it right away. The agent never stops for it on its own.

## Who holds a VM

![State diagram of one agent and one VM: no VM, waiting in line, holding; agent transitions in grey, your controls in amber.](vm-queue.svg)

- VMs aren't tied to repos or agents. Each one keeps a holder and a line of waiting agents (`sandbox/vm_queue.py`), saved with the VM, so both survive a restart.
- Each VM also keeps notes on what is set up in it (`sandbox/vms.py`), written by the agent holding it and by you. Agents see them when they pick a VM and again when it becomes theirs; a fork starts with its source's notes.
- An agent uses VM tools only while it holds its target VM. Once it gets the VM, it does all its jobs there, then releases it.
- When you take a VM away or remove an agent from the line, that agent is interrupted, and every command it started in the VM is killed.

## Data model

![Records and their links: Repo, Issue and Tracked repo lists; Agent, Job and Draft; VM and Image.](data-model.svg)

- The Repos, Issues and Tracked lists have undo/redo, which also undoes changes agents made. GitHub facts about issues and tracked repos are kept in separate files, so undo never brings back old facts.
- Jobs are never deleted. When an agent is deleted, its open jobs become cancelled. Drafts stay in the Inbox until you delete them, and only decided ones can be deleted.
- How each of your PRs stands is kept in its own file (`data/pr_tracking.json`), linked to the draft it was sent from.
- Incus is the truth for VMs: an Incus VM without a record gets one again.

## What stays where

![Trust boundaries between your browser, the host, a VM and the internet; green lines are allowed, red crossed lines are blocked.](trust-boundaries.svg)

- The GitHub and Claude tokens stay on the host. They never enter a VM. The backend only reads GitHub with the search tokens; your account's token (`data/github_account.json`, readable by you only) only sends what you approve, and the browser, agents and Sherpa never get it.
- A VM's own secrets (set in its Settings tab) reach commands in the VM. The agent sees only their names: any value that shows up in output reads `[hidden]`, and a PR diff that contains one is refused.
- A VM can reach the internet but not this machine or the LAN. The API answers only pages on localhost, so a VM's desktop page gets 403.
