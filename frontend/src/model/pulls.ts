/*
Your pull requests, from every project, for the Dashboard's cards: one row per work item (model/work.ts) that has a
pull request of yours, or one an agent is still making.

- in-progress: not on GitHub yet. An agent still writes it, a reviewer agent checks it, or it waits for your Approve;
  and a private project's kept in Seraph.
- open: open on GitHub. Yours on other people's projects (sent from the Dashboard or by hand), and a private project's
  that went to GitHub.
- merged, and closed without a merge.

Ones you only commented on aren't yours, so they aren't here.
*/

import type { TrackedPR, WorkflowPR } from "@/live";
import { OPEN_JOB, STAGE_LABEL, type WorkItem } from "@/model/work";

export type PullGroup = "in-progress" | "open" | "merged" | "closed";

export type PullRow = {
  item: WorkItem;
  group: PullGroup;
  number: number | null; // its number on GitHub
  url: string | null;
  tracked: TrackedPR | null; // how it stands on GitHub, for yours on other people's projects
  workflowPR: WorkflowPR | null; // a private project's newest
  issueUrl: string | null;
  agents: string[]; // the one in charge first, then one working on it now
  vm: string | null;
  state: string;
};

export function pullRows(items: Map<string, WorkItem>): PullRow[] {
  const rows: PullRow[] = [];
  for (const item of items.values()) {
    const tracked = item.pr !== null && item.pr.relation === "author" ? item.pr : null;
    const workflowPR = item.workflowPRs[item.workflowPRs.length - 1] ?? null;
    const fixJobs = item.jobs.filter((job) => job.kind === "fix_issue");
    const fixJob = fixJobs[fixJobs.length - 1] ?? null;
    const openJob = item.job !== null && OPEN_JOB.includes(item.job.status) ? item.job : null;
    const beingMade = item.workflowIssue !== null || fixJob !== null;
    const notSentStage = item.stage === "working" || item.stage === "review" || item.stage === "approval";

    let group: PullGroup | null = null;
    let number: number | null = null;
    let url: string | null = null;
    if (tracked !== null) {
      group = tracked.state;
      number = tracked.number;
      url = tracked.url;
    } else if (workflowPR !== null && (workflowPR.state === "rejected" || workflowPR.state === "closed") && beingMade && notSentStage) {
      // Rejected, and an agent tries again.
      group = "in-progress";
    } else if (workflowPR !== null) {
      number = workflowPR.github;
      url = workflowPR.url;
      if (workflowPR.state === "merged") {
        group = "merged";
      } else if (workflowPR.state === "rejected" || workflowPR.state === "closed") {
        group = "closed";
      } else if (url !== null) {
        group = "open";
      } else {
        group = "in-progress";
      }
    } else if (item.pr === null && item.stage === "sent") {
      // Sent from the Dashboard a moment ago, before the app read it back from GitHub.
      group = "open";
      for (const draft of item.drafts) {
        if (draft.sent !== null && draft.sent.kind === "pr") {
          number = draft.sent.number;
          url = draft.sent.url;
        }
      }
    } else if (beingMade && notSentStage) {
      group = "in-progress";
    }
    if (group === null) {
      continue;
    }

    let issueUrl = item.issue?.html_url ?? item.workflowIssue?.url ?? null;
    if (issueUrl === null && item.workflow === null && item.number !== number) {
      issueUrl = `https://github.com/${item.repo}/issues/${item.number}`;
    }

    // In charge: the agent that follows the pull request on GitHub, else the one that wrote it.
    let owner = item.workflowIssue?.agent ?? fixJob?.agent ?? item.agent;
    if (tracked !== null && tracked.agent_mode === "drafts" && tracked.agent !== null) {
      owner = tracked.agent;
    }
    const agents: string[] = [];
    if (owner !== null) {
      agents.push(owner);
    }
    if (openJob !== null && openJob.agent !== owner) {
      agents.push(openJob.agent);
    }

    const parts: string[] = [];
    if (group === "in-progress" && item.waiting === null && item.waitingPR === null) {
      parts.push(STAGE_LABEL[item.stage]);
    }
    if (group === "open" && tracked !== null) {
      if (tracked.draft) {
        parts.push("Draft");
      }
      if (tracked.checks !== "none") {
        parts.push(`checks ${tracked.checks}`);
      }
      if (tracked.review !== "none") {
        parts.push(tracked.review.replace("_", " "));
      }
      if (tracked.mergeable === "conflicts") {
        parts.push("conflicts");
      }
    }
    if (group === "open" && workflowPR !== null) {
      if (workflowPR.state === "review") {
        parts.push("In review");
      }
      if (workflowPR.checks !== null && workflowPR.checks !== "none") {
        parts.push(`checks ${workflowPR.checks}`);
      }
    }
    if (group === "merged" && tracked !== null && tracked.merged_by !== null) {
      parts.push(`merged by @${tracked.merged_by}`);
    }
    if ((group === "merged" || group === "closed") && tracked === null && workflowPR?.decision) {
      parts.push(`${workflowPR.decision.action === "merge" ? "merged" : "rejected"} by ${workflowPR.decision.by === "you" ? "you" : "the agent"}`);
    }
    if (openJob !== null && openJob.headline !== "") {
      parts.push(openJob.headline);
    }

    rows.push({
      item: item,
      group: group,
      number: number,
      url: url,
      tracked: tracked,
      workflowPR: workflowPR,
      issueUrl: issueUrl,
      agents: agents,
      // A done one's machine has moved on to other work.
      vm: group === "merged" || group === "closed" ? null : (openJob?.vm ?? fixJob?.vm ?? item.workflow?.vm ?? null),
      state: parts.join(" · "),
    });
  }
  return rows;
}
