/*
Work items: each piece of work on an issue, from open to merged, as one thing. The backend keeps the parts apart: the
issue (the Issues list, or a Workflow repo's issue), the jobs agents did on it (the fix, its reviews, follow-ups on
its pull request), the Inbox drafts those jobs made (questions, the PR, new versions, comments), and the pull request
on GitHub. This joins them by the ids they carry:

- a fix_issue (or project) job's `issue` is "owner/name#n"; a review job's `issue` is the draft's target;
- a follow_up job's `thread` is the pull request it answers;
- a draft belongs to its `job`; a sent PR draft's `sent` is the pull request it opened, and that PR belongs to the
  issue the draft was for (or the issue the PR says it fixes);
- a Workflow issue names its job, its agent and its newest PR; a Workflow PR names its issue, job and review job.

Repo names are compared in lower case (GitHub's spelling differs between lists). A work item's key is
"owner/name#n" in lower case, its `repo` keeps the spelling to show.

The stage is where it stands, in the order a board shows it: open (nobody on it), working, review (a reviewer agent
checks the draft), approval (waits for you), sent (its PR is open on GitHub), and done: merged, closed or stopped.
*/

import { useMemo } from "react";

import { useLive, type Draft, type IssueItem, type Job, type TrackedPR, type WorkflowIssue, type WorkflowPR, type WorkflowRepo } from "@/live";

export type Stage = "open" | "working" | "review" | "approval" | "sent" | "merged" | "closed" | "stopped";

export type WorkItem = {
  key: string;
  repo: string;
  number: number;
  title: string;
  issue: IssueItem | null; // in the Issues list (where Assign works)
  jobs: Job[]; // oldest first
  drafts: Draft[]; // oldest first
  pr: TrackedPR | null;
  workflow: WorkflowRepo | null;
  workflowIssue: WorkflowIssue | null;
  workflowPRs: WorkflowPR[]; // oldest first
  stage: Stage;
  job: Job | null; // the job going on now, else the newest one
  agent: string | null; // who works on it (or last did)
  waiting: Draft | null; // a question or approval that waits for you
  waitingPR: WorkflowPR | null; // a Workflow PR that waits for your Merge
  updatedAt: string;
};

export const OPEN_JOB = ["queued", "working", "waiting_on_user", "waiting_on_maintainers"];
export const DONE_STAGES: Stage[] = ["merged", "closed", "stopped"];
const QUESTION_KINDS = ["question", "taken"];

export function isQuestion(draft: Draft): boolean {
  return QUESTION_KINDS.includes(draft.kind);
}

// "Owner/Name#12" → "owner/name#12"; anything that isn't an issue or PR id → null.
export function keyOf(id: string | null): string | null {
  const match = (id ?? "").match(/^([^/#\s]+\/[^/#\s]+)#(\d+)$/);
  return match === null ? null : `${match[1].toLowerCase()}#${match[2]}`;
}

type Inputs = {
  issues: IssueItem[];
  jobs: Job[];
  drafts: Draft[];
  prs: TrackedPR[];
  workflow: WorkflowRepo[];
};

export function buildWorkItems(inputs: Inputs): Map<string, WorkItem> {
  const items = new Map<string, WorkItem>();
  const jobsById = new Map(inputs.jobs.map((job) => [job.id, job]));

  function ensure(id: string): WorkItem | null {
    const key = keyOf(id);
    if (key === null) {
      return null;
    }
    let item = items.get(key);
    if (item === undefined) {
      const [repo, number] = id.split("#");
      item = {
        key: key,
        repo: repo,
        number: Number(number),
        title: "",
        issue: null,
        jobs: [],
        drafts: [],
        pr: null,
        workflow: null,
        workflowIssue: null,
        workflowPRs: [],
        stage: "open",
        job: null,
        agent: null,
        waiting: null,
        waitingPR: null,
        updatedAt: "",
      };
      items.set(key, item);
    }
    return item;
  }

  // Which issue each pull request belongs to: the issue its sent draft was for, else the issue it says it fixes.
  const prIssue = new Map<string, string>();
  for (const draft of inputs.drafts) {
    if (draft.sent === null || draft.sent.kind !== "pr" || draft.update_of !== null) {
      continue;
    }
    const prKey = keyOf(`${draft.sent.repo}#${draft.sent.number}`);
    const job = draft.job !== null ? jobsById.get(draft.job) : undefined;
    const issueKey = keyOf(draft.target) ?? keyOf(job?.issue ?? null);
    if (prKey !== null && issueKey !== null && prKey !== issueKey) {
      prIssue.set(prKey, issueKey);
    }
  }
  for (const pr of inputs.prs) {
    const prKey = keyOf(pr.id);
    if (prKey === null || prIssue.has(prKey) || pr.issues.length === 0) {
      continue;
    }
    prIssue.set(prKey, `${pr.repo.toLowerCase()}#${pr.issues[0].number}`);
  }
  // An id → the id of the work item it is part of (a PR → its issue).
  function ownerOf(id: string | null): string | null {
    const key = keyOf(id);
    if (key === null) {
      return null;
    }
    const issueKey = prIssue.get(key);
    if (issueKey === undefined) {
      return id;
    }
    // Keep the spelling of the PR's repo, with the issue's number.
    return `${(id ?? "").split("#")[0]}#${issueKey.split("#")[1]}`;
  }

  for (const issue of inputs.issues) {
    const item = ensure(issue.id);
    if (item !== null) {
      item.issue = issue;
      item.repo = issue.repo;
    }
  }

  const jobItem = new Map<string, WorkItem>();
  const oldestFirst = [...inputs.jobs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const job of oldestFirst) {
    const target = job.kind === "follow_up" ? job.thread : job.issue;
    const owner = ownerOf(target);
    const item = owner !== null ? ensure(owner) : null;
    if (item !== null) {
      item.jobs.push(job);
      jobItem.set(job.id, item);
    }
  }

  const draftsOldestFirst = [...inputs.drafts].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const draft of draftsOldestFirst) {
    let item = draft.job !== null ? jobItem.get(draft.job) : undefined;
    if (item === undefined) {
      const owner = ownerOf(draft.update_of ?? draft.target);
      item = (owner !== null ? ensure(owner) : null) ?? undefined;
    }
    if (item !== undefined) {
      item.drafts.push(draft);
    }
  }

  for (const pr of inputs.prs) {
    const owner = ownerOf(pr.id);
    const item = owner !== null ? ensure(owner) : null;
    if (item !== null && (item.pr === null || item.pr.opened_at < pr.opened_at)) {
      item.pr = pr;
    }
  }

  for (const repo of inputs.workflow) {
    for (const issue of Object.values(repo.issues)) {
      const item = ensure(`${repo.repo}#${issue.number}`);
      if (item === null) {
        continue;
      }
      item.workflow = repo;
      item.workflowIssue = issue;
      if (issue.job !== null && jobsById.has(issue.job) && !item.jobs.some((job) => job.id === issue.job)) {
        item.jobs.push(jobsById.get(issue.job)!);
      }
    }
    for (const pr of Object.values(repo.prs)) {
      const item = ensure(`${repo.repo}#${pr.issue ?? pr.number}`);
      if (item === null) {
        continue;
      }
      item.workflow = repo;
      item.workflowPRs.push(pr);
      for (const jobId of [pr.job, pr.review?.job ?? null]) {
        if (jobId !== null && jobsById.has(jobId) && !item.jobs.some((job) => job.id === jobId)) {
          item.jobs.push(jobsById.get(jobId)!);
        }
      }
    }
  }

  for (const item of items.values()) {
    finish(item);
  }
  return items;
}

// Fill in what follows from the parts: the title, the job and agent now, what waits for you, and the stage.
function finish(item: WorkItem) {
  item.jobs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  item.workflowPRs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const openJob = [...item.jobs].reverse().find((job) => OPEN_JOB.includes(job.status));
  item.job = openJob ?? item.jobs[item.jobs.length - 1] ?? null;
  item.agent = item.job?.agent ?? item.workflowIssue?.agent ?? null;
  item.waiting = item.drafts.find((draft) => draft.status === "pending") ?? null;
  const lastPR = item.workflowPRs[item.workflowPRs.length - 1] ?? null;
  item.waitingPR = lastPR !== null && lastPR.state === "waiting" && item.workflow?.decides === "you" ? lastPR : null;

  const fixJob = item.jobs.find((job) => job.kind === "fix_issue");
  item.title =
    item.issue?.title ??
    item.workflowIssue?.title ??
    item.issue?.facts?.title ??
    item.pr?.title ??
    fixJob?.title.replace(/^Fix [^:]+:\s*/, "") ??
    item.drafts[0]?.title ??
    `#${item.number}`;

  const times = [
    ...item.jobs.map((job) => job.updated_at),
    ...item.drafts.map((draft) => draft.decided_at ?? draft.created_at),
    item.pr?.updated_at ?? "",
    item.workflowIssue?.at ?? "",
    lastPR?.at ?? "",
    item.issue?.added_at ?? "",
  ];
  item.updatedAt = times.reduce((latest, time) => (time > latest ? time : latest), "");
  item.stage = stageOf(item, openJob ?? null, lastPR);
}

function stageOf(item: WorkItem, openJob: Job | null, lastPR: WorkflowPR | null): Stage {
  if (item.workflowIssue !== null || lastPR !== null) {
    if (lastPR?.state === "merged") {
      return "merged";
    }
    if (lastPR?.state === "waiting") {
      return "approval";
    }
    if (lastPR?.state === "review") {
      return "review";
    }
    if (item.workflowIssue?.state === "closed") {
      return item.workflowIssue.reason === "merged" ? "merged" : "closed";
    }
    if (item.workflowIssue?.stopped) {
      return "stopped";
    }
    return item.workflowIssue?.agent ? "working" : "open";
  }
  if (item.pr !== null) {
    if (item.pr.state === "merged") {
      return "merged";
    }
    if (item.pr.state === "closed") {
      return "closed";
    }
    return item.waiting !== null && !isQuestion(item.waiting) ? "approval" : "sent";
  }
  if (item.waiting !== null && !isQuestion(item.waiting)) {
    return "approval";
  }
  if (openJob !== null && openJob.kind === "review") {
    return "review";
  }
  if (openJob !== null) {
    return "working";
  }
  if (item.drafts.some((draft) => draft.sent !== null && draft.sent.kind === "pr")) {
    return "sent";
  }
  if (item.jobs.length > 0) {
    return "stopped";
  }
  return "open";
}

// Every work item, worked out once per change of the topics it comes from.
export function useWorkItems(): Map<string, WorkItem> {
  const issues = useLive("issues");
  const jobs = useLive("jobs");
  const drafts = useLive("inbox");
  const prs = useLive("prs");
  const workflow = useLive("workflow");
  return useMemo(
    () => buildWorkItems({ issues: issues.items, jobs: jobs, drafts: drafts, prs: prs.items, workflow: workflow }),
    [issues, jobs, drafts, prs, workflow],
  );
}

export const STAGE_LABEL: Record<Stage, string> = {
  open: "Open",
  working: "In progress",
  review: "In review",
  approval: "Approval",
  sent: "Sent",
  merged: "Merged",
  closed: "Closed",
  stopped: "Stopped",
};
