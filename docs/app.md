# The app

![The app](app-map.svg)

The left list (a row of tabs at the bottom on a phone) has what waits for you first, then your projects, then the agents and the machines. Every button that changes something asks first. **Go to** in the top bar jumps to any issue, project, agent or VM by name or number, and **New** starts anything: **Fix an issue**, **New issue**, **New task** or **Ask an agent**.

## What waits for you

| Page | |
|---|---|
| **Inbox** | Two tabs. **Questions**: an agent asked you something. Some have a timer, after which the agent goes ahead with the choice it recommends; the rest wait for you. **Approvals**: things to send or merge. Each starts with what the agent needs in plain words, then what was checked, with screenshots; the diff and exact text are under **Details**. Select several to approve or reject them at once. See [the Inbox](how-it-works.md#the-inbox). |
| **Notifications** | GitHub's own notifications. Each opens the issue it belongs to. |

## Projects

A project is a repository you work on: **Private** (yours, which agents develop one issue at a time: see [Workflow](workflow.md)) or **Open source** (someone else's, where agents fix issues and you send the pull requests). **Add or find projects** adds one by its link, or opens **Find**, where agents look for good open-source projects.

| Part | |
|---|---|
| **Board** | Every issue of the project from open to done: **Open** (nobody on it yet: **Assign** gives it to an agent), **In progress**, **In review**, **Approval**, **Sent** (open source) and **Done**. **Find issues** puts free issues from GitHub in Open; **New issue** writes one for a private project. |
| **An issue's page** | Its whole story on one timeline: who did what and when, with the proof, from the issue to merged. What it waits on you for is at the top; **Message** opens its agent's chat, **Stop** cancels the work. |
| **Agents**, **Settings** | Every agent that worked on the project; a private project's switches (take new issues, workers, where pull requests live, who merges), or whether an open-source one is watched for new issues. |

## Team and machines

| Page | |
|---|---|
| **Team** | Each agent, what it works on and where. Opening one shows its chat, its job, its place in a VM's line and its **Artifacts** (files it keeps). |
| **Machines** | Each VM's desktops, line of agents, notes and usage. **Images** and **Defaults** are tabs here. A VM's page lets you take over a desktop. |

## Settings and phone

- **Settings** (your picture, top right) holds your GitHub account (**Sign in with GitHub**, or a token), **When agents ask you** (what always waits for you, and the timer for the rest), the theme and accent color, environment variables for all VMs, this computer's usage, [remote access](../remote_access/README.md), and **About**, which has **Check for updates** and **Previous version**.
- **On a phone.** Below 768 px wide, the left list is a row of tabs at the bottom, with one **Projects** tab for all projects. A VM page lets you take over a desktop, with an on-screen bar for Esc, Ctrl, Alt, Tab and the arrow keys.

## Sherpa

The round button at the bottom right of every page opens **Sherpa**, a chat that does things in the app for you, many at once: "remove every issue opened more than 30 days ago" is one message instead of thirty clicks. It reads what the pages show and uses the same actions as the buttons, so list changes can be undone as usual. It never sends anything to GitHub (Approve, comments and PR actions stay yours), never touches your sign-in, remote access, updates or secrets, and asks in the chat before something that can't be undone.
