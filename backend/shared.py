"""The app's single instances, made once when the backend imports this module.

Every router imports what it needs from here, so all of them work on the same
lists (and the facts about each issue), the Tracked list (and its repos' issues), jobs, inbox, VMs, their images, VM queue and agents. The order matters: the queue
keeps its state on the VM records, and Agents needs everything else (it also
sets the queue's on_grant / on_kick callbacks). Agents only starts its worker
tasks in the app's lifespan (backend/app.py), because they need the running
event loop.
"""

from github_searcher.agents import Agents
from github_searcher.inbox import Inbox
from github_searcher.issue_facts import IssueFacts
from github_searcher.issue_list import IssueList
from github_searcher.jobs import Jobs
from github_searcher.repo_list import RepoList
from github_searcher.tracked_issues import TrackedIssues
from sandbox.images import Images
from sandbox.vm_queue import VMQueue
from sandbox.vms import VMs

repos = RepoList()
issues = IssueList()
issue_facts = IssueFacts()
tracked = RepoList("tracked.json")
tracked_issues = TrackedIssues()
jobs = Jobs()
inbox = Inbox()
vms = VMs()
images = Images(vms)
queue = VMQueue(vms)
agents = Agents(repos, issues, jobs, inbox, vms, queue, tracked, tracked_issues)
