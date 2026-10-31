/*
The GitHub tab's Tasks page (#/github/tasks): every piece of work on GitHub and how far it got, by repo. Built from
what the app already keeps live (jobs, the Inbox, your PRs and issues on the GitHub tab); nothing is read from GitHub
for it.
A task is one issue being worked on, or one PR. Everything about it is put together: the agent's jobs on the issue
(fix_issue) or on its PR (follow_up), the drafts they made in the Inbox, the PR that was sent (found by its draft's
job, else by the issue the PR says it fixes) and the issue as the GitHub tab follows it. Your PRs on other people's
projects, and the issues you opened or commented on there, are tasks of their own when no agent worked on them.
The bar on top: tabs In progress and Done (state=done) with how many, next to them tabs By repo and Recent
(view=recent), and a box that filters by title, repo and number. In progress: an agent's job on it is queued, working
or waiting on you, a draft waits in the Inbox, its PR is open, or the issue is open. Done: everything else (merged,
closed, the job finished with nothing open).
The ones waiting on you (a draft waits for your decision, or the agent asks you something) always come first: By repo
groups the list by repo, A to Z (the repo's line opens its page on the GitHub tab when it is one of yours or a star,
else GitHub), with those first in each repo, then the most recently changed; Recent is one list, those first, then
the most recently changed, each with its repo. A task's row: an issue or PR icon, the title, where it stands in plain
words (a draft waits for you, the agent asks you something, the agent works and on what, in a VM's queue, the PR's
checks and review, merged, closed), and its progress: Issue, Agent, Draft, PR, Merged, the steps reached in color.
A click opens the task in a pop-up (task=owner/name%23n): every part of it with where to go:
- Issue: its number, title and state; Open shows it in the thread pop-up here (open=owner/name%23n), GitHub on GitHub.
- Agent work: each job, the newest first, with its progress bar, its agent (to the agent's chat), the job (Jobs) and
  its VM (the VM's page).
- Drafts: each Inbox draft for it, the newest first, with its status (waiting, approved, rejected, redrafting); a click
  opens it in the Inbox.
- Pull request: its number, title, state, checks and review; Open shows it in the thread pop-up, GitHub on GitHub.
- The repository: its page on the GitHub tab, or GitHub.
The X, Esc or a click outside closes it, back to the list.
*/

import { Bot, ChevronRight, CircleDot, ExternalLink, FileText, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { useState } from "react";

import ThreadDialog from "@/ThreadDialog";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { JobProgressBar, since, useNow } from "@/components/ui/job-progress";
import { DRAFT_TONE, JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLive, type Draft, type GithubIssue, type Job, type TrackedPR } from "@/live";
import { cn } from "@/lib/utils";

// One task: an issue being worked on (key is the issue), or a PR on its own (key is the PR).
type Task = {
  key: string; // "owner/name#n"
  repo: string;
  title: string;
  issue: string | null; // "owner/name#n"
  pr: TrackedPR | null;
  followed: GithubIssue | null; // the issue as the GitHub tab's Issues follows it
  jobs: Job[];
  drafts: Draft[];
  updated: string;
  status: string; // where it stands, in plain words
  color: string; // the status's text color
  steps: boolean[]; // STEPS reached
  needsYou: boolean; // a draft waits for your decision, or the agent asks you something: always listed first
};

const STEPS = ["Issue", "Agent", "Draft", "PR", "Merged"];
const ACTIVE = ["queued", "working", "waiting_on_user"];
const DRAFT_LABEL: Record<string, string> = { pending: "Waiting for you", approved: "Approved", rejected: "Rejected", replied: "Redrafting" };
const KIND_LABEL: Record<string, string> = { pr: "PR", comment: "Comment", question: "Question", taken: "Taken" };
const CHECKS_TEXT: Record<string, string> = {
  waiting: "waiting for a maintainer to run the checks",
  running: "checks running",
  passed: "checks passed",
  failed: "checks failed",
  none: "no checks",
};
const REVIEW_TEXT: Record<string, string> = { approved: "approved", changes_requested: "changes asked for", commented: "reviewed with comments", none: "not reviewed yet" };

export default function Tasks(props: { state: string; view: string; task: string | null; open: string | null }) {
  const jobs = useLive("jobs");
  const inbox = useLive("inbox");
  const prs = useLive("prs");
  const agents = useLive("agents");
  const issueList = useLive("issues");
  const yourRepos = useLive("your_repos");
  const [filter, setFilter] = useState("");
  const now = useNow();

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }
  const jobsById: Record<string, Job> = {};
  for (const job of jobs) {
    jobsById[job.id] = job;
  }
  const listedRepos = [...yourRepos.repos, ...yourRepos.starred].map((repo) => repo.name);

  // Which task each of your PRs belongs to: the issue its draft's job was on, else the first issue it fixes, else itself.
  const prKey: Record<string, string> = {};
  for (const pr of prs.items) {
    const job = pr.job !== null ? jobsById[pr.job] : undefined;
    prKey[pr.id] = pr.id;
    if (job !== undefined && job.issue !== null) {
      prKey[pr.id] = job.issue;
    } else if (pr.issues.length > 0) {
      prKey[pr.id] = `${pr.repo}#${pr.issues[0].number}`;
    }
  }

  const tasks: Record<string, Task> = {};
  // Your PRs (not the ones you only commented on).
  for (const pr of prs.items) {
    if (pr.relation !== "author") {
      continue;
    }
    const key = prKey[pr.id];
    tasks[key] ??= { key: key, repo: pr.repo, title: "", issue: null, pr: null, followed: null, jobs: [], drafts: [], updated: "", status: "", color: "", steps: [], needsYou: false };
    tasks[key].pr = pr;
    if (key !== pr.id) {
      tasks[key].issue = key;
    }
  }
  // Issues you opened or commented on.
  for (const issue of prs.issues) {
    tasks[issue.id] ??= { key: issue.id, repo: issue.repo, title: "", issue: null, pr: null, followed: null, jobs: [], drafts: [], updated: "", status: "", color: "", steps: [], needsYou: false };
    tasks[issue.id].followed = issue;
    tasks[issue.id].issue = issue.id;
  }
  // The agents' jobs on an issue, or on a PR or issue they answer.
  for (const job of jobs) {
    let key = job.issue;
    if (key === null && job.thread !== null) {
      key = prKey[job.thread] ?? job.thread;
    }
    if (key === null) {
      continue;
    }
    tasks[key] ??= { key: key, repo: key.split("#")[0], title: "", issue: null, pr: null, followed: null, jobs: [], drafts: [], updated: "", status: "", color: "", steps: [], needsYou: false };
    tasks[key].jobs.push(job);
    if (job.issue !== null) {
      tasks[key].issue = job.issue;
    }
  }
  // The drafts: by their job's task, else by what they answer.
  for (const draft of inbox) {
    const job = draft.job !== null ? jobsById[draft.job] : undefined;
    let key: string | null = null;
    if (job !== undefined && job.issue !== null) {
      key = job.issue;
    } else if (job !== undefined && job.thread !== null) {
      key = prKey[job.thread] ?? job.thread;
    } else if (draft.update_of !== null) {
      key = prKey[draft.update_of] ?? draft.update_of;
    } else if (draft.target !== null) {
      key = prKey[draft.target] ?? draft.target;
    }
    if (key === null) {
      continue;
    }
    tasks[key] ??= { key: key, repo: key.split("#")[0], title: "", issue: null, pr: null, followed: null, jobs: [], drafts: [], updated: "", status: "", color: "", steps: [], needsYou: false };
    tasks[key].drafts.push(draft);
  }

  // Newest first inside, the title, the newest change, where it stands and how far it got.
  for (const task of Object.values(tasks)) {
    task.jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    task.drafts.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const listed = task.issue !== null ? issueList.items.find((each) => each.id === task.issue) : undefined;
    task.title = task.followed?.title ?? listed?.title ?? task.pr?.title ?? task.jobs[0]?.title ?? task.drafts[0]?.title ?? task.key;
    const times = [task.pr?.updated_at ?? "", task.followed?.updated_at ?? ""];
    for (const job of task.jobs) {
      times.push(job.updated_at);
    }
    for (const draft of task.drafts) {
      times.push(draft.decided_at ?? draft.created_at);
    }
    task.updated = times.sort().reverse()[0];
    task.steps = [task.issue !== null, task.jobs.length > 0, task.drafts.length > 0, task.pr !== null, task.pr !== null && task.pr.state === "merged"];
    task.needsYou = task.drafts.some((draft) => draft.status === "pending") || task.jobs.some((job) => job.status === "waiting_on_user");

    const working = task.jobs.find((job) => job.status === "working");
    if (task.drafts.some((draft) => draft.status === "pending")) {
      task.status = "A draft waits for your decision in the Inbox";
      task.color = "text-warn";
    } else if (task.jobs.some((job) => job.status === "waiting_on_user")) {
      task.status = "The agent asks you something";
      task.color = "text-warn";
    } else if (working !== undefined) {
      task.status = `${agentNames[working.agent] ?? "The agent"} works on it${working.headline !== "" ? `: ${working.headline}` : ""}`;
      task.color = "text-primary";
    } else if (task.jobs.some((job) => job.status === "queued")) {
      task.status = "The agent waits for a VM";
    } else if (task.pr !== null && task.pr.state === "merged") {
      task.status = task.pr.merged_by !== null ? `Merged by ${task.pr.merged_by}` : "Merged";
      task.color = "text-violet-500";
    } else if (task.pr !== null && task.pr.state === "open") {
      task.status = `PR open: ${CHECKS_TEXT[task.pr.checks]}, ${REVIEW_TEXT[task.pr.review]}`;
      if (task.pr.checks === "failed") {
        task.color = "text-destructive";
      } else if (task.pr.review === "changes_requested") {
        task.color = "text-warn";
      } else if (task.pr.review === "approved") {
        task.color = "text-ok";
      }
    } else if (task.pr !== null) {
      task.status = "PR closed without merging";
      task.color = "text-destructive";
    } else if (task.followed !== null && task.followed.state === "open") {
      task.status = task.followed.relation === "author" ? "Issue open, you opened it" : "Issue open, you commented";
    } else if (task.jobs.length > 0) {
      task.status = "The agent's work on it ended";
      task.color = "text-muted-foreground";
    } else {
      task.status = "Issue closed";
      task.color = "text-muted-foreground";
    }
  }

  // In progress or done, and filtered.
  const all = Object.values(tasks);
  const inProgress = all.filter(
    (task) =>
      task.jobs.some((job) => ACTIVE.includes(job.status)) ||
      task.drafts.some((draft) => draft.status === "pending") ||
      (task.pr !== null && task.pr.state === "open") ||
      (task.followed !== null && task.followed.state === "open"),
  );
  const done = all.filter((task) => !inProgress.includes(task));
  const needle = filter.trim().toLowerCase();
  const shown = (props.state === "done" ? done : inProgress).filter(
    (task) => needle === "" || task.title.toLowerCase().includes(needle) || task.key.toLowerCase().includes(needle.replace(/^#/, "")),
  );
  // One group per repo (By repo), or one group of every task with no header (Recent). The ones waiting on you first.
  const groups: { repo: string | null; tasks: Task[] }[] = [];
  if (props.view === "recent") {
    shown.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.updated.localeCompare(a.updated));
    groups.push({ repo: null, tasks: shown });
  } else {
    shown.sort((a, b) => a.repo.localeCompare(b.repo) || Number(b.needsYou) - Number(a.needsYou) || b.updated.localeCompare(a.updated));
    for (const task of shown) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.repo === task.repo) {
        last.tasks.push(task);
      } else {
        groups.push({ repo: task.repo, tasks: [task] });
      }
    }
  }

  // The list's address (its tabs), and what a task or a thread pop-up adds to it.
  const listParams: string[] = [];
  if (props.state === "done") {
    listParams.push("state=done");
  }
  if (props.view === "recent") {
    listParams.push("view=recent");
  }
  const listHash = listParams.length > 0 ? `#/github/tasks?${listParams.join("&")}` : "#/github/tasks";
  const join = listParams.length > 0 ? "&" : "?";
  const selected = props.task !== null ? tasks[props.task] : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
        <Tabs
          value={props.state === "done" ? "done" : "progress"}
          onValueChange={(value) => {
            const params = [];
            if (value === "done") {
              params.push("state=done");
            }
            if (props.view === "recent") {
              params.push("view=recent");
            }
            window.location.hash = params.length > 0 ? `#/github/tasks?${params.join("&")}` : "#/github/tasks";
          }}
        >
          <TabsList>
            <TabsTrigger value="progress" className="px-2.5">
              In progress <span className="text-xs text-muted-foreground tabular-nums">{inProgress.length}</span>
            </TabsTrigger>
            <TabsTrigger value="done" className="px-2.5">
              Done <span className="text-xs text-muted-foreground tabular-nums">{done.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs
          value={props.view === "recent" ? "recent" : "repo"}
          onValueChange={(value) => {
            const params = [];
            if (props.state === "done") {
              params.push("state=done");
            }
            if (value === "recent") {
              params.push("view=recent");
            }
            window.location.hash = params.length > 0 ? `#/github/tasks?${params.join("&")}` : "#/github/tasks";
          }}
        >
          <TabsList>
            <TabsTrigger value="repo" className="px-2.5">
              By repo
            </TabsTrigger>
            <TabsTrigger value="recent" className="px-2.5">
              Recent
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input className="w-52 max-md:w-auto max-md:min-w-0 max-md:flex-1" placeholder="Filter tasks" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            {needle !== "" ? "Nothing matches the filter." : props.state === "done" ? "Nothing done yet." : "Nothing in progress. Assign an issue to an agent on the Issues page (Home)."}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.repo ?? "recent"}>
            {group.repo !== null && (
              <a
                href={listedRepos.includes(group.repo) ? `#/github/repo?repo=${encodeURIComponent(group.repo)}` : `https://github.com/${group.repo}`}
                target={listedRepos.includes(group.repo) ? undefined : "_blank"}
                rel="noreferrer"
                className="sticky top-0 z-10 flex h-7 items-center gap-1.5 border-b bg-muted px-3 text-xs font-medium hover:underline"
              >
                {group.repo}
                {!listedRepos.includes(group.repo) && <ExternalLink className="size-3" />}
                <span className="text-muted-foreground tabular-nums">{group.tasks.length}</span>
              </a>
            )}
            {group.tasks.map((task) => {
                let icon = <CircleDot className="size-4 shrink-0 text-ok" />;
                if (task.pr !== null && task.pr.state === "merged") {
                  icon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
                } else if (task.pr !== null && task.pr.state === "closed") {
                  icon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
                } else if (task.pr !== null) {
                  icon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
                }
                return (
                  <div
                    key={task.key}
                    className={cn("flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50", task.key === props.task && "bg-selected hover:bg-selected")}
                    onClick={() => (window.location.hash = `${listHash}${join}task=${encodeURIComponent(task.key)}`)}
                  >
                    <span className="mt-px">{icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{task.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{task.updated !== "" ? `${since(task.updated, now)} ago` : ""}</span>
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="shrink-0 text-foreground">
                          {group.repo === null && `${task.repo} `}#{task.key.split("#")[1]}
                        </span>
                        <span className={cn("min-w-0 truncate", task.color)}>{task.status}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-0.5">
                          {STEPS.map((step, index) => (
                            <span key={step} className="flex items-center gap-0.5">
                              {index > 0 && <ChevronRight className="size-3 text-muted-foreground/50" />}
                              <span className={cn(task.steps[index] ? "font-medium text-foreground" : "text-muted-foreground/50")}>{step}</span>
                            </span>
                          ))}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      <Dialog
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            window.location.hash = listHash;
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {selected !== undefined && (
            <div className="space-y-4">
              <div className="space-y-1 pr-6">
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <a
                    href={listedRepos.includes(selected.repo) ? `#/github/repo?repo=${encodeURIComponent(selected.repo)}` : `https://github.com/${selected.repo}`}
                    target={listedRepos.includes(selected.repo) ? undefined : "_blank"}
                    rel="noreferrer"
                    className="text-foreground hover:underline"
                  >
                    {selected.repo}
                  </a>
                  <span>#{selected.key.split("#")[1]}</span>
                </div>
                <DialogTitle className="leading-normal">{selected.title}</DialogTitle>
                <div className={cn("text-sm", selected.color)}>{selected.status}</div>
              </div>

              <section>
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <CircleDot className="size-4 text-muted-foreground" /> Issue
                </div>
                {selected.issue === null && <div className="text-muted-foreground">No issue: a PR of its own.</div>}
                {selected.issue !== null && (
                  <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      #{selected.issue.split("#")[1]} {selected.followed?.title ?? selected.title}
                    </span>
                    {selected.followed !== null && <span className="text-xs text-muted-foreground">{selected.followed.state === "open" ? "Open" : "Closed"}</span>}
                    <a href={`${listHash}${join}open=${encodeURIComponent(selected.issue)}`} className="text-xs text-primary hover:underline">
                      Open
                    </a>
                    <a
                      href={`https://github.com/${selected.issue.split("#")[0]}/issues/${selected.issue.split("#")[1]}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      GitHub <ExternalLink className="size-3" />
                    </a>
                  </div>
                )}
              </section>

              <section>
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <Bot className="size-4 text-muted-foreground" /> Agent work
                </div>
                {selected.jobs.length === 0 && <div className="text-muted-foreground">No agent worked on it.</div>}
                <div className="space-y-1.5">
                  {selected.jobs.map((job) => (
                    <div key={job.id} className="space-y-1 rounded-md border px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <StatusDot tone={JOB_TONE[job.status] ?? "gray"} />
                        <span className="min-w-0 flex-1 truncate">{job.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{JOB_LABEL[job.status] ?? job.status}</span>
                      </div>
                      <JobProgressBar job={job} />
                      {job.headline !== "" && <div className="text-xs text-muted-foreground">{job.headline}</div>}
                      <div className="flex flex-wrap items-center gap-x-3 text-xs">
                        <a href={`#/agents/${job.agent}`} className="text-primary hover:underline">
                          Agent: {agentNames[job.agent] ?? job.agent}
                        </a>
                        <a href={`#/jobs/${job.id}`} className="text-primary hover:underline">
                          Job
                        </a>
                        {job.vm !== null && (
                          <a href={`#/vms/${job.vm}`} className="text-primary hover:underline">
                            VM: {job.vm}
                          </a>
                        )}
                        <span className="text-muted-foreground">started {since(job.created_at, now)} ago</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <FileText className="size-4 text-muted-foreground" /> Drafts
                </div>
                {selected.drafts.length === 0 && <div className="text-muted-foreground">No drafts.</div>}
                <div className="rounded-md border empty:hidden">
                  {selected.drafts.map((draft) => (
                    <a key={draft.id} href={`#/inbox/${draft.id}`} className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent/50">
                      <StatusDot tone={DRAFT_TONE[draft.status] ?? "gray"} />
                      <span className="w-16 shrink-0 text-xs text-muted-foreground">{KIND_LABEL[draft.kind] ?? draft.kind}</span>
                      <span className="min-w-0 flex-1 truncate">{draft.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {draft.sent !== null ? "Sent" : (DRAFT_LABEL[draft.status] ?? draft.status)} · {since(draft.created_at, now)} ago
                      </span>
                    </a>
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <GitPullRequest className="size-4 text-muted-foreground" /> Pull request
                </div>
                {selected.pr === null && <div className="text-muted-foreground">No PR on GitHub yet.</div>}
                {selected.pr !== null && (
                  <div className="space-y-0.5 rounded-md border px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        #{selected.pr.number} {selected.pr.title}
                      </span>
                      <Badge variant="secondary">{selected.pr.state === "open" ? (selected.pr.draft ? "Draft" : "Open") : selected.pr.state === "merged" ? "Merged" : "Closed"}</Badge>
                      <a href={`${listHash}${join}open=${encodeURIComponent(selected.pr.id)}`} className="text-xs text-primary hover:underline">
                        Open
                      </a>
                      <a href={selected.pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
                        GitHub <ExternalLink className="size-3" />
                      </a>
                    </div>
                    {selected.pr.state === "open" && (
                      <div className="text-xs text-muted-foreground">
                        {CHECKS_TEXT[selected.pr.checks]}, {REVIEW_TEXT[selected.pr.review]}
                        {selected.pr.last_comment !== null && `; the latest comment by ${selected.pr.last_comment.login} ${since(selected.pr.last_comment.at, now)} ago`}
                      </div>
                    )}
                    {selected.pr.agent !== null && (
                      <div className="text-xs text-muted-foreground">
                        Followed by{" "}
                        <a href={`#/agents/${selected.pr.agent}`} className="text-primary hover:underline">
                          {agentNames[selected.pr.agent] ?? selected.pr.agent}
                        </a>{" "}
                        ({selected.pr.agent_mode === "drafts" ? "drafts replies and fixes for you" : "off"})
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ThreadDialog id={props.open} onClose={() => (window.location.hash = listHash)} />
    </div>
  );
}
