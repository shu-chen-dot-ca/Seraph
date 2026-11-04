import { useState } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive } from "@/live";
import { href } from "@/routes";

/*
Ask an agent (New in the header): write to any agent (POST /api/agents/<id>/message), then land in its chat, where
it answers.
*/

export default function AskAgentDialog(props: { onClose: () => void }) {
  const agents = useLive("agents").filter((agent) => agent.archived_at === null);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [text, setText] = useState("");

  async function send() {
    await api(`/api/agents/${agentId}/message`, { method: "POST", body: { text: text.trim() } });
    window.location.hash = href.agent(agentId);
  }

  return (
    <ConfirmDialog title="Ask an agent" confirm="Send" disabled={agentId === "" || text.trim() === ""} onClose={props.onClose} onConfirm={send}>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Agent</span>
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="h-8 rounded-md border bg-background px-2">
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} · {agent.status === "idle" ? "idle" : "working"}
            </option>
          ))}
        </select>
      </label>
      <Textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="Your message" className="min-h-24" />
    </ConfirmDialog>
  );
}
