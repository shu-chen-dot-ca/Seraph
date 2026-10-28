<h1 align="center">Seraph</h1>

<p align="center">
  <b>Agents find open-source work worth doing, fix it in sandbox VMs and prove it.</b><br>
  Nothing reaches GitHub until you approve it.
</p>

<p align="center">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white">
  <img alt="Claude Agent SDK" src="https://img.shields.io/badge/Claude-Agent%20SDK-D97757?logo=anthropic&logoColor=white">
  <img alt="Incus VMs" src="https://img.shields.io/badge/Incus-KVM%20VMs-1f883d">
  <img alt="Human in the loop" src="https://img.shields.io/badge/human-in%20the%20loop-bf8700">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#features">Features</a> ·
  <a href="#safety">Safety</a> ·
  <a href="docs/architecture.md">Architecture</a>
</p>

Seraph is a local workbench for contributing to open source with AI agents, without handing them the keys.

It searches GitHub for projects that fit you and welcome outside contributors, then for issues in them that are worth doing. Agents set each issue up in a sandbox VM, reproduce the bug, fix it, and back the fix with test runs and before-and-after evidence. Every PR, comment and question lands in your **Inbox** as a draft. Nothing goes to GitHub until you approve it: with your GitHub account connected on the GitHub page, Approve opens the PR or posts the comment as you, after you confirm. Without one, you send it yourself.

> **Why a human in the loop?** Maintainers notice drive-by AI pull requests. One agent's note on matplotlib, as it appears in the app: *"AI-generated PRs on good first issues get closed, so you must write the fix yourself."* This tool does the legwork and leaves the judgement, and the name on the PR, to you.

> **Why "Seraph"?** In *The Matrix Reloaded*, Seraph is the program who guards the Oracle and tests everyone who wants to see her. This one tests every fix before it gets to you.

## Features

- **Explore finds the projects.** Tell it about yourself and the kinds of repos you want. It searches GitHub and keeps the repos worth contributing to. It doesn't start from the famous ones: its searches go most recently active first, over mid-size projects (a few hundred to 15k stars unless you say otherwise). It skips any repo where an outside PR would likely go nowhere: most outside PRs closed unmerged, or newcomers' first PRs turned away or left waiting for months. A slow reply alone is fine. The main numbers are what happens to outside PRs: how many get merged, how newcomers fare, the AI policy, and how fast a maintainer replies (bots and AI reviewers don't count). There is no overall score. Claude also tags how well it fits you and how maintainers review. Before it settles how well a repo fits, Claude reads its open issues, the comments on them and its recent outside PRs, with reader agents to go through them in parallel; a repo that clearly doesn't fit from its README gets no closer look. Filters include or exclude any tag. You approve each one into Repos, or remove it from the list (nothing is blocked: a later run may find it again).
- **Add repos by hand.** Paste a repo's GitHub link (or type owner/name) in the box on the Repos page to add it without Explore.
- **Agents that do the research.** They search repos and issues, read threads and code, and check maintainer activity (time to first reply, time to merge, whether an issue is already taken) before recommending anything.
- **Lists with a memory.** Repos, Issues and Tracked lists, each entry with a note on why it was picked. Undo and redo also cover changes the agents made. Issues carry the app's own tags (Free or Assigned, Easy / Medium / Hard, and their kind; an issue someone already posted a fix for, even only in a comment, is Assigned) and live facts from GitHub: assignees, linked PRs, last activity.
- **Tracked repos.** Watch projects you like. Their open issues are checked every few minutes, tagged the same way, and new ones are flagged.
- **Jobs you can follow.** Each job moves through *understand → set up → reproduce → fix → test → draft*, with a plain-words headline of where it stands.
- **Set up any repo.** Set up on the Repos page gives a repo to an agent and a VM. If it has a clear frontend, the agent sets it up the way its README and docs say and leaves it running on the VM's desktop. If it is a library or other low-level project, the agent clones it and opens it in VS Code there. Either way it ends with a short introduction to the repo.
- **Real sandboxes.** Every VM is a full Linux desktop under Incus/KVM, shown live in the browser. Agents use its shell, mouse and keyboard, so they can run GUIs and browsers as well as tests. Each VM has its own internet switch, its own secrets, live CPU/RAM/disk/traffic stats, a two-pane file manager for copying files in and out, and can be saved as an image or forked.
- **Images from one YAML file.** Each image is an `image.yaml`: the system (Ubuntu, Debian or Fedora), the desktop (GNOME, KDE or terminal only), packages, Python, Node, Docker images and build steps. New images start from your Defaults. Builds use official sources only and keep snapshots, so a rebuild only redoes what changed and takes minutes. Check catches mistakes before a build, including Docker images that can't be pulled.
- **A shared VM queue.** VMs aren't tied to repos or agents. Agents line up for them, and you can take a VM over, hand it to an agent, reorder the line, or remove an agent.
- **VM notes.** Each VM keeps notes on what agents set up in it (a project cloned and built, a plugin added for an issue), so the next agent picks the VM that already has its project and knows what was changed. Agents still check the VM's real state before building on it, start from the up-to-date main branch, and leave each other's work alone. You can add notes of your own on the VM's Notes tab.
- **The project's own rules.** Before it sets anything up, the agent gathers the project's rules for contributors wherever they are: CONTRIBUTING in any folder, developer guides in its docs, the PR template, AGENTS.md, and guides the README links to on the project's website. It follows all of them, and writes the PR from those rules and the project's recently merged PRs.
- **Proof before a PR.** Whatever the project's rules ask to run before a PR (or else the tests that cover the change) must pass on the unchanged code and again after the fix, with the same command, however long it takes. A PR draft is refused without before-and-after evidence: real screenshots of the project running, screen recordings, or command runs, never charts or pictures the agent drew. The fix is the agent's own: it never builds on someone else's fix, and no PR credits a co-author.
- **One Inbox for every decision.** A plain-words overview, the evidence side by side, the diff and the PR message. **Approve** (it sends the PR from your GitHub account, once you confirm), **Reply** (the agent applies your feedback and drafts again) or **Reject**. If someone else takes an issue while an agent works on it (the app checks every 5 minutes), the Inbox asks you whether the agent keeps working or stops.
- **Your GitHub in one place.** The GitHub page lists every PR you sent, from the app or by hand, and how it stands in plain words: checks waiting for a maintainer's approval, running, passed or failed; reviews; the latest comment and who wrote it; and whether the issue it fixes is still open. It checks GitHub every few minutes. From there you close or reopen a PR, delete a finished PR's branch from your fork, see and delete the comments the app posted for you, and connect your account. Each of those asks you first.
- **Sherpa, the built-in guide.** The round button at the bottom right of every page. Ask how something works, or ask it to do it: it sees the page you are on and opens pages, clicks and fills in fields while you watch. Its chats are kept.
- **This computer at a glance.** The Resource page shows CPU, memory, GPUs, disk, network and battery, and what each running VM takes.
- **Fast UI.** A Proxmox-style sidebar and one websocket with no polling. Long lists render only the rows on screen. Light and dark themes with an accent color, and env vars for all VMs, live in Settings.
- **Rate limits handled.** GitHub requests are spread over as many tokens as you give it, paced, and retried when a rate limit clears.

## How it works

<p align="center">
  <img src="docs/issue-to-draft.svg" alt="Swimlanes for you, agents, the VM and GitHub: find, assign, queue, work in the VM, draft, decide in the Inbox, then Approve opens the PR from your account" width="100%">
</p>

1. **Find.** Explore finds repos that fit your profile. Agents find good first issues in them ("find easy issues in my Repos") and fill the Issues list, each with a note.
2. **Assign.** You pick an issue, an agent and a VM. That makes a **job**, the smallest unit of work, stored as JSON.
3. **Queue.** The agent lines up for its VM. When the VM is its turn, the agent does all of its jobs there, then releases the VM.
4. **Fix and prove.** In the VM it clones the repo, reproduces the problem, runs the tests before and after the fix, and captures evidence.
5. **Decide.** The draft waits in your Inbox. Reply and the agent keeps working. Approve, confirm, and the PR opens on GitHub from your account: the agent's own commits, with your name, on a new branch in your fork, the pictures uploaded there too.
6. **Follow.** The GitHub page shows how each PR is doing: checks, reviews, comments, and the issue it fixes.

## Quick start

### Requirements

- Linux with KVM and [Incus](https://linuxcontainers.org/incus/) 6+ (developed on Fedora)
- [uv](https://docs.astral.sh/uv/) (Python 3.11+) and Node.js 22+
- A Claude subscription for Claude Code: get a token with `claude setup-token`
- One or more GitHub tokens for searching. Read access to public repos is enough, and tokens from different accounts add up.
- To send PRs from the app: a [classic GitHub token](https://github.com/settings/tokens/new?scopes=public_repo&description=Seraph) with the `public_repo` scope, pasted on the GitHub page (Account). GitHub's fine-grained tokens can't open PRs on projects you don't own.
- Memory and disk: each VM takes 4, 8 or 16 GB of RAM (8 GB is always kept free for the host). An image is 9 to 30 GB depending on what it has, and each VM disk is 30 to 500 GB (48 GB by default).

### 1. Prepare Incus (once)

<details>
<summary>Network, firewall rules and profile for the sandbox VMs</summary>

```bash
# Incus and KVM (Fedora; use your distro's packages elsewhere)
sudo dnf install -y incus incus-agent qemu-kvm edk2-ovmf
sudo systemctl enable --now incus.socket incus.service
sudo usermod -aG incus-admin "$USER"   # then log out and back in

# A storage pool, and a NAT bridge for the VMs
incus storage create default dir
incus network create sandboxbr0 ipv4.address=auto ipv4.nat=true ipv6.address=none

# VMs reach the internet, but not this machine or your local network
incus network acl create sandbox-egress
incus network acl rule add sandbox-egress egress action=reject \
  destination=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,0.0.0.0/8,127.0.0.0/8,224.0.0.0/4,240.0.0.0/4
incus network set sandboxbr0 security.acls=sandbox-egress \
  security.acls.default.egress.action=allow security.acls.default.ingress.action=allow

# The profile every VM starts with
incus profile create sandbox
incus profile device add sandbox root disk path=/ pool=default
incus profile device add sandbox eth0 nic name=eth0 network=sandboxbr0

# With firewalld: let Incus manage the bridge
sudo firewall-cmd --permanent --zone=trusted --change-interface=sandboxbr0 && sudo firewall-cmd --reload
```

</details>

### 2. Configure

```bash
cp .env.example .env
```

Fill in `GITHUB_TOKEN` (plus `GITHUB_TOKEN_2`, `_3`, … if you have more) and `CLAUDE_CODE_OAUTH_TOKEN`. The defaults are fine for everything else.

### 3. Run

```bash
./run.sh
```

Open **http://localhost:5173**. Then:

1. **VMs → Images.** Write your **Defaults** (the packages, languages and tools every new image starts with), then **New image**: pick a system and desktop, and **Build**. A build takes minutes. Make it the default from its menu.
2. **VMs → New VM** (8 GB is a good start).
3. **Explore → Profile.** Say who you are and what kinds of repos you want, then **Start**. Approve the ones you like into Repos.
4. **Agents → New agent**, set its VM, and ask it to find good first issues in your Repos.
5. In **Issues**, press **Assign** on one you like, and watch the job in **Jobs** and on the VM's desktop.
6. **GitHub → Account.** Paste your classic token, so Approve can open PRs as you.
7. Decide on its drafts in the **Inbox**.

Stuck anywhere? Ask Sherpa, the round button at the bottom right.

## Configuration

Everything is set in `.env`; [.env.example](.env.example) lists every option.

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_TOKEN`, `GITHUB_TOKEN_2`, … | | GitHub tokens; requests are spread over all of them |
| `CLAUDE_CODE_OAUTH_TOKEN` | | Claude Code token (`claude setup-token`) |
| `CLAUDE_MODEL` | `claude-opus-5-5[1m]` | The model every agent and Sherpa use |
| `AGENT_CONTEXT_CAP` | `500000` | Tokens a conversation holds before it's compacted |
| `BACKEND_PORT` | `8001` | Backend port (the UI is served by Vite on 5173) |
| `DATA_DIR` | `data` | Where lists, jobs, drafts, agents and VM records are kept |
| `SANDBOX_IMAGE` | `base-image` | Image new VMs start from, until you pick a default in the app |
| `SANDBOX_CPUS_ALLOWED` | `2,4,8,12,16` | CPU counts offered for a VM |
| `SANDBOX_MEMORY_GB_ALLOWED` | `4,8,16` | Memory sizes offered for a VM |
| `SANDBOX_MIN_FREE_RAM_GB` | `8` | RAM always left free for the host |
| `SANDBOX_BUILD_MEMORY` | `8GiB` | Memory of each image build; several build at once while memory allows |

## Safety

<p align="center">
  <img src="docs/trust-boundaries.svg" alt="Trust boundaries: tokens stay on the host, Claude Code has no host tools, VMs can't reach the host or LAN, only what you approve is posted to GitHub" width="100%">
</p>

- **Only what you approve is posted to GitHub.** Agents read GitHub only. A PR or comment is a draft until you approve it and confirm; then the app sends exactly that draft with your own account's token. That token stays on this computer (`data/`): agents, Sherpa and the VMs never get it, and searches don't use it.
- **Agents can't touch your machine.** Each agent is a Claude Code process whose only built-in tool is a todo list. Its other tools run in the backend and act on GitHub (read only), the app's lists, or the VM it holds. Copying files between this computer and a VM is yours alone: agents have no tool for it.
- **Tokens never enter a VM.** VM secrets you set yourself reach commands in that VM, but the agent sees only their names: values show as `[hidden]` in output, and a diff that contains one is refused.
- **VMs are fenced off.** They reach the internet but not this machine or your LAN, and their internet can be turned off. The API answers only pages on localhost.
- **Sherpa is fenced too.** It reads only the app's screens, docs and the descriptions at the top of its Python files, never `data/` or `.env`, and GitHub read-only. It never answers an "are you sure?" pop-up for you, except deleting an image you asked it to delete.

## Architecture

<p align="center">
  <img src="docs/system-overview.svg" alt="System overview: browser, FastAPI backend, Claude Code processes, GitHub, Anthropic and Incus VMs" width="100%">
</p>

[docs/architecture.md](docs/architecture.md) walks through all five diagrams, including the data model and the VM queue.

## Project layout

```text
backend/          FastAPI app: one router per page, and the /api/live websocket
frontend/         React + Vite + Tailwind + shadcn/ui
github_searcher/  lists, Explore, jobs, inbox, sending as your GitHub account, following your PRs, the agents manager, Sherpa, GitHub reads, token balancer
  agent/          one agent: its Claude conversation, system prompt and tools
sandbox/          Incus VMs, the VM queue, images, the agent's VM tools, and this computer's use
  image/          what every image gets (base_layer.sh), and listing what an image has (inspect.sh, inventory.py)
docs/             architecture and diagrams
data/             runtime state, not in git
```

## Development

```bash
uv run serve                          # backend on :8001, reloads on code changes
cd frontend && npm run dev            # UI on :5173
cd frontend && npx tsc -b && npx vite build   # type check and production build
```

Runtime state lives in `data/`. If you delete it, the lists start empty and existing Incus VMs are picked up again.

## Status

An early, single-user project that runs locally. It works end to end on good first issues; reviewing other people's PRs and more job kinds are next.
