/*
A work item's timeline: what happened, who did it and when, oldest first, as one list. Built from the times the
parts keep:

- jobs: their own timeline (job_progress steps, status changes, test runs, notices the app sent the agent), or for
  jobs from before it, when they were made, their current step, their test runs and how they ended;
- the proof agents took (screenshots and commands), when they took it;
- drafts: when the agent wrote them, the reviewer's verdict, your decision (or the timer's), and what went to GitHub;
- the pull request on GitHub: reviews, the last comment, merged or closed;
- a Workflow issue and its pull requests: opened, reviewed, merged or rejected.

`who` is "you", "app" (Seraph itself), an agent id, or "@login" for someone on GitHub.
*/

import type { Draft, EvidenceItem, Job } from "@/live";
import type { WorkItem } from "@/model/work";

export type TimelineEvent = {
  at: string;
  who: string;
  text: string;
  draft?: string; // a draft to open (a question or approval)
  url?: string; // something on GitHub
  shots?: EvidenceItem[]; // screenshots or pictures to show
  output?: string; // a command's last lines, folded
};

const DRAFT_TEXT: Record<string, string> = {
  pr: "Wrote a fix for your approval",
  comment: "Wrote a comment for your approval",
  edit: "Wrote a new title and description for your approval",
  action: "Asked you to approve a change on GitHub",
  question: "Asked you",
  taken: "The issue was taken by someone else",
};

function jobEvents(job: Job): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (job.timeline.length > 0) {
    // The agent's own steps and test runs are its; what the app wrote (assigned, stopped, told) is Seraph's.
    for (const entry of job.timeline) {
      const who = entry.kind === "step" || entry.kind === "tests" ? job.agent : "app";
      events.push({ at: entry.at, who: who, text: entry.text });
    }
  } else {
    if (job.created_by === "user") {
      events.push({ at: job.created_at, who: "you", text: job.kind === "fix_issue" ? "Assigned it" : job.title });
    } else {
      events.push({ at: job.created_at, who: job.agent, text: job.kind === "review" ? "Started reviewing it" : "Started on it" });
    }
    if (job.step_at !== null && job.headline !== "") {
      events.push({ at: job.step_at, who: job.agent, text: job.headline });
    }
    for (const run of [job.tests.before, job.tests.after]) {
      if (run === null) {
        continue;
      }
      const when = run === job.tests.before ? "on the code before the change" : "with the change";
      events.push({ at: run.at, who: job.agent, text: `Ran the project's own tests ${when}: ${run.passed ? "they pass" : "they fail"}` });
    }
    if (job.status === "done" || job.status === "cancelled") {
      events.push({ at: job.updated_at, who: job.agent, text: job.status === "done" ? "Finished" : "Stopped" });
    }
  }
  for (const evidence of job.evidence) {
    if (evidence.kind === "command") {
      events.push({ at: evidence.created_at, who: job.agent, text: evidence.caption, output: evidence.output_tail });
    } else {
      events.push({ at: evidence.created_at, who: job.agent, text: evidence.caption, shots: [evidence] });
    }
  }
  return events;
}

function draftEvents(draft: Draft): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let text = DRAFT_TEXT[draft.kind] ?? draft.kind;
  if (draft.kind === "pr" && draft.update_of !== null) {
    text = "Wrote a new version of the pull request for your approval";
  }
  if (draft.kind === "question") {
    text = `Asked you: ${draft.title}`;
  }
  if (draft.kind === "action") {
    text = `Asked you to approve: ${draft.title}`;
  }
  events.push({ at: draft.created_at, who: draft.agent, text: text, draft: draft.id });
  if (draft.review !== null && draft.review.agent !== null && draft.review.state !== "waiting") {
    const verdict = draft.review.state === "passed" ? "Reviewed it: send" : "Reviewed it and asked for changes";
    events.push({ at: draft.review.at, who: draft.review.agent, text: verdict });
  }
  if (draft.decided_at !== null && draft.status !== "pending") {
    const by = draft.answered_by === "timer" ? "app" : "you";
    let decision = "Approved it";
    if (draft.status === "rejected") {
      decision = draft.reply !== "" ? `Rejected it: “${draft.reply}”` : "Rejected it";
    }
    if (draft.status === "replied") {
      decision = draft.kind === "question" ? `Answered: ${draft.reply.replace(/^I pick:\s*/, "")}` : `Asked for another try: “${draft.reply}”`;
    }
    if (draft.answered_by === "timer") {
      decision = `No answer in time, so the agent went ahead with “${draft.recommended ?? ""}”`;
    }
    events.push({ at: draft.decided_at, who: by, text: decision });
  }
  if (draft.sent !== null) {
    let sent = `Sent as pull request #${draft.sent.number}`;
    if (draft.sent.kind === "comment") {
      sent = "Posted the comment";
    }
    if (draft.sent.kind === "edit") {
      sent = "Changed the title and description";
    }
    if (draft.sent.kind === "action") {
      sent = `Done on GitHub: ${draft.title}`;
    }
    if (draft.sent.update) {
      sent = `Added the new version to #${draft.sent.number}`;
    }
    events.push({ at: draft.sent.at, who: "you", text: sent, url: draft.sent.url });
  }
  return events;
}

export function buildTimeline(item: WorkItem): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (item.workflowIssue !== null) {
    const issue = item.workflowIssue;
    const by = issue.by === "you" ? "you" : issue.by === "github" ? "app" : issue.by;
    events.push({ at: issue.created_at, who: by, text: issue.by === "github" ? "Opened on GitHub" : "Opened the issue", url: issue.url ?? undefined });
  }
  for (const job of item.jobs) {
    events.push(...jobEvents(job));
  }
  for (const draft of item.drafts) {
    events.push(...draftEvents(draft));
  }
  for (const pr of item.workflowPRs) {
    events.push({ at: pr.created_at, who: pr.agent ?? "you", text: `Opened pull request #${pr.number}`, url: pr.url ?? undefined });
    if (pr.review !== null && pr.review.advice !== null) {
      const advice = pr.review.advice === "merge" ? "Reviewed it: merge" : "Reviewed it: don't merge";
      events.push({ at: pr.review.at, who: pr.review.agent, text: `${advice}. ${pr.review.summary}`, shots: pr.review.evidence.filter((each) => each.file !== null) });
    }
    if (pr.decision !== null) {
      const by = pr.decision.by === "you" ? "you" : (item.workflow?.reviewer ?? "app");
      const what = pr.decision.action === "merge" ? "Merged it" : `Rejected it${pr.decision.reason !== "" ? `: “${pr.decision.reason}”` : ""}`;
      events.push({ at: pr.decision.at, who: by, text: what });
    }
  }
  if (item.pr !== null) {
    const pr = item.pr;
    for (const reviewer of pr.reviewers) {
      let what = "Commented on it";
      if (reviewer.state === "APPROVED") {
        what = "Approved it";
      }
      if (reviewer.state === "CHANGES_REQUESTED") {
        what = "Asked for changes";
      }
      events.push({ at: reviewer.at, who: `@${reviewer.login}`, text: what, url: pr.url });
    }
    if (pr.last_comment !== null) {
      events.push({ at: pr.last_comment.at, who: `@${pr.last_comment.login}`, text: `“${pr.last_comment.text}”`, url: pr.url });
    }
    if (pr.state !== "open" && pr.closed_at !== null) {
      const who = pr.merged_by !== null ? `@${pr.merged_by}` : "app";
      events.push({ at: pr.closed_at, who: who, text: pr.state === "merged" ? "Merged it" : "Closed it", url: pr.url });
    }
  }
  return events.filter((event) => event.at !== "").sort((a, b) => a.at.localeCompare(b.at));
}

// A job that isn't on an issue (a task, a repo's set-up): its own events and its drafts'.
export function buildJobTimeline(job: Job, drafts: Draft[]): TimelineEvent[] {
  const events = jobEvents(job);
  for (const draft of drafts) {
    events.push(...draftEvents(draft));
  }
  return events.filter((event) => event.at !== "").sort((a, b) => a.at.localeCompare(b.at));
}
