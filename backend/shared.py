"""The app's single instances, made once when the backend imports this module.

Every router imports what it needs from here, so all of them work on the same
lists (and the facts, difficulty and signals about their issues and repos), the Tracked list (and its repos' issues),
Explore, jobs, inbox, your GitHub account (which sends what you approve in the Inbox), your PRs and issues on GitHub
and how each stands, with the agent that follows each (the GitHub tab), your repositories (read with your sign-in),
VMs, their
images (and the images' agents), VM queue, the agents' artifacts, agents, Sherpa and this computer's use (the Resource page). The order matters: the Issues list asks jobs which issues an agent
is working on (those can't be removed), the queue
keeps its state on the VM records, and Agents needs everything else (it also
sets the queue's on_grant / on_kick callbacks). Agents only starts its worker
tasks in the app's lifespan (backend/app.py), because they need the running
event loop.
"""

from github_searcher.agents import Agents
from github_searcher.artifacts import Artifacts
from github_searcher.explore import Explore
from github_searcher.github_account import GithubAccount
from github_searcher.sherpa import Sherpa
from github_searcher.inbox import Inbox
from github_searcher.issue_tags import IssueTags
from github_searcher.issue_facts import IssueFacts
from github_searcher.issue_list import IssueList
from github_searcher.jobs import Jobs
from github_searcher.pr_tracking import PRTracking
from github_searcher.repo_list import RepoList
from github_searcher.repo_signals import RepoSignals
from github_searcher.tracked_issues import TrackedIssues
from github_searcher.your_repositories import YourRepositories
from sandbox.image_agent import ImageAgents
from sandbox.images import Images
from sandbox.resource_usage import ResourceUsage
from sandbox.vm_queue import VMQueue
from sandbox.vms import VMs

repos = RepoList()
jobs = Jobs()
issues = IssueList(jobs)
issue_facts = IssueFacts()
issue_tags = IssueTags()
repo_signals = RepoSignals()
tracked = RepoList("tracked.json")
tracked_issues = TrackedIssues()
explore = Explore(repos, tracked, repo_signals)
inbox = Inbox()
github_account = GithubAccount(inbox)
pr_tracking = PRTracking(inbox, github_account)
your_repositories = YourRepositories(github_account)
vms = VMs()
images = Images(vms)
image_agents = ImageAgents(images)
queue = VMQueue(vms)
sherpa = Sherpa(repo_signals)
artifacts = Artifacts()
agents = Agents(repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues, repo_signals, issue_tags, explore, artifacts)
resource_usage = ResourceUsage()
