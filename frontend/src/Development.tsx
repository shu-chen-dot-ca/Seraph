/*
A repository's Development tab on the Workspace tab (Repository.tsx with live): agents develop the repo all the time,
from its issues to pull requests you open and merge (github_searcher/projects.py, backend/projects_api.py).

Not started yet: what it does, and Start development, which asks first (Enter confirms). Starting makes a VM for the
project (3 desktops) and its agents: the chat agent (the repo's own agent, on the Agents tab), the workers and the
reviewer. Only for your own repositories (ones you can push to).

Started, the bar on top: On (off: the workers take no new issues), the mode (Drafts: what you ask the chat agent for
becomes issue drafts you create; Auto: it creates the issues itself, only ones that fit your goals), how many workers,
the project's VM and Chat (the Agents tab, where the chat agent is). Under it Goals: what you want the project to be,
kept with Save; the chat agent and the workers keep to it. Then the work, one list each, the newest change first:
- Working on: each issue a worker has, with the worker and how far its job is (its PR draft goes to the reviewer,
  then to your Inbox, where Approve opens it and Merge merges it).
- Pull requests: the open ones Approve opened, with their checks and whether they conflict with main.
- Denied: issues a worker closed as not planned, with why. Reopen opens it again on GitHub, as you, and a worker
  takes it again.
- Stopped: issues whose job was cancelled. Try again gives it to a worker again.
- Done: the last 10 merged, finished or closed.
- Errors, on the app's own repo only: the app's own errors (github_searcher/crashes.py) and what became of each.
Everything comes from the live store (projects, agents, jobs, crashes), so it moves on its own.
*/

import { CircleCheck, CircleDot, CircleX, ExternalLink, GitPullRequest, Loader2, MessageSquare, Monitor, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JobProgressBar } from "@/components/ui/job-progress";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, useLoaded } from "@/live";
import { timeAgo } from "@/lib/utils";

const DENY_LABEL: Record<string, string> = {
  not_valid: "Not valid",
  duplicate: "Duplicate",
  conflicting: "Conflicts",
  out_of_scope: "Out of scope",
  cannot_reproduce: "Can't reproduce",
};

const CHECKS_LABEL: Record<string, string> = {
  passed: "Checks passed",
  failed: "Checks failed",
  running: "Checks running",
  none: "No checks",
};

const MODE_TEXT: Record<string, string> = {
  drafts: "What you ask the chat agent for becomes issue drafts in its chat, and you create them.",
  auto: "The chat agent creates the issues itself from what you talk about, only ones that fit your goals.",
};

export default function Development(props: { repo: string }) {
  const projects = useLive("projects");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const crashes = useLive("crashes");
  const yourRepos = useLive("your_repos");
  const loaded = useLoaded("projects");
  const project = projects.find((each) => each.repo.toLowerCase() === props.repo.toLowerCase());
  // The request on its way: "start", "on", "mode", "agents", "goals", or "retry:<n>" / "reopen:<n>".
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState(false);
  // The goals as you type them; null: as saved.
  const [goals, setGoals] = useState<string | null>(null);

  const canPush = yourRepos.repos.some((each) => each.name.toLowerCase() === props.repo.toLowerCase() && each.can_push);
  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }
  const issueUrl = (number: number) => `https://github.com/${props.repo}/issues/${number}`;

  async function start() {
    setBusy("start");
    try {
      await api(`/api/projects/${props.repo}`, { method: "POST" });
      toast.success("Development started: the VM is being made, then the agents start.");
    } catch (err) {
      toast.error(`Could not start: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function change(what: string, fields: Record<string, unknown>) {
    setBusy(what);
    try {
      await api(`/api/projects/${props.repo}`, { method: "PUT", body: fields });
      if (what === "goals") {
        setGoals(null);
        toast.success("Goals saved");
      }
    } catch (err) {
      toast.error(`Could not change it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function act(action: "retry" | "reopen", number: number) {
    setBusy(`${action}:${number}`);
    try {
      await api(`/api/projects/${props.repo}/${action}/${number}`, { method: "POST" });
      toast.success(action === "reopen" ? `Reopened #${number}: a worker takes it again` : `A worker takes #${number} again`);
    } catch (err) {
      toast.error(`Could not ${action === "reopen" ? "reopen" : "try"} #${number}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  if (!loaded) {
    return <div className="p-3 text-muted-foreground">Loading…</div>;
  }

  if (project === undefined) {
    return (
      <div className="max-w-2xl space-y-3 p-4 max-md:p-3">
        <h2 className="text-base font-semibold">Development</h2>
        <p>Agents develop this repository all the time. You say what you want; they do the work as pull requests, and you decide what goes in.</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Every open issue is taken by a worker. It checks the issue is real and new, reproduces it, then fixes it, or closes it as not planned with why.</li>
          <li>A reviewer checks each pull request, runs its tests and looks at its pictures, before it reaches your Inbox.</li>
          <li>In the Inbox, Approve opens the pull request and Merge merges it.</li>
          <li>The chat agent, on the Agents tab, turns what you ask for into issues: as drafts you create, or by itself in Auto mode.</li>
        </ul>
        <p className="text-muted-foreground">Start makes a VM for it (3 desktops, the most memory allowed) and its agents: the chat agent, two workers and a reviewer.</p>
        <Button disabled={busy !== "" || !canPush} onClick={() => setConfirming(true)}>
          {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} Start development
        </Button>
        {!canPush && <p className="text-xs text-muted-foreground">Only for your own repositories: ones you can push to.</p>}

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start development of {props.repo}?</AlertDialogTitle>
              <AlertDialogDescription>
                A new VM is made for it, and four agents start working on its open issues. They open and close issues and comment on them as you; pull
                requests only go out when you approve them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={start}>Start development</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  const issues = Object.values(project.issues).sort((a, b) => b.at.localeCompare(a.at));
  const working = issues.filter((issue) => issue.state === "working");
  const denied = issues.filter((issue) => issue.state === "denied");
  const stopped = issues.filter((issue) => issue.state === "stopped");
  const done = issues.filter((issue) => issue.state === "done" || issue.state === "closed").slice(0, 10);
  const prs = Object.values(project.prs)
    .filter((pr) => pr.state === "open")
    .sort((a, b) => b.at.localeCompare(a.at));
  const goalsText = goals ?? project.goals;
  const heading = "flex items-center gap-2 px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground";
  const row = "flex min-w-0 items-center gap-2 px-3 py-2";

  return (
    <div className="max-w-5xl pb-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
        <label className="flex items-center gap-2">
          <Switch checked={project.on} disabled={busy !== ""} onCheckedChange={(on) => change("on", { on })} />
          On
        </label>
        <Tabs value={project.mode} onValueChange={(mode) => change("mode", { mode })}>
          <TabsList>
            <TabsTrigger value="drafts" className="px-2.5">
              Drafts
            </TabsTrigger>
            <TabsTrigger value="auto" className="px-2.5">
              Auto
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Workers</span>
          <Tabs value={String(project.agents)} onValueChange={(value) => change("agents", { agents: Number(value) })}>
            <TabsList>
              {[1, 2, 3].map((count) => (
                <TabsTrigger key={count} value={String(count)} className="px-2.5">
                  {count}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {project.vm !== null && (
            <a href={`#/vms/${encodeURIComponent(project.vm)}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline">
              <Monitor className="size-4" /> {project.vm}
            </a>
          )}
          <Button size="sm" variant="outline" asChild>
            <a href={`#/home?repo=${encodeURIComponent(props.repo)}`}>
              <MessageSquare /> Chat
            </a>
          </Button>
        </div>
      </div>
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        {project.on ? MODE_TEXT[project.mode] : "Off: the workers take no new issues. What they are on goes on."}
      </p>
      {project.error !== "" && <div className="border-b bg-destructive/10 px-3 py-1.5 text-destructive">The last round failed, it is tried again in a minute: {project.error}</div>}

      <div className={heading}>Goals</div>
      <div className="px-3">
        <Textarea
          className="min-h-24"
          placeholder="What you want this project to be, and what is out of it. The chat agent only makes issues that fit, and the workers turn down issues that don't."
          value={goalsText}
          onChange={(event) => setGoals(event.target.value)}
        />
        <div className="mt-2 flex justify-end gap-1.5">
          {goals !== null && (
            <Button size="sm" variant="ghost" onClick={() => setGoals(null)}>
              Cancel
            </Button>
          )}
          <Button size="sm" disabled={goals === null || goals === project.goals || busy !== ""} onClick={() => change("goals", { goals: goalsText })}>
            {busy === "goals" && <Loader2 className="animate-spin" />} Save
          </Button>
        </div>
      </div>

      <div className={heading}>
        Working on <span className="tabular-nums">{working.length}</span>
      </div>
      <div className="divide-y border-y">
        {working.length === 0 && <div className="px-3 py-2 text-muted-foreground">{project.on ? "Nothing right now: no open issue is free." : "Nothing: development is off."}</div>}
        {working.map((issue) => {
          const job = jobs.find((each) => each.id === issue.job);
          return (
            <div key={issue.number} className="px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <CircleDot className="size-4 shrink-0 text-ok" />
                <a href={issueUrl(issue.number)} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                  {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
                </a>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{issue.agent !== null ? (agentNames[issue.agent] ?? "") : ""}</span>
              </div>
              {job !== undefined && (
                <div className="mt-1 flex min-w-0 items-center gap-2 pl-6">
                  <JobProgressBar job={job} className="shrink-0" />
                  <span className="truncate text-xs text-muted-foreground">{job.status === "waiting_on_user" ? "Its pull request is in review or in your Inbox" : job.headline}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={heading}>
        Pull requests <span className="tabular-nums">{prs.length}</span>
      </div>
      <div className="divide-y border-y">
        {prs.length === 0 && <div className="px-3 py-2 text-muted-foreground">No open pull requests.</div>}
        {prs.map((pr) => (
          <div key={pr.number} className={row}>
            <GitPullRequest className="size-4 shrink-0 text-ok" />
            <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
              {pr.title} <span className="text-muted-foreground">#{pr.number}</span>
            </a>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              {pr.mergeable === false && <span className="text-warn">{pr.redo ? "Conflicts: being made again on the new main" : "Conflicts with main"}</span>}
              <StatusDot tone={pr.checks === "passed" ? "green" : pr.checks === "failed" ? "red" : pr.checks === "running" ? "amber" : "gray"} />
              {CHECKS_LABEL[pr.checks]}
            </span>
          </div>
        ))}
      </div>

      {denied.length > 0 && (
        <>
          <div className={heading}>
            Denied <span className="tabular-nums">{denied.length}</span>
          </div>
          <div className="divide-y border-y">
            {denied.map((issue) => (
              <div key={issue.number} className="px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <CircleX className="size-4 shrink-0 text-muted-foreground" />
                  <a href={issueUrl(issue.number)} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                    {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
                  </a>
                  <Badge variant="outline" className="shrink-0 py-0">
                    {DENY_LABEL[issue.kind ?? ""] ?? issue.kind}
                  </Badge>
                  <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={busy !== ""} onClick={() => act("reopen", issue.number)}>
                    {busy === `reopen:${issue.number}` ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reopen
                  </Button>
                </div>
                <p className="mt-1 pl-6 text-xs text-muted-foreground">{issue.why}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {stopped.length > 0 && (
        <>
          <div className={heading}>
            Stopped <span className="tabular-nums">{stopped.length}</span>
          </div>
          <div className="divide-y border-y">
            {stopped.map((issue) => (
              <div key={issue.number} className={row}>
                <CircleDot className="size-4 shrink-0 text-muted-foreground" />
                <a href={issueUrl(issue.number)} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                  {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
                </a>
                <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={busy !== ""} onClick={() => act("retry", issue.number)}>
                  {busy === `retry:${issue.number}` ? <Loader2 className="animate-spin" /> : <RotateCcw />} Try again
                </Button>
              </div>
            ))}
          </div>
        </>
      )}

      {done.length > 0 && (
        <>
          <div className={heading}>Done</div>
          <div className="divide-y border-y">
            {done.map((issue) => (
              <div key={issue.number} className={row}>
                <CircleCheck className="size-4 shrink-0 text-muted-foreground" />
                <a href={issueUrl(issue.number)} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                  {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
                </a>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {issue.state === "closed" ? "Closed" : "Done"} {timeAgo(issue.at)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {project.app && (
        <>
          <div className={heading}>
            Errors <span className="tabular-nums">{crashes.length}</span>
          </div>
          <div className="divide-y border-y">
            {crashes.length === 0 && <div className="px-3 py-2 text-muted-foreground">No errors so far.</div>}
            {crashes.slice(0, 30).map((crash) => (
              <div key={crash.id} className={row} title={crash.detail}>
                <StatusDot tone={crash.state === "new" || crash.state === "sent" ? "amber" : "gray"} />
                <span className="min-w-0 truncate">{crash.message}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="max-md:hidden">
                    {crash.source}, {crash.count}x, {timeAgo(crash.last_at)}
                  </span>
                  {crash.state === "new" && "New"}
                  {crash.state === "sent" && "With the agent"}
                  {crash.state === "skipped" && <span title={crash.note}>Skipped</span>}
                  {crash.state === "filed" && crash.issue !== null && (
                    <a href={issueUrl(crash.issue)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                      #{crash.issue} <ExternalLink className="size-3" />
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
