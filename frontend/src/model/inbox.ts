/*
The Inbox: what agents need from you, in two kinds, so each works one way.

- Questions: an agent asked you something (an Inbox draft of kind question; old "taken" items too). Some have a timer
  (answer_by: then the app answers with the agent's recommended choice); the rest wait for you however long it takes
  (must_wait says why).
- Approvals: only things to send or merge: a pull request (new, a new version, a rebase), a comment, a new title and
  description, an action on your own PR or issue (request a review, ready for review, close, ...), and a Workflow pull
  request that waits for your Merge. Approve works the same on each.

ask is what the agent needs, as a plain question, the first thing you read.
*/

import { useMemo } from "react";

import { useLive, type Draft, type WorkflowPR, type WorkflowRepo } from "@/live";
import { isQuestion } from "@/model/work";

export type Approval = {
  id: string; // the draft's id, or "workflow:owner/name#n"
  ask: string;
  kind: string; // Fix, New version, Comment, Reply, Edit, an action's name (Review request, Close, ...), Merge
  repo: string;
  agent: string | null;
  at: string;
  draft: Draft | null;
  workflow: { repo: WorkflowRepo; pr: WorkflowPR } | null;
};

// An action draft, as GitHub names its buttons.
const ACTION_KINDS: Record<string, string> = {
  request_review: "Review request",
  ready_for_review: "Ready for review",
  convert_to_draft: "Convert to draft",
  allow_maintainer_edits: "Maintainer edits",
  update_branch: "Update branch",
  resolve: "Resolve",
  close: "Close",
  reopen: "Reopen",
};

// The repo's short name: "owner/name" → "name".
function shortName(repo: string | null): string {
  return (repo ?? "").split("/").pop() ?? "";
}

export function askOf(draft: Draft): string {
  const name = shortName(draft.repo ?? draft.target);
  const target = (draft.update_of ?? draft.target ?? "").split("#")[1];
  if (isQuestion(draft) && draft.kind === "taken") {
    return `Someone else took ${draft.target ?? "this issue"}. Keep working?`;
  }
  if (isQuestion(draft)) {
    return draft.title;
  }
  if (draft.kind === "comment" && draft.reply_to !== null) {
    return `Post this reply in a review conversation on ${name}${target ? ` #${target}` : ""}?`;
  }
  if (draft.kind === "comment") {
    return `Post this comment on ${name}${target ? ` #${target}` : ""}?`;
  }
  if (draft.kind === "edit") {
    return `Change the title and description of ${name}${target ? ` #${target}` : ""}?`;
  }
  if (draft.kind === "action" && draft.action !== null) {
    const where = `${name} #${target}`;
    const action = draft.action;
    if (action.name === "request_review") {
      return `Ask ${action.reviewers.map((login) => `@${login}`).join(", ")} to review ${where}?`;
    }
    if (action.name === "ready_for_review") {
      return `Mark ${where} ready for review?`;
    }
    if (action.name === "convert_to_draft") {
      return `Convert ${where} to a draft?`;
    }
    if (action.name === "allow_maintainer_edits") {
      return `Let the maintainers edit ${where}?`;
    }
    if (action.name === "update_branch") {
      return `Update the branch of ${where}?`;
    }
    if (action.name === "resolve") {
      return action.conversations.length === 1 ? `Resolve a conversation on ${where}?` : `Resolve ${action.conversations.length} conversations on ${where}?`;
    }
    if (action.name === "close") {
      return `Close ${where}?`;
    }
    return `Reopen ${where}?`;
  }
  if (draft.rebase_of !== null) {
    return `Send the rebased version of ${name} #${target}?`;
  }
  if (draft.update_of !== null) {
    return `Send the new version of ${name} #${target}?`;
  }
  return `Send this fix to ${name}?`;
}

export function kindOf(draft: Draft): string {
  if (draft.kind === "comment" && draft.reply_to !== null) {
    return "Reply";
  }
  if (draft.kind === "comment") {
    return "Comment";
  }
  if (draft.kind === "action") {
    return ACTION_KINDS[draft.action?.name ?? ""] ?? "Action";
  }
  if (draft.kind === "edit") {
    return "Edit";
  }
  if (draft.update_of !== null) {
    return "New version";
  }
  return "Fix";
}

export function useInbox(): { questions: Draft[]; approvals: Approval[] } {
  const drafts = useLive("inbox");
  const workflow = useLive("workflow");
  return useMemo(() => {
    const pending = drafts.filter((draft) => draft.status === "pending");
    const questions = pending.filter((draft) => isQuestion(draft));
    const approvals: Approval[] = pending
      .filter((draft) => !isQuestion(draft))
      .map((draft) => ({
        id: draft.id,
        ask: askOf(draft),
        kind: kindOf(draft),
        repo: draft.repo ?? "",
        agent: draft.agent,
        at: draft.created_at,
        draft: draft,
        workflow: null,
      }));
    for (const repo of workflow) {
      if (repo.decides !== "you") {
        continue;
      }
      for (const pr of Object.values(repo.prs)) {
        if (pr.state !== "waiting") {
          continue;
        }
        approvals.push({
          id: `workflow:${repo.repo}#${pr.number}`,
          ask: `Merge “${pr.title}” into ${shortName(repo.repo)}?`,
          kind: "Merge",
          repo: repo.repo,
          agent: pr.agent,
          at: pr.at,
          draft: null,
          workflow: { repo: repo, pr: pr },
        });
      }
    }
    return { questions: questions, approvals: approvals };
  }, [drafts, workflow]);
}
