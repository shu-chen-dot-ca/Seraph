import type { ReactNode } from "react";

import { DRAFT_BY_ID, WORK_BY_ID } from "@/data";

/*
Every page lives in the URL hash, like the real app, so back, forward and reload work and every thing has its own
address. #/ is the round's page; the mock app is everything else:
  #/questions[/d3]  #/approvals[/d1]  (the Inbox's two tabs, and one question or approval)  #/notifications
  #/projects (the list, for the phone)  #/p/tabularis  #/p/tabularis/w1 (a work item)  #/p/tabularis/i1 (an open issue)
  #/team[/mpl-2]  #/machines[/vm1[/1]] (a VM, and one of its desktops)  #/settings
An issue, its job and its pull request are one work item, so links to any of them open that one page.
*/

export function href(kind: string, id: string): string {
  if (kind === "draft") {
    return DRAFT_BY_ID[id].group === "question" ? `#/questions/${id}` : `#/approvals/${id}`;
  }
  if (kind === "agent") {
    return `#/team/${id}`;
  }
  if (kind === "vm") {
    return `#/machines/${id}`;
  }
  if (kind === "project") {
    return `#/p/${id}`;
  }
  return `#/p/${WORK_BY_ID[id].short}/${id}`;
}

// A name that opens its page. Every agent, issue, pull request, job and VM named on a page is one of these.
export function Go(props: { kind: string; id: string; children: ReactNode }) {
  return (
    <a href={href(props.kind, props.id)} className="text-primary hover:underline">
      {props.children}
    </a>
  );
}

// A short message at the bottom (App shows it), saying what just happened.
export function toast(text: string) {
  window.dispatchEvent(new CustomEvent("toast", { detail: text }));
}
