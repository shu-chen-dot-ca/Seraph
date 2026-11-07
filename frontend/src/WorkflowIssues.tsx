/*
A Workflow repository's Issues tab (Workflow.tsx): Open and Closed, with New issue. Each row shows where the issue is
(Not started, Being worked on, In review, Waiting for you, Stopped; closed: Done or Closed), its title and its goal, who
made it, and the issue or pull request it was found while working on.

One issue (open=<number>) shows its goal, requirements and how to check it is done (an issue without requirements is
written down by its worker first), where it is (its worker and how far its job is, its pull request), and why it closed.
Close issue asks why (it can't while its pull request is open: reject that, closing the issue too); Try again gives a
stopped one out again.

New issue: a title and a goal, and, if you want to say them yourself, its requirements (one per line) and how to check.
Without them its worker writes them down from what you wrote, and nothing more.
*/

import { ArrowLeft, CircleCheck, CircleDot, CircleX, ExternalLink, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { JobProgressBar } from "@/components/ui/job-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Job, type WorkflowIssue, type WorkflowRepo } from "@/live";
import { timeAgo } from "@/lib/utils";

const REASON_LABEL: Record<string, string> = {
  merged: "Done",
  duplicate: "Duplicate",
  not_valid: "Not valid",
  cannot_reproduce: "Can't reproduce",
  too_big: "Split up",
  by_you: "Closed by you",
  on_github: "Closed on GitHub",
};

export default function WorkflowIssues(props: { record: WorkflowRepo; base: string; state: "open" | "closed"; open: string | null }) {
  const record = props.record;
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const [creating, setCreating] = useState(false);
  const names: Record<string, string> = {};
  for (const agent of agents) {
    names[agent.id] = agent.name;
  }
  const all = Object.values(record.issues);
  const openList = all.filter((issue) => issue.state === "open").sort((a, b) => a.number - b.number);
  const closedList = all.filter((issue) => issue.state === "closed").sort((a, b) => (b.closed_at ?? b.at).localeCompare(a.closed_at ?? a.at));
  const shown = props.state === "closed" ? closedList : openList;

  // Where an open issue is, from its pull requests and its job.
  function stage(issue: WorkflowIssue): string {
    const prs = Object.values(record.prs).filter((pr) => pr.issue === issue.number && (pr.state === "review" || pr.state === "waiting"));
    if (prs.some((pr) => pr.state === "waiting")) {
      return record.decides === "you" ? "Waiting for you" : "Waiting for a decision";
    }
    if (prs.length > 0) {
      return "In review";
    }
    if (issue.stopped) {
      return "Stopped";
    }
    if (issue.job !== null) {
      return "Being worked on";
    }
    return "Not started";
  }

  function madeBy(issue: WorkflowIssue): string {
    if (issue.by === "you") {
      return "you";
    }
    if (issue.by === "github") {
      return "GitHub";
    }
    return names[issue.by] ?? "an agent";
  }

  if (props.open !== null && record.issues[props.open] !== undefined) {
    const issue = record.issues[props.open];
    const job = jobs.find((each) => each.id === issue.job);
    return <IssueView key={issue.number} record={record} issue={issue} base={props.base} stage={stage(issue)} by={madeBy(issue)} job={job} names={names} />;
  }

  return (
    <div className="pb-6">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Tabs value={props.state} onValueChange={(value) => (window.location.hash = value === "closed" ? `${props.base}&tab=issues&state=closed` : `${props.base}&tab=issues`)}>
          <TabsList>
            <TabsTrigger value="open" className="px-2.5">
              Open <span className="text-xs text-muted-foreground tabular-nums">{openList.length}</span>
            </TabsTrigger>
            <TabsTrigger value="closed" className="px-2.5">
              Closed <span className="text-xs text-muted-foreground tabular-nums">{closedList.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus /> New issue
        </Button>
      </div>
      <div className="divide-y border-b">
        {shown.length === 0 && (
          <div className="px-3 py-3 text-muted-foreground">
            {props.state === "closed" ? "No closed issues yet." : "No open issues. Ask the chat agent for something, or make one with New issue."}
          </div>
        )}
        {shown.map((issue) => {
          const where = issue.state === "open" ? stage(issue) : (REASON_LABEL[issue.reason ?? ""] ?? "Closed");
          let icon = <CircleDot className="size-4 shrink-0 text-muted-foreground" />;
          if (issue.state === "open" && where !== "Not started" && where !== "Stopped") {
            icon = <CircleDot className="size-4 shrink-0 text-primary" />;
          } else if (issue.state === "closed" && issue.reason === "merged") {
            icon = <CircleCheck className="size-4 shrink-0 text-muted-foreground" />;
          } else if (issue.state === "closed") {
            icon = <CircleX className="size-4 shrink-0 text-muted-foreground" />;
          }
          return (
            <a key={issue.number} href={`${props.base}&tab=issues&open=${issue.number}`} className="flex min-w-0 items-center gap-2.5 px-3 py-2 hover:bg-accent/50">
              {icon}
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {issue.goal || "Not written down yet"} · by {madeBy(issue)}
                  {issue.found_in !== null && ` · found in #${issue.found_in}`}
                </div>
              </div>
              <Badge variant={where === "Waiting for you" ? "default" : where === "Stopped" ? "warn" : "outline"} className="shrink-0 py-0">
                {where}
              </Badge>
            </a>
          );
        })}
      </div>
      <NewIssueDialog repo={record.repo} open={creating} onClose={() => setCreating(false)} base={props.base} />
    </div>
  );
}

function IssueView(props: {
  record: WorkflowRepo;
  issue: WorkflowIssue;
  base: string;
  stage: string;
  by: string;
  job: Job | undefined;
  names: Record<string, string>;
}) {
  const issue = props.issue;
  const record = props.record;
  const [busy, setBusy] = useState("");
  const [closing, setClosing] = useState(false);
  const [why, setWhy] = useState("");
  const prs = Object.values(record.prs)
    .filter((pr) => pr.issue === issue.number)
    .sort((a, b) => b.number - a.number);
  const openPR = prs.find((pr) => pr.state === "review" || pr.state === "waiting");

  async function close() {
    setBusy("close");
    try {
      await api(`/api/workflow/${record.repo}/issues/${issue.number}/close`, { method: "POST", body: { why: why } });
      toast.success(`Closed #${issue.number}`);
      setClosing(false);
    } catch (err) {
      toast.error(`Could not close it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function retry() {
    setBusy("retry");
    try {
      await api(`/api/workflow/${record.repo}/issues/${issue.number}/retry`, { method: "POST" });
      toast.success(`A worker takes #${issue.number} again`);
    } catch (err) {
      toast.error(`Could not try again: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  const section = "space-y-2 border-t px-4 py-3";

  return (
    <div className="pb-8">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Button size="sm" variant="ghost" asChild>
          <a href={`${props.base}&tab=issues${issue.state === "closed" ? "&state=closed" : ""}`}>
            <ArrowLeft /> Issues
          </a>
        </Button>
        <span className="ml-auto flex items-center gap-1.5">
          {issue.state === "open" && issue.stopped && (
            <Button size="sm" variant="outline" disabled={busy !== ""} onClick={retry}>
              {busy === "retry" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Try again
            </Button>
          )}
          {issue.state === "open" && (
            <Button size="sm" variant="outline" disabled={busy !== "" || openPR !== undefined} onClick={() => setClosing(true)} title={openPR !== undefined ? `Its pull request #${openPR.number} is open: reject it to close this too` : undefined}>
              <X /> Close issue
            </Button>
          )}
        </span>
      </div>

      <div className="space-y-1 px-4 py-3">
        <h2 className="text-base font-semibold">
          {issue.title} <span className="font-normal text-muted-foreground">#{issue.number}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <Badge variant={props.stage === "Waiting for you" ? "default" : "outline"} className="py-0">
            {issue.state === "open" ? props.stage : (REASON_LABEL[issue.reason ?? ""] ?? "Closed")}
          </Badge>
          <span>
            by {props.by}, {timeAgo(issue.created_at)}
          </span>
          {issue.found_in !== null && (
            <a href={`${props.base}&tab=${record.prs[String(issue.found_in)] !== undefined ? "pulls" : "issues"}&open=${issue.found_in}`} className="hover:underline">
              · found while working on #{issue.found_in}
            </a>
          )}
          {issue.url !== null && (
            <a href={issue.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
              GitHub <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>

      <div className={section}>
        <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2.5 max-md:grid-cols-1">
          <span className="font-medium">Goal</span>
          <span className="max-w-3xl">{issue.goal || <span className="text-muted-foreground">Not written down yet: its worker does that first.</span>}</span>
          <span className="font-medium">Requirements</span>
          {issue.requirements.length > 0 ? (
            <ul className="max-w-3xl list-disc space-y-1 pl-4">
              {issue.requirements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">Not written down yet.</span>
          )}
          <span className="font-medium">How to check</span>
          <span className="max-w-3xl whitespace-pre-wrap">{issue.validation || <span className="text-muted-foreground">Not written down yet.</span>}</span>
          {issue.state === "closed" && (
            <>
              <span className="font-medium">Closed</span>
              <span className="max-w-3xl">
                {REASON_LABEL[issue.reason ?? ""] ?? "Closed"}
                {issue.closed_at !== null && `, ${timeAgo(issue.closed_at)}`}
                {issue.why !== "" && `: ${issue.why}`}
              </span>
            </>
          )}
        </div>
      </div>

      {(props.job !== undefined || prs.length > 0) && (
        <div className={section}>
          <div className="text-[15px] font-semibold">Work</div>
          {props.job !== undefined && (
            <div className="space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <a href={`#/agents/${props.job.agent}`} className="shrink-0 hover:underline">
                  {props.names[props.job.agent] ?? "Its worker"}
                </a>
                <JobProgressBar job={props.job} className="shrink-0" />
              </div>
              {props.job.headline !== "" && <div className="text-muted-foreground">{props.job.headline}</div>}
            </div>
          )}
          {prs.map((pr) => (
            <a key={pr.number} href={`${props.base}&tab=pulls&open=${pr.number}`} className="flex min-w-0 items-center gap-2 hover:underline">
              <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
              <span className="truncate">{pr.review !== null && pr.review.summary !== "" ? pr.review.summary : pr.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {pr.state === "review" && "In review"}
                {pr.state === "waiting" && "Reviewed"}
                {pr.state === "merged" && "Merged"}
                {pr.state === "rejected" && "Rejected"}
                {pr.state === "closed" && "Closed"}
              </span>
            </a>
          ))}
        </div>
      )}

      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Close #{issue.number}?</DialogTitle>
            <DialogDescription>
              {issue.job !== null ? "Its worker stops working on it. " : ""}
              {issue.url !== null ? "It is closed on GitHub as not planned, with why as a comment." : "Nobody works on it again."}
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Why (optional)" className="min-h-20" value={why} onChange={(event) => setWhy(event.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(false)}>
              Cancel
            </Button>
            <Button disabled={busy !== ""} onClick={close}>
              {busy === "close" && <Loader2 className="animate-spin" />}
              Close issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewIssueDialog(props: { repo: string; open: boolean; onClose: () => void; base: string }) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [requirements, setRequirements] = useState("");
  const [validation, setValidation] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const issue = await api<WorkflowIssue>(`/api/workflow/${props.repo}/issues`, {
        method: "POST",
        body: { title: title, goal: goal, requirements: requirements.split("\n"), validation: validation },
      });
      toast.success(`Created #${issue.number}: a worker takes it`);
      setTitle("");
      setGoal("");
      setRequirements("");
      setValidation("");
      props.onClose();
      window.location.hash = `${props.base}&tab=issues&open=${issue.number}`;
    } catch (err) {
      toast.error(`Could not create it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>One goal, small enough for one pull request. Leave the requirements and how to check empty, and its worker writes them from what you wrote.</DialogDescription>
        </DialogHeader>
        <Input placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea placeholder="Goal: what is different once it is done, in a sentence" className="min-h-16" value={goal} onChange={(event) => setGoal(event.target.value)} />
        <Textarea
          placeholder="Requirements, one per line (optional)"
          className="min-h-20"
          value={requirements}
          onChange={(event) => setRequirements(event.target.value)}
        />
        <Textarea placeholder="How to check it is done (optional)" className="min-h-16" value={validation} onChange={(event) => setValidation(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={title.trim() === "" || busy} onClick={create}>
            {busy && <Loader2 className="animate-spin" />}
            Create issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
