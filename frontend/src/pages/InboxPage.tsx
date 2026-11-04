import { useState } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import DataList from "@/components/DataList";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { useNow } from "@/components/ui/job-progress";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Draft } from "@/live";
import { cn } from "@/lib/utils";
import { useInbox, type Approval } from "@/model/inbox";
import { keyOf } from "@/model/work";
import { href } from "@/routes";

/*
The Inbox: what agents need from you, in two tabs.
- Questions: an agent asked you something. The ones with a timer say when the agent goes ahead with its recommended
  choice; the others wait for you. Answered one at a time, on the question's page.
- Approvals: things to send or merge, each the same way, so you can select several and Approve or Reject them at
  once (one "Are you sure?" for all). A Workflow pull request opens on its issue's page, where its Merge is.
It opens on Questions while any question waits.
*/

const MUST_WAIT_TEXT: Record<string, string> = {
  money: "it costs money",
  sensitive: "a sensitive subject",
  github: "what gets sent to GitHub",
  delete: "deleting something",
  open: "an open question",
};

export function questionWhen(draft: Draft, now: number): string {
  if (draft.answer_by) {
    const minutes = Math.max(0, Math.ceil((new Date(draft.answer_by).getTime() - now) / 60000));
    return minutes === 0 ? "Goes ahead now" : `Goes ahead in ${minutes} min`;
  }
  if (draft.must_wait) {
    return `Waits for you · ${MUST_WAIT_TEXT[draft.must_wait] ?? draft.must_wait}`;
  }
  return "Waits for you";
}

function age(iso: string, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 60) {
    return `${Math.max(minutes, 0)} min`;
  }
  if (minutes < 60 * 24) {
    return `${Math.floor(minutes / 60)} h`;
  }
  return `${Math.floor(minutes / 60 / 24)} d`;
}

// Where a row opens: a question or a draft on its own page, a Workflow pull request on its issue's page.
function approvalHref(approval: Approval): string {
  if (approval.workflow !== null) {
    return href.work(approval.workflow.repo.repo, approval.workflow.pr.issue ?? approval.workflow.pr.number);
  }
  return href.inboxItem(approval.id);
}

export default function InboxPage(props: { tab: "questions" | "approvals" | null }) {
  const { questions, approvals } = useInbox();
  const agents = useLive("agents");
  const now = useNow();
  const [approving, setApproving] = useState<Approval[]>([]);
  const [rejecting, setRejecting] = useState<Approval[]>([]);
  const [reason, setReason] = useState("");
  const tab = props.tab ?? (questions.length > 0 ? "questions" : "approvals");
  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? id ?? "";

  async function decideAll(rows: Approval[], action: "approve" | "reject") {
    for (const row of rows) {
      if (row.workflow !== null) {
        const path = `/api/workflow/${row.workflow.repo.repo}/pulls/${row.workflow.pr.number}`;
        await api(action === "approve" ? `${path}/merge` : `${path}/reject`, { method: "POST", body: action === "approve" ? undefined : { reason: reason, close_issue: false } });
        continue;
      }
      if (action === "approve") {
        await api(`/api/inbox/${row.id}/approve`, { method: "POST", body: { send: true } });
      } else {
        await api(`/api/inbox/${row.id}/reject`, { method: "POST", body: { text: reason } });
      }
    }
    toast.success(action === "approve" ? `Approved ${rows.length}.` : `Rejected ${rows.length}.`);
  }

  const tabs = [
    { key: "questions" as const, label: "Questions", count: questions.length, warn: true },
    { key: "approvals" as const, label: "Approvals", count: approvals.length, warn: false },
  ];

  return (
    <div>
      <PageHeader title="Inbox" meta={tab === "questions" ? "Agents asked you these." : "Nothing is sent until you approve."} />
      <div className="flex gap-1 border-b px-3">
        {tabs.map((each) => (
          <a
            key={each.key}
            href={href.inbox(each.key)}
            className={cn(
              "relative flex items-center gap-1.5 px-2 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground",
              tab === each.key && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
            )}
          >
            {each.label}
            {each.count > 0 && (
              <span
                className={cn(
                  "min-w-4.5 rounded-full px-1.5 text-center text-xs leading-4.5 tabular-nums",
                  each.warn ? "bg-warn text-background" : "bg-primary text-primary-foreground",
                )}
              >
                {each.count}
              </span>
            )}
          </a>
        ))}
      </div>

      {tab === "questions" && (
        <DataList
          id="inbox-questions"
          rows={questions}
          rowId={(draft) => draft.id}
          rowHref={(draft) => href.inboxItem(draft.id)}
          defaultSort={{ key: "asked", dir: -1 }}
          empty="No questions. No agent is waiting on you."
          search={(draft) => `${draft.title} ${draft.repo ?? ""} ${agentName(draft.agent)}`}
          columns={[
            { key: "ask", label: "Question", main: true, sortValue: (draft) => draft.title, cell: (draft) => draft.title },
            {
              key: "when",
              label: "Goes ahead",
              sortValue: (draft) => draft.answer_by ?? "z",
              cell: (draft) => <Badge variant={draft.answer_by ? "secondary" : "warn"}>{questionWhen(draft, now)}</Badge>,
            },
            { key: "agent", label: "Agent", sortValue: (draft) => agentName(draft.agent), cell: (draft) => agentName(draft.agent) },
            { key: "project", label: "Project", sortValue: (draft) => draft.target ?? draft.repo ?? "", cell: (draft) => draft.target ?? draft.repo ?? "" },
            { key: "asked", label: "Asked", time: true, sortValue: (draft) => draft.created_at, cell: (draft) => age(draft.created_at, now) },
          ]}
          bulk={() => []}
        />
      )}

      {tab === "approvals" && (
        <DataList
          id="inbox-approvals"
          rows={approvals}
          rowId={(approval) => approval.id}
          rowHref={approvalHref}
          defaultSort={{ key: "waiting", dir: -1 }}
          empty="Nothing to approve."
          search={(approval) => `${approval.ask} ${approval.repo} ${agentName(approval.agent)}`}
          chips={[
            { key: "send", label: "Send", test: (approval) => approval.kind !== "Merge" },
            { key: "merge", label: "Merge", test: (approval) => approval.kind === "Merge" },
          ]}
          columns={[
            { key: "ask", label: "Approval", main: true, sortValue: (approval) => approval.ask, cell: (approval) => approval.ask },
            { key: "kind", label: "Kind", sortValue: (approval) => approval.kind, cell: (approval) => <Badge>{approval.kind}</Badge> },
            {
              key: "project",
              label: "Project",
              sortValue: (approval) => approval.repo,
              cell: (approval) => (approval.draft !== null ? (keyOf(approval.draft.target) ?? approval.repo) : approval.repo),
            },
            { key: "agent", label: "From", sortValue: (approval) => agentName(approval.agent), cell: (approval) => agentName(approval.agent) },
            { key: "waiting", label: "Waiting", time: true, sortValue: (approval) => approval.at, cell: (approval) => age(approval.at, now) },
          ]}
          bulk={() => [
            { label: "Approve", primary: true, onClick: (rows) => setApproving(rows) },
            { label: "Reject", onClick: (rows) => setRejecting(rows) },
          ]}
        />
      )}

      {approving.length > 0 && (
        <ConfirmDialog
          title={`Approve ${approving.length} ${approving.length === 1 ? "item" : "items"}?`}
          confirm="Approve all"
          onClose={() => setApproving([])}
          onConfirm={() => decideAll(approving, "approve")}
        >
          <p className="text-muted-foreground">Each one is sent to GitHub as you, or merged, right away.</p>
          <ul className="flex max-h-60 flex-col gap-1 overflow-auto">
            {approving.map((approval) => (
              <li key={approval.id} className="rounded-md border px-3 py-1.5">
                {approval.ask}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      {rejecting.length > 0 && (
        <ConfirmDialog
          title={`Reject ${rejecting.length} ${rejecting.length === 1 ? "item" : "items"}?`}
          confirm="Reject"
          danger
          onClose={() => {
            setRejecting([]);
            setReason("");
          }}
          onConfirm={async () => {
            await decideAll(rejecting, "reject");
            setReason("");
          }}
        >
          <p className="text-muted-foreground">Nothing is sent. Each agent is told, with your note.</p>
          <Textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why? (optional, the agents read it)" />
        </ConfirmDialog>
      )}
    </div>
  );
}
