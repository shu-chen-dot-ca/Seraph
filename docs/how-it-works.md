# How it works

![From issue to pull request](how-it-works.svg)

1. **Find.** Explore searches GitHub for repos that fit your profile. Tracked repos are checked for new issues every 10 minutes. The agents also search on their own.
2. **Assign.** You give an issue to an agent. It picks a VM, or you pick one for it, and waits in line for a desktop.
3. **Fix in a VM.** Every fix goes through the same steps: *understand → set up → reproduce → fix → test → draft*.
   - The project's own checks pass on the unchanged code first, then on the exact code being drafted.
   - The evidence is real screenshots of the project running.
4. **Review.** A reviewer agent checks every PR draft first, the way the project's maintainers will: every point the issue or a reviewer asked for, and the edge cases of its kind. Only then it lands in the Inbox. It has an **Overview** in plain words, with a **Checklist** of every point asked (what isn't done comes first) and what was **Also tested**, the **Diff**, and the **PR message** written to the project's contributing guide.
5. **Send.** Approve rebuilds the change on your computer, pushes it to a new branch in your fork, and opens the pull request as you.
6. **Follow up.** Every open PR of yours has an agent that owns it, and it hears about every change there: replies, reviews, checks, pushes, conflicts with main, labels, merged or closed. It first reproduces what was reported in a VM, and tests the rest of that kind of mistake too, then drafts the answer, the next version, a rebase or a new title and description, and it comes back to the Inbox. Nothing is posted or pushed until you approve it, unless the repo's [Level of automation](#level-of-automation) lets it go. Such a follow-up comes before the agent's other work, and puts it at the front of the VM's line.

## Judging repos

There is no overall score, only the raw numbers. Bots and AI reviewers never count as maintainers.

![How Explore finds repos](explore.svg)

| Signal | What it measures |
|---|---|
| Outside merge rate | Merged ÷ (merged + closed) for pull requests from outside the project, last 90 days |
| First reply | Median days until a human maintainer answers an outside PR |
| Time to merge | Median days from opening to merge |
| Stale outside PRs | Open over 30 days with no maintainer reply |
| Newcomers | *welcomes*, *ok*, *few*, *left waiting* or *turned away* |
| Active mergers | People who merged PRs in the last 30 days |
| Activity | PRs, issues and commits per month, trend up, down or flat |
| Review tone | *warm*, *neutral*, *strict* or *curt*, and what reviewers ask for |
| AI policy | *welcome*, *disclose*, *no AI*, *unclear* or *none*. *No AI* also covers rules that let AI only help a human author (AI mustn't be the main author, PR descriptions and issues must be human-written): agents never work there, and one that has a job there stops |

## Issue merge

How hard the code is doesn't decide much: the agent writes hard code. What matters is whether the PR gets merged. The agent answers yes or no to six checks about each issue: it belongs in this repo, it can be seen on Linux, it is free of politics, it is open to outside contributors, it is a modest change, and the fix can be proven in a VM. A fixed rule turns those answers, the issue's status, the repo's numbers and your merged PRs there into **Merge**: the first row that holds.

| Merge | Rule |
|---|---|
| **Fixed** | Still open on GitHub, but a merged PR or a commit already does what it asks (the PR said "Addresses #n" instead of "Fixes #n"). It only needs closing. |
| **Out of scope** | It is a plugin or add-on for a third-party product's users, the project wants it as a separate repo, it can only be seen on macOS, Windows, a phone or special hardware (even when its files can be edited on Linux), it is political, or it is about a game. |
| **Claimed** | Someone else is on it: assigned on GitHub, or their open PR says it closes it (one untouched for 30 days counts as abandoned). Catalog never gives these to an agent |
| **Maintainers only** | The maintainers keep it for themselves |
| **Waiting** | It isn't ready to pick up: it needs a decision, a design or more information, or it's a feature request no maintainer has said yes to |
| **No outside PRs** | The repo doesn't merge outsiders' PRs: its AI policy says no AI, most newcomers' first PRs are closed or left waiting, or none of its recent outside PRs was merged |
| **Large feature** | A new subsystem, integration or driver the maintainers would have to keep up |
| **Big change** | Over 200 lines while you have no merged PR in that repo yet |
| **Can't validate** | The agent can't prove the fix works in its VM. Long builds and tests are fine. |
| **Likely** | None of the above |

Agents only pick issues whose Merge is Likely. You can assign the others, except Fixed, Out of scope and Can't validate: a job that can't be proven ends with nothing to show. An agent that finds out mid-job that it can't validate a fix cancels the job itself, without asking.

Every issue is also tagged **free**, **assigned**, **waiting** or **fixed**. An issue with a fix already posted in a comment counts as taken. If an issue gets taken while an agent works on it, the Inbox asks you whether to keep working or stop the agent.

## The Inbox

| Kind | Tabs | Approve |
|---|---|---|
| **PR** | Overview, Diff, PR message | Opens the pull request as you, pushes a new version to one you already opened, or force-pushes a rebase of it |
| **Comment** | Overview, Comment | Posts it as you |
| **Edit** | Overview, Changes, Title and description | Changes the title and description of your own PR or issue |
| **Question** | – | You **Reply**, or pick one of the answers the agent offers |
| **Taken** | – | **Keep working** or **Stop the agent** |
| **Report** | Overview, Results, Problems, Files | Ends a [paper](papers.md) job. Nothing is sent. |

Before you decide, you can edit the text, **Redraft** with a note, or **Discuss** it with the agent. If you approve before signing in, **Send to GitHub** sends it later. **Download .patch** gives you the change as a file instead.

**What Approve sends:**
1. The reviewed diff is applied on your computer, to the project's files read from GitHub. Nothing comes from the VM.
2. The agent's commits are replayed under your name and your noreply email address.
3. Evidence pictures go on a `pr-pictures` branch in your profile repository (github.com/you/you), so they stay when the fork goes.
4. The change is pushed to a new branch in your fork, and the PR is opened from there.

Every issue an agent takes starts with a claim, a short comment that you are taking it on, so nobody else does meanwhile (not when you are already assigned). The claim comes to the Inbox before the PR. When the project's rules ask for a maintainer to assign contributors first, the PR also waits until they assign you on GitHub, after the claim is out; until then Approve says it can't go yet, and with the repo's **Pull requests** automation on it goes by itself once you are assigned.

## Level of automation

The robot on a repo's card (Dashboard, Repository) sets what agents do there without asking you, as you. An issue's own robot on the Issues board changes Questions, Comments and Pull requests for that issue only.

| Setting | What happens without you |
|---|---|
| **Add issues** | The repo's open issues on GitHub whose level is one of its issue levels go to the board's Open, each once: one you take off isn't added again. The board reads each again from fresh as it comes in, and its own rules decide on it |
| **Queue issues** | The repo's issues that fit go to the board's Catalog: their tags were read again recently, after their last change, and they pass the filter (free, merge likely, one of the repo's issue levels, its instructions) |
| **Take issues** | Agents take the repo's issues from Catalog |
| **Questions** | A question with a recommended answer is answered with it at once (money, sensitive, GitHub and delete questions still wait, as Settings say) |
| **Comments** | Comments are posted |
| **Pull requests** | PRs are sent once the reviewer passed them, and new titles and descriptions too. Agents may also update your open PR's branch with its base |
| **Open issues** | Agents may open new issues where the project's rules allow it, claimed for you (assigned, or your comment saying you're on it), never one out of scope (political, a game or the like). Each goes to the top of Catalog, before everything else, and another agent takes it even when **Take issues** is off |

Catalog is worked from the top: while fewer agents work than the board's **Max agents**, the next card of a repo with **Take issues** on goes to a new agent, which picks its VM itself. A send GitHub refuses stays in the Inbox for you.

The board's robot also has **Close inactive PRs after** (14 days at first): an open PR an agent opened for you, with no update on GitHub for that long, is made again by its agent as a fresh PR with a clean history and every review point done. Once the new one is on GitHub, the old one is closed. An agent can do the same for a PR of its own that stalled for other reasons.

Your open PRs sit in two columns on the board. **Needs action** has the ones that need something from us: merge conflicts, a CLA that isn't signed, a draft you approved but didn't send, a reviewer's request we haven't pushed or answered, failing checks our change caused, a real bug a review bot found in the change, a GitHub draft the project waits on. Claude reads each PR again whenever it changes, or when an agent's job on it ends, to catch what the rules can't (a request on the issue it fixes, a description that claims more than the code). What it needs shows in red tags; hover for the details. Nothing there waits on you: each one goes to its agent by itself, which decides what to do (a CLA it can't sign: it checks whether the project merges without it, else closes the PR). Once the agent is done and nothing new happened on the PR, it moves to Waiting approval, so every card in Needs action has an agent on it. **Waiting approval** has the ones waiting for others, tagged **Ready to merge**, **Awaiting CI** or **Awaiting approval**. Both are read again from GitHub every 10 minutes (the board's robot: **Needs action and Waiting approval**). A PR that needs action goes to its agent, ahead of other work: it goes first in the VM's line and gets more of the VM's CPU, like an agent you gave priority. On In progress, Review, Needs action and Waiting approval, a green dot means an agent is working on it now, a yellow one that it waits for action.

Before an agent claims, comments on or takes an issue, it reads all of it: every comment, every place it was mentioned, every related PR with its checks and reviews, and the checks on the default branch. If the issue is already fixed, a duplicate, taken by someone else's PR, or turned down by a maintainer, the agent closes it for us: its job stops and the issue leaves the board for good. Nothing on GitHub changes. Someone else's open PR that closes the issue always counts, whether or not they commented first: the agent can't claim it or start a second fix.

An issue deleted on GitHub leaves the board for good: nothing tags, queues or takes it again. When an issue's repo is deleted from Repos, or its repo turns out to take no AI-made contributions, an agent working on it is told to stop and cancels its job.

**Remove automatically** (the board's robot) applies to Open and Catalog alike, right after new tags come in and every 15 minutes. An issue our agents opened for you stays.

When something goes wrong because of how the app made an agent work (a rule or tool that led it the wrong way, something a maintainer or you had to correct), the agent reports it on the Dashboard's **Problems** page, so you can fix them all at one time. **Close all** moves them to Closed once they are fixed.

Where the repo's Comments or Pull requests setting is on, an agent can also take back what it sent itself: delete its own comment, close its own PR, or drop its newest commits from its own PR.

Once a PR of yours is merged or closed, its branch in your fork is deleted by itself. A fork that nothing uses anymore (no open PR from it, no branch left in it, no job on its project) is deleted too, so your account doesn't fill up with forks; the next PR to that project makes it again. This needs the delete_repo permission: the GitHub tab's Account page asks you to sign in again once.
