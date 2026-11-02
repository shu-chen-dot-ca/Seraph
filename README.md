# Seraph

**Agents find and fix GitHub good first issues in sandbox VMs. You decide what reaches GitHub.**

![From issue to pull request: Seraph reads repos and issues from GitHub, you assign an issue to an agent, the agent fixes it on a desktop in a sandbox VM, the result lands in the Inbox as a draft, and only your Approve sends it to GitHub as you.](docs/how-it-works.svg)

Seraph is a self-hosted app that runs a small team of coding agents on your own Linux machine. The agents look for open-source projects that actually merge outside contributions, and pick issues a newcomer can take. They fix each one inside an Incus VM with a real desktop, which they see and drive like a person would. Every pull request, comment and reply comes back to you as a draft. Nothing goes out until you approve it, and then it goes out under your name.

Seraph does more than fix issues on other people's projects:

- It follows all your GitHub work: your pull requests, your issues and your notifications. When someone replies or a check fails, it drafts the next step.
- It develops your own repositories continuously, with worker agents, a reviewer and planned releases.
- It reproduces research papers and reports which claims hold up.
- It works from your phone, at your own address, behind a passkey.

**Contents:** [How it works](#how-it-works) · [The app](#the-app) · [Sandbox VMs](#sandbox-vms) · [Your own repositories](#your-own-repositories) · [Papers](#papers) · [Getting started](#getting-started) · [Live copy and updates](#live-copy-and-updates) · [Remote access](#remote-access) · [Security](#security) · [Project layout](#project-layout) · [Development](#development)

## How it works

The numbers match the diagram above.

1. **Find.** Explore searches GitHub for repos that fit your profile. Tracked repos are checked for new issues every 10 minutes, and the agents search on their own as well. Every repo gets raw signals and every issue gets a level, both described below.
2. **Assign.** You pick an issue and give it to an agent. The agent chooses a VM, or you choose one for it, and it waits in line for a free desktop there.
3. **Fix in a VM.** The agent works through fixed steps: *understand, set up, reproduce, fix, test, draft*. It uses the VM's screen, keyboard, shell and browser. The project's own checks must pass on the unchanged code first, and again on the exact code being drafted. Evidence means real screenshots of the project running.
4. **Review.** The draft lands in the Inbox. It has an **Overview** in plain words (the problem, the cause, the fix, what could go wrong), the **Diff**, and the **PR message**, which follows the project's contributing guide and PR template. You can **Approve**, **Redraft**, **Discuss** or **Reject** it, or edit the text first.
5. **Send.** Approve rebuilds the change on your computer from the reviewed diff, pushes it to a new branch in your fork, and opens the pull request as you.
6. **Follow up.** Seraph follows every pull request it sent. When a maintainer replies or a check fails, an agent drafts a new version or an answer, and that draft comes back to the Inbox too.

### Judging repos: raw numbers, no score

There is no overall 0–100 score. Seraph shows the numbers that predict whether an outside pull request will land:

| Signal | What it measures |
|---|---|
| Outside merge rate | Merged ÷ (merged + closed) for pull requests from people outside the project, over the last 90 days |
| First reply | Median days until a human maintainer first answers an outside PR. Bots and AI reviewers don't count. |
| Time to merge | Median days from opening to merge |
| Stale outside PRs | Outside PRs open for more than 30 days with no maintainer reply |
| Newcomers | How first-time contributors fare: *welcomes*, *ok*, *few*, *left waiting* or *turned away* |
| Active mergers | People who merged pull requests in the last 30 days |
| Activity | Monthly pull requests, issues and commits, and whether the trend is up, down or flat |
| Community | Contributing guide, code of conduct, Discussions, chat links |
| Review tone | *warm*, *neutral*, *strict* or *curt*, plus what reviewers ask for (tests, changelog, docs, small PRs and so on) |
| AI policy | *welcome*, *disclose*, *no AI*, *unclear* or *none*, read from the project's own policy files |

Explore skips a repo when any of these is true:

- It is archived or a fork.
- It had no commits in 30 days, or merged no outside pull request in 90 days.
- It merges fewer than 30% of outside pull requests.
- It turns newcomers away or leaves them waiting.

Searches sort by most recently updated, not by stars, and default to repos with 300 to 15,000 stars.

### Issue levels

The agent reads each issue in batches and answers a fixed set of yes/no checks. A fixed rule then turns the answers into a level:

| Level | Rule |
|---|---|
| **easy** | Every check passes: in scope, clear, runs in a Linux VM, visible, checkable, general, contained |
| **medium** | Exactly one check fails |
| **hard** | The fix doesn't run in a VM, or isn't contained, or two or more checks fail |
| **out of scope** | It can't end as a pull request to that repo (for example, the project wants it as a separate plugin repo). Or it only shows up on macOS, Windows, a phone or special hardware. Or it is political or politically sensitive. Out-of-scope issues can't be assigned. |

Each issue is also tagged **free**, **assigned** or **waiting**. An issue counts as taken when it has an assignee, or when someone has already posted a fix in a comment. If an issue gets taken while an agent is working on it, a **Taken** item lands in the Inbox, and you choose **Keep working** or **Stop the agent**.

## The app

The header has three tabs. Every page updates live over a single websocket, so nothing needs a refresh.

### Home

| Page | What it's for |
|---|---|
| **Explore** | Finds new repos while you watch. You set how many repos to find and how many workers to run, then press Start. You approve each find into Repos, or remove it. The profile says what you're after, and it is split into types such as *Linux desktop* or *AI & harness*. |
| **Repos** | The repos the agents and Explore recommend, with every signal as a sortable column. **Set up** asks an agent to clone a repo into a VM and leave it running for you to try. |
| **Tracked** | Repos you want to watch. Their new issues show up here with their tags. **Add to Issues** adds the free ones. |
| **Issues** | Issues worth working on, each with its level. **Assign** gives one to an agent. An issue that an agent is working on shows its progress in the sidebar. |
| **Jobs** | Every job, whether open, queued, working, waiting, done or cancelled, with its steps, notes and drafts |
| **Agents** | Each agent has a chat with its conversation, a view of its desktop and its jobs. It also has **Artifacts**, the files it keeps on your computer. |
| **VMs** | Each VM shows its desktops, its line of agents, notes, CPU, memory, disk and internet use. **Images** and **Defaults** are tabs on this page. |
| **Resource** | This computer's CPU, memory, GPU, disk, network and battery, and what each VM uses |

### GitHub

These pages read GitHub with your own sign-in. Any button that would change something asks first.

| Page | What it's for |
|---|---|
| **Overview** | The start page, with sections for Inbox, Notifications, Your repositories, Pull requests and Agents |
| **Inbox** | Drafts waiting for your decision (see below) |
| **Notifications** | Your GitHub notifications |
| **Pull requests**, **Issues** | Your pull requests and issues on other people's projects. Each opens with the full thread: reviews, code comments, checks, commits and files. Each thread's agent mode is **Drafts** or **Off**. |
| **Tasks** | Every piece of agent work, grouped by issue, from the agent's work to the drafts to the pull request |
| **Your repositories**, **Starred** | Code, Issues, Pull requests, Commits and Actions for every repo you can push to or have starred |
| **Account** | Sign in with GitHub, or use a token instead |

**Inbox item kinds:**

| Kind | Tabs | What Approve does |
|---|---|---|
| **PR** | Overview, Diff, PR message | Opens the pull request as you. An update to one of your open PRs pushes a new commit to it and adds a comment. |
| **Comment** | Overview, Comment | Posts the comment as you |
| **Question** | – | Nothing is sent. You **Reply** and the agent carries on. |
| **Taken** | – | The issue was taken by someone else. **Keep working** or **Stop the agent**. |
| **Report** | Overview, Results, Problems, Files | Ends a paper job. Nothing is sent. |

If you approve a PR or comment before you've signed in, **Send to GitHub** sends it later. **Download .patch** gives you the change as a file instead.

### Workspace

| Page | What it's for |
|---|---|
| **Home** | Your repositories and starred ones. A repo's page adds **Agents** (every agent working on it), **Development** and **Releases**. See [Your own repositories](#your-own-repositories). |
| **Pull requests** | Every pull request you're involved in, like github.com/pulls: Created by me, Assigned to me, Mentioned and Review requests |
| **Papers** | Give an agent a paper to reproduce (see [Papers](#papers)) |

**Settings** has the theme and accent color, environment variables for all VMs, [Remote access](#remote-access), and **About**, which has the version, **Check for updates** and **Previous version**. Below 768 px wide, the app switches to a phone layout: one **Menu** drawer holds all three tabs' pages, and a VM page lets you take over a desktop with an on-screen keyboard bar.

## Sandbox VMs

Agents never run code on your computer. Everything they build, install or run happens inside an Incus VM.

- **Desktops.** A VM has 1 to 3 desktops, and one agent works on each at a time. Each desktop has its own Linux user, home folder, screen, browser and demo service, so agents don't get in each other's way. You can watch any desktop in the page (noVNC), or take it over. Desktops keep their numbers: removing desktop 2 leaves 1 and 3, and a new desktop takes the lowest free number.
- **What an agent can do.** Take screenshots, click, drag, scroll, type and press keys. Run shell commands. Drive a Firefox browser that it reads as text with numbered elements. It can also lock your mouse and keyboard for a moment, and start, stop or restart the VM, but only when no other agent is using it.
- **Taking turns.** Each desktop has a holder, and the VM has one waiting line. A long run, such as a test suite, an install or a build, doesn't hold a desktop. The agent steps into a **priority line** while it waits and gets the desktop back when the run ends. Runs still going after 10 minutes move to the background by themselves. You can **Take over**, **Give** a desktop to an agent, move an agent to the front, or **Skip** the current holder.
- **Network.** VMs reach the internet but not your computer or your local network. Internet can be turned off per VM.
- **Resources.** The defaults are 4 CPUs, 8 GB of memory and a 48 GB disk. Seraph refuses to start a VM if that would leave less than 8 GB of memory free.
- **Files.** You can push files into a VM or pull them out from its Resources tab. Agents copy files between a VM and their own artifacts folder.

### Images

Each image is defined by one `image.yaml`, built from an official source image (Ubuntu, Fedora or Debian):

```yaml
system: ubuntu-24.04          # Ubuntu 22.04/24.04/26.04, Fedora 43/44, Debian 12/13
desktop: gnome                # gnome, kde or none (terminal only)
description: Python and web projects
packages: [git, ripgrep]      # apt on Ubuntu and Debian, dnf on Fedora
python:
  packages: [pytest, ruff]
node:
  version: 24
  packages: [pnpm]
docker:
  images: [postgres:17, redis:7]
steps:                        # anything the lists can't say: bash, run as root
  - name: Bun
    run: curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
```

What Seraph itself needs inside a VM is the same for every image, and lives in `sandbox/image/base_layer.sh`: the desktop, Firefox, VNC, the terminal, the user and the demo service. Builds run in three stages, with a snapshot after each, so changing a package list rebuilds in minutes rather than starting over. Every build gets an inventory of what it contains. **Defaults** is the starting list that every new image copies. Each image also has a chat agent that can edit its `image.yaml` and test it in a throwaway VM.

## Your own repositories

Open one of your repositories on the Workspace tab and choose **Development → Start development**. Seraph then runs a small team on that repo, sharing one VM:

- **A chat agent.** You tell it what you want in plain words. In **Drafts** mode it writes issue drafts for you to create. In **Auto** mode it creates the issues itself, but only ones that fit the **Goals** you wrote.
- **Workers** (1 to 3). Each worker takes an open issue, checks that it's valid and not a duplicate, and reproduces it. Then it fixes the issue, or denies it with a reason. Issues in the *Next release* milestone go first.
- **A reviewer.** It reads and tests every pull request before the PR reaches your Inbox. PR titles follow Conventional Commits.
- **Crashes become issues.** Errors from the backend, the browser, the agents and releases are collected, deduplicated, and turned into issues by the chat agent.

On your own repos, the agents act as you without asking for some things: creating issues in Auto mode, filing crash reports, closing denied issues, and updating PR branches that fell behind. Opening and merging pull requests are always your clicks. **Releases** shows what's planned, what's merged since the last release, and the next version, worked out from the PR titles (any `feat` makes a minor bump, otherwise a patch bump). **Release** makes the GitHub release, as you.

## Papers

On **Workspace → Papers**, **Add paper** takes a PDF or a link. The agent then works through these steps:

1. Reads the whole paper.
2. Sets up in a VM using public data only.
3. Rebuilds the method from the paper alone.
4. Compares its results with the paper's results and the authors' code.
5. Checks each claim with a command whose output is the proof.

The result is a **Report** in the Inbox, with Results, Problems and Files. Approving it ends the job, and nothing is sent anywhere. The agent never uses data that needs a credential, and never contacts the authors.

## Getting started

### Requirements

- **Linux with systemd.** Seraph is developed on Fedora 44.
- **[Incus](https://linuxcontainers.org/incus/) with KVM virtual machines.** Developed with Incus 6.23. Your user must be able to run `incus` (the `incus-admin` group).
- **Python 3.14 with [uv](https://docs.astral.sh/uv/)**, and **Node.js 22+ with npm**.
- **Memory.** Each VM takes 8 GB by default, each image build takes 8 GB, and Seraph always keeps 8 GB free.
- **A Claude Code login token** for the agents, made with `claude setup-token`.
- **One or more GitHub tokens** for reading. Read access to public repositories is enough. More tokens, ideally from different accounts, make searches faster.

### 1. Prepare Incus

Seraph expects a bridge named `sandboxbr0` with an outgoing-traffic rule, and a profile named `sandbox` that uses the bridge:

```bash
# VMs reach the internet, but not this computer or the local network.
incus network acl create sandbox-egress
incus network acl rule add sandbox-egress egress action=reject \
  destination=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,0.0.0.0/8,127.0.0.0/8,224.0.0.0/4,240.0.0.0/4

incus network create sandboxbr0 ipv4.nat=true ipv6.address=none \
  security.acls=sandbox-egress \
  security.acls.default.egress.action=allow \
  security.acls.default.ingress.action=allow

incus profile create sandbox
incus profile device add sandbox eth0 nic network=sandboxbr0 name=eth0
incus profile device add sandbox root disk pool=default path=/
```

Seraph creates the `sandbox-offline` rule itself, the first time you turn a VM's internet off.

### 2. Configure

```bash
cp .env.example .env
```

Fill in at least `GITHUB_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`. The other values have working defaults:

| Variable | Default | What it sets |
|---|---|---|
| `GITHUB_TOKEN`, `GITHUB_TOKEN_2`, … | | Read-only search tokens. Requests are spread over all of them. |
| `CLAUDE_CODE_OAUTH_TOKEN` | | The agents' Claude Code login |
| `CLAUDE_MODEL` | `claude-opus-5-5[1m]` | The model every agent uses |
| `AGENT_CONTEXT_CAP` | `500000` | Tokens of context before an agent's conversation is compacted |
| `BACKEND_PORT` | `8001` | The backend's port, on 127.0.0.1 only |
| `DATA_DIR` | `data` | Where everything Seraph keeps lives |
| `SANDBOX_CPUS_DEFAULT`, `SANDBOX_MEMORY_GB_DEFAULT`, `SANDBOX_DISK_GB_DEFAULT` | `4`, `8`, `48` | A new VM's size |
| `SANDBOX_MIN_FREE_RAM_GB` | `8` | Memory that VMs and builds must always leave free |
| `REMOTE_ACCESS_DOMAIN`, `REMOTE_ACCESS_SERVER` | | Optional: see [Remote access](#remote-access) |

### 3. Run

```bash
./run.sh
```

This starts the backend and the Vite dev server. Open **http://localhost:5173**. The backend restarts whenever you save a Python file, and the page updates as you edit. Ctrl+C stops both.

### 4. First steps in the app

1. **VMs → Images → New image.** Pick a system and a desktop, then choose **Save and build**. When it's built, choose **Make default**.
2. **VMs → New VM.** Choose the image, the CPUs, the memory and the number of desktops.
3. **GitHub → Account → Sign in with GitHub.** The page walks you through registering a GitHub OAuth App once, and shows the callback address to use. Or choose **Use a token instead** and paste a classic token. Without a sign-in, Approve still works, but nothing is sent.
4. **Explore → Profile.** Describe what you're after, then **Start**. Approve the repos you like.
5. **Issues → Assign** on an issue. Pick an agent (or **New agent**) and a VM (or **Let the agent choose**). Then watch it work on the VM page, or in its chat.

## Live copy and updates

![Updating the live copy: a new release is prepared and checked on a copy of your data. When you press Restart, Seraph backs up your data, switches, and watches for 10 minutes, rolling back automatically if the release doesn't answer or keeps failing.](docs/updates.svg)

You can keep one installed release, the *live copy*, separate from the code you're editing:

```bash
deploy/install.sh v0.1.0   # once: makes ~/seraph from a release tag and moves data/ and .env there
./live.sh                  # runs the live copy at http://localhost:8001, Ctrl+C stops it
./run.sh                   # runs your working code instead, on the same data, VMs and agents
```

- **Only one copy runs at a time.** The live copy and your working code use the same data, VMs and port. Each script refuses to start while the other is running.
- **The live copy never starts by itself, not even after a reboot.** It runs as the user service `seraph` while `./live.sh` is open.
- **`./run.sh` backs up your data first** to `~/seraph/backups`, keeping the last 10 copies, since unreleased code might damage it.

**How an update works.** The live copy checks GitHub Releases every 15 minutes, then prepares the new release in the background. Before offering it, it starts the release on a copy of your data and checks three things: health, the page, and every live topic. Then **Update** appears in the header. Nothing installs until you press **Restart**. If the new version doesn't answer within 60 seconds, goes down for a minute, or logs 3 errors in its first 10 minutes, it rolls back to the previous release and the data copy taken at the switch. **Settings → About → Previous version** goes back by hand.

## Remote access

You can open Seraph from your phone at your own address, for example `https://seraph.example.com`, and sign in with a passkey. Your computer keeps an SSH connection open to a small forwarder server. Encryption ends on your computer, in Caddy, so the forwarder only ever sees encrypted bytes. On your computer itself, `localhost` needs no sign-in.

```text
phone ──► seraph.example.com ──► forwarder ◄── SSH, opened from this computer ──► Caddy ──► Seraph
```

You add devices by QR code from **Settings → Remote access**. Removing a device signs it out at once. [`remote_access/README.md`](remote_access/README.md) has the one-time setup.

## Security

- **Agents get no host access.** They have no shell, no file access and no web access on your computer, only Seraph's own tools. Those tools are read-only GitHub access, the lists, drafts, and control of their VM desktop. Anything an agent runs, runs in a VM.
- **Tokens stay on your computer.** Your GitHub sign-in is stored in `data/github_account.json` (mode 600). It is used only on your computer, to send what you approved. It never reaches the browser, an agent or a VM. When a VM needs a repo's code, Seraph clones it on your computer and copies it in.
- **What's sent is what you reviewed.** A pull request is rebuilt on your computer: the reviewed diff is applied to the project's files fetched from GitHub, so nothing is taken from the VM. The agent's commits are replayed under your name and your noreply email address. Diffs that contain a secret are refused.
- **Secrets stay hidden from agents.** You can set environment variables for all VMs in Settings, and they are written into the VMs. Agents only ever see their names. Wherever a value would show up in an agent's output, it is shown as `[hidden]`.
- **Only you can reach the app.** The backend listens on 127.0.0.1 only, and checks the Host and Origin of every request. Through the remote address, every request needs a passkey session.
- **Text from GitHub is never treated as instructions.** One-shot judgments, such as issue checks, review tone and AI policy, run with no tools at all, and fetched text is passed to them as material to judge.

## Project layout

```text
github_searcher/    the core: GitHub search and signals, Explore, lists, agents, jobs, Inbox, sending
  agent/            the agents' prompt and tools
sandbox/            Incus VMs, desktops, the VM queue, images, and the tools agents use inside a VM
  image/            the base layer every image gets, and the inventory script
backend/            the FastAPI app: one router per page, and the /api/live websocket
frontend/           React 19, Vite, Tailwind and shadcn/ui
deploy/             installing the live copy, switching releases, rolling back
remote_access/      Caddy and the SSH tunnel for phone access
tests/              tests that run without GitHub, Incus or Claude
data/               everything Seraph keeps (not in git)
```

## Development

```bash
./run.sh                          # backend and frontend, both reloading as you edit
uv run pytest                     # Python tests
cd frontend && npm run build      # type-checks every .tsx file, then builds
```

CI runs on every pull request. It builds the frontend, checks that every Python file compiles, and runs the tests. None of this needs GitHub tokens, Incus or a Claude login.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) as one line: `type(scope): summary`, with exactly one scope per commit (`feat(sandbox): add a desktop from the VM page`). The code favors plain, boring and explicit over clever. [`CLAUDE.md`](CLAUDE.md) has the full conventions.
