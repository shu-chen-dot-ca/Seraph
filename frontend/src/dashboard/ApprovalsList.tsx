import { useState } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import DataList from "@/components/DataList";
import { Badge } from "@/components/ui/badge";
import { since, useNow } from "@/components/ui/job-progress";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive } from "@/live";
import { useSending } from "@/model/account";
import type { Approval } from "@/model/inbox";
import { keyOf } from "@/model/work";
import { href } from "@/routes";

/*
The Dashboard's Approvals: things to send or merge, each the same way, so you can select several and Approve or
Reject them at once (one "Are you sure?" for all). A question or draft opens on its own page, a Workflow pull request
on its issue's page, where its Merge is.
*/

function approvalHref(approval: Approval): string {
  if (approval.workflow !== null) {
    return href.work(approval.workflow.repo.repo, approval.workflow.pr.issue ?? approval.workflow.pr.number);
  }
  return href.inboxItem(approval.id);
}

export default function ApprovalsList(props: { approvals: Approval[] }) {
  const agents = useLive("agents");
  const now = useNow();
  const sending = useSending();
  const [approving, setApproving] = useState<Approval[]>([]);
  const [rejecting, setRejecting] = useState<Approval[]>([]);
  const [reason, setReason] = useState("");
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

  return (
    <>
      <DataList
        id="inbox-approvals"
        rows={props.approvals}
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
          {
            key: "kind",
            label: "Kind",
            sortValue: (approval) => approval.kind,
            cell: (approval) => <Badge variant={sending.draft === approval.id ? "warn" : "default"}>{sending.draft === approval.id ? "Sending" : approval.kind}</Badge>,
          },
          {
            key: "project",
            label: "Project",
            sortValue: (approval) => approval.repo,
            cell: (approval) => (approval.draft !== null ? (keyOf(approval.draft.target) ?? approval.repo) : approval.repo),
          },
          { key: "agent", label: "From", sortValue: (approval) => agentName(approval.agent), cell: (approval) => agentName(approval.agent) },
          { key: "waiting", label: "Waiting", time: true, sortValue: (approval) => approval.at, cell: (approval) => `${since(approval.at, now)} ago` },
        ]}
        bulk={() => [
          { label: "Approve", primary: true, onClick: (rows) => setApproving(rows) },
          { label: "Reject", onClick: (rows) => setRejecting(rows) },
        ]}
      />

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
    </>
  );
}
