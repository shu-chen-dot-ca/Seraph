# Workflow

The **Workflow** tab develops your own repositories with agents, one small, clearly defined issue at a time. It is separate from **Development** on the Workspace tab: its own repositories, agents, issues and pull requests, on the same VMs.

**Add repository** takes a GitHub link to a repository you can push to. It makes a VM for it with a chat agent, two workers and a review agent.

- **Issues.** Each issue has one goal, its requirements and how to check it is done, so a worker knows what to do and when to stop. The chat agent writes them from what you ask for. You can write one yourself with **New issue**; when you leave out the requirements, its worker writes them down first. Large refactors aren't done here: a request that big becomes several issues.
- **Workers.** A worker takes the next open issue, reproduces it, does exactly that and nothing more, runs the tests before and after, and makes a pull request with before and after pictures. Anything it finds on the way becomes a new issue.
- **Review agent.** It reviews every pull request, the workers' and the ones you open on GitHub. It runs the change, looks at its effect, and advises **Merge** or **Don't merge**, with what you should know.
- **Deciding.** With **Approve and merge** set to **You**, you merge or reject each pull request; the advice is only advice. Set to **Review agent**, its advice is carried out the same way. A rejected pull request goes back to its worker with your reason, unless you close its issue too.

**Pull requests and issues** are **In Seraph** or **On GitHub**, set when you add the repository:

| | In Seraph | On GitHub |
|---|---|---|
| Issues and pull requests | Kept in the app | On GitHub, as you |
| The review | In the app | A comment on the pull request |
| Merge | One commit on the default branch, as you | GitHub's squash merge |

Pull requests you open on GitHub by hand are reviewed either way.
