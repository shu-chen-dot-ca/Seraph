import { useState } from "react";
import { toast } from "sonner";

import DataList from "@/components/DataList";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { currentJob, since, useNow } from "@/components/ui/job-progress";
import { AGENT_TONE, StatusDot } from "@/components/ui/status-dot";
import { api, useLive, type AgentSummary } from "@/live";
import { href } from "@/routes";
import AgentChat from "@/AgentChat";

/*
Agents: every agent, what it works on and where. Opening one shows its chat (AgentChat.tsx: the conversation, its job,
its VM place and desktop). Archived agents are apart (Archived in the header); select some to archive or bring back.
*/

const STATUS_TEXT: Record<string, string> = {
  idle: "Idle",
  working: "Working",
  in_queue: "Waiting for a VM",
  in_priority: "Running something",
  using_vm: "Working",
};

export function AgentsPage() {
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const now = useNow();
  const [archived, setArchived] = useState(false);
  const rows = agents.filter((agent) => (agent.archived_at !== null) === archived);
  const archivedCount = agents.filter((agent) => agent.archived_at !== null).length;
  const doing = (agent: AgentSummary) => {
    const job = currentJob(agent.id, jobs);
    return job !== undefined ? job.headline || job.title : agent.activity;
  };

  async function each(rows: AgentSummary[], action: "archive" | "unarchive") {
    try {
      for (const row of rows) {
        await api(`/api/agents/${row.id}/${action}`, { method: "POST" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <PageHeader
        title={archived ? "Archived agents" : "Agents"}
        meta={archived ? "Stopped, their conversations kept" : `${rows.length} agents · ${rows.filter((agent) => agent.status !== "idle").length} working`}
        right={
          <Button size="sm" variant="outline" onClick={() => setArchived(!archived)}>
            {archived ? "Back to agents" : `Archived (${archivedCount})`}
          </Button>
        }
      />
      <DataList
        id={archived ? "team-archived" : "team"}
        rows={rows}
        rowId={(agent) => agent.id}
        rowHref={(agent) => href.agent(agent.id)}
        defaultSort={{ key: "active", dir: -1 }}
        empty={archived ? "No archived agents." : "No agents yet. Assigning an issue makes one."}
        search={(agent) => `${agent.name} ${doing(agent)} ${agent.vm ?? ""}`}
        chips={
          archived
            ? undefined
            : [
                { key: "working", label: "Working", test: (agent) => agent.status !== "idle" },
                { key: "idle", label: "Idle", test: (agent) => agent.status === "idle" },
              ]
        }
        columns={[
          { key: "name", label: "Name", main: true, sortValue: (agent) => agent.name, cell: (agent) => agent.name },
          {
            key: "status",
            label: "Status",
            sortValue: (agent) => agent.status,
            cell: (agent) => (
              <span className="flex items-center gap-1.5">
                <StatusDot tone={AGENT_TONE[agent.status] ?? "gray"} />
                {STATUS_TEXT[agent.status] ?? agent.status}
              </span>
            ),
          },
          { key: "doing", label: "Doing", sortValue: (agent) => doing(agent), cell: (agent) => doing(agent) },
          { key: "vm", label: "Machine", sortValue: (agent) => agent.vm ?? agent.target_vm ?? "", cell: (agent) => agent.vm ?? agent.target_vm ?? "No VM" },
          {
            key: "active",
            label: "Last active",
            time: true,
            sortValue: (agent) => agent.last_event_at ?? agent.created_at,
            cell: (agent) => `${since(agent.last_event_at ?? agent.created_at, now)} ago`,
          },
        ]}
        bulk={() => (archived ? [{ label: "Bring back", onClick: (rows) => each(rows, "unarchive") }] : [{ label: "Archive", onClick: (rows) => each(rows, "archive") }])}
      />
    </div>
  );
}

export function AgentPage(props: { id: string }) {
  return (
    <div className="h-full">
      <AgentChat key={props.id} agentId={props.id} />
    </div>
  );
}
