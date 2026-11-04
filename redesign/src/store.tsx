import { createContext, useContext } from "react";

import { DRAFT_BY_ID, DRAFTS, OPEN_ISSUES, PROJECTS, type Draft, type OpenIssue, type Project, type Work } from "@/data";

/*
What you did while playing with the mockup, kept in memory only: a reload, or Reset in the top bar, starts over.
There is no real logic behind it. It only changes what the pages show, so each flow can be followed to its end:
an approved fix shows as sent, an assigned issue moves to In progress, an added project shows in the left list.
*/

export type Store = {
  // A question or approval you handled: what you did, and your answer or reason.
  done: Record<string, { what: "approved" | "rejected" | "answered"; text: string }>;
  // An open issue you assigned: to whom, on which machine.
  assigned: Record<string, { agent: string; vm: string }>;
  // Issues you made and projects you added.
  issues: OpenIssue[];
  projects: Project[];
  // Notifications you read.
  read: string[];
  // Messages you sent each agent.
  messages: Record<string, string[]>;
  // Work you stopped.
  stopped: string[];
};

export const EMPTY_STORE: Store = { done: {}, assigned: {}, issues: [], projects: [], read: [], messages: {}, stopped: [] };

export const StoreContext = createContext<{ store: Store; update: (change: (store: Store) => Store) => void }>({
  store: EMPTY_STORE,
  update: () => {},
});

export function useStore() {
  return useContext(StoreContext);
}

// The questions or approvals still waiting for you.
export function openDrafts(store: Store, group: Draft["group"]) {
  return DRAFTS.filter((draft) => draft.group === group && !store.done[draft.id]);
}

export function allProjects(store: Store) {
  return [...PROJECTS, ...store.projects];
}

export function allIssues(store: Store) {
  return [...OPEN_ISSUES, ...store.issues];
}

// The pull request number a fix gets when you approve it here.
const NEW_PR: Record<string, number> = { w1: 1410, w13: 1640 };

// A work item as it is after what you did: stopped, approved, rejected or answered.
export function workNow(work: Work, store: Store): Work {
  if (store.stopped.includes(work.id)) {
    return {
      ...work,
      stage: "cancelled",
      step: "Stopped by you",
      draft: null,
      timeline: [...work.timeline, { time: "just now", who: "you", text: "Stopped it. What was done so far is kept here." }],
    };
  }
  const done = work.draft ? store.done[work.draft] : undefined;
  if (!work.draft || !done) {
    return work;
  }
  const draft = DRAFT_BY_ID[work.draft];
  if (done.what === "rejected") {
    return {
      ...work,
      stage: "working",
      step: "Trying again with your note",
      draft: null,
      timeline: [
        ...work.timeline,
        { time: "just now", who: "you", text: `Rejected it: “${done.text}”` },
        { time: "now", who: work.agent, text: "Trying again with your note.", live: true },
      ],
    };
  }
  if (done.what === "answered") {
    return {
      ...work,
      step: `Carrying on: ${done.text}`,
      draft: null,
      timeline: [
        ...work.timeline,
        { time: "just now", who: "you", text: `Answered: ${done.text}` },
        { time: "now", who: work.agent, text: "Carrying on.", live: true },
      ],
    };
  }
  if (draft.kind === "Merge") {
    return {
      ...work,
      stage: "merged",
      step: "Merged by you",
      draft: null,
      timeline: [...work.timeline, { time: "just now", who: "you", text: `Approved. Merged into ${work.short}.` }],
    };
  }
  if (draft.kind === "Reply") {
    return {
      ...work,
      step: "Reply posted; waiting for the maintainer",
      draft: null,
      sent: `Sent by you on Oct 30 as pull request #${work.pr}. Your reply and the updated fix were posted just now.`,
      timeline: [...work.timeline, { time: "just now", who: "you", text: `Approved. Posted the reply and the updated fix on #${work.pr}.` }],
    };
  }
  const pr = NEW_PR[work.id] ?? 1000;
  return {
    ...work,
    stage: "sent",
    pr,
    step: "Sent; waiting for a maintainer",
    draft: null,
    sent: `Sent by you just now as pull request #${pr}.`,
    timeline: [...work.timeline, { time: "just now", who: "you", text: `Approved. Sent as pull request #${pr}.` }],
  };
}
