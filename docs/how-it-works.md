# How it works

![From issue to pull request](how-it-works.svg)

1. **Find.** Explore searches GitHub for repos that fit your profile. Tracked repos are checked for new issues every 10 minutes. The agents also search on their own.
2. **Assign.** You give an issue to an agent. It picks a VM, or you pick one for it, and waits in line for a desktop.
3. **Fix in a VM.** Every fix goes through the same steps: *understand → set up → reproduce → fix → test → draft*.
   - The project's own checks pass on the unchanged code first, then on the exact code being drafted.
   - The evidence is real screenshots of the project running.
4. **Review.** The draft lands in the Inbox. It has an **Overview** in plain words, the **Diff**, and the **PR message** written to the project's contributing guide.
5. **Send.** Approve rebuilds the change on your computer, pushes it to a new branch in your fork, and opens the pull request as you.
6. **Follow up.** When someone replies or a check fails, an agent drafts the next version, and it comes back to the Inbox.

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
| AI policy | *welcome*, *disclose*, *no AI*, *unclear* or *none* |

## Issue levels

The agent answers yes or no to a fixed set of checks: in scope, clear, runs in a VM, visible, checkable, general, contained. A fixed rule turns the answers into a level:

| Level | Rule |
|---|---|
| **easy** | Every check passes |
| **medium** | One check fails |
| **hard** | It doesn't run in a VM, or isn't contained, or two or more checks fail |
| **out of scope** | The project wants it as a separate repo, it only shows up on macOS, Windows, a phone or special hardware, or it is political. It can't be assigned. |

Every issue is also tagged **free**, **assigned** or **waiting**. An issue with a fix already posted in a comment counts as taken. If an issue gets taken while an agent works on it, the Inbox asks you whether to keep working or stop the agent.

## The Inbox

| Kind | Tabs | Approve |
|---|---|---|
| **PR** | Overview, Diff, PR message | Opens the pull request as you, or pushes a new version to one you already opened |
| **Comment** | Overview, Comment | Posts it as you |
| **Question** | – | You **Reply** instead |
| **Taken** | – | **Keep working** or **Stop the agent** |
| **Report** | Overview, Results, Problems, Files | Ends a [paper](papers.md) job. Nothing is sent. |

Before you decide, you can edit the text, **Redraft** with a note, or **Discuss** it with the agent. If you approve before signing in, **Send to GitHub** sends it later. **Download .patch** gives you the change as a file instead.

**What Approve sends:**
1. The reviewed diff is applied on your computer, to the project's files read from GitHub. Nothing comes from the VM.
2. The agent's commits are replayed under your name and your noreply email address.
3. Evidence pictures go on a `pr-pictures` branch in your fork.
4. The change is pushed to a new branch in your fork, and the PR is opened from there.
