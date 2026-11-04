import { useState } from "react";

import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import DataList from "@/DataList";
import PageHeader from "@/PageHeader";
import { AGENTS, WORK_BY_ID } from "@/data";
import { Go, href, toast } from "@/links";
import { allIssues, useStore } from "@/store";

/*
Team: every agent, what it works on and where. An agent's page shows its current work, its machine, what it did
lately, and its chat, where what you write shows right away. An agent you just made by assigning an issue has a
page too, starting.
*/

const TONE = { Working: "green", Idle: "gray", "In queue": "amber", Paused: "amber" } as const;

export function TeamList() {
  const rows = Object.keys(AGENTS);
  return (
    <div>
      <PageHeader
        title="Team"
        meta={`${rows.length} agents · ${rows.filter((id) => AGENTS[id].status === "Working").length} working`}
        right={
          <Button size="sm" variant="outline" onClick={() => toast("Agents are made when you assign an issue to New agent.")}>
            New agent
          </Button>
        }
      />
      <DataList
        id="team"
        rows={rows}
        rowId={(id) => id}
        rowHref={(id) => href("agent", id)}
        defaultSort={{ key: "status", dir: 1 }}
        empty="No agents yet."
        search={(id) => `${id} ${AGENTS[id].note} ${WORK_BY_ID[AGENTS[id].work].ref}`}
        chips={[
          { key: "working", label: "Working", test: (id) => AGENTS[id].status === "Working" },
          { key: "waiting", label: "Waiting", test: (id) => AGENTS[id].status === "In queue" || AGENTS[id].status === "Paused" },
          { key: "idle", label: "Idle", test: (id) => AGENTS[id].status === "Idle" },
        ]}
        columns={[
          { key: "name", label: "Name", main: true, sortValue: (id) => id, cell: (id) => id },
          {
            key: "status",
            label: "Status",
            sortValue: (id) => ["Working", "Paused", "In queue", "Idle"].indexOf(AGENTS[id].status),
            cell: (id) => (
              <span className="flex items-center gap-1.5">
                <StatusDot tone={TONE[AGENTS[id].status]} />
                {AGENTS[id].status}
              </span>
            ),
          },
          { key: "doing", label: "Doing", sortValue: (id) => AGENTS[id].note, cell: (id) => `${AGENTS[id].note} · ${WORK_BY_ID[AGENTS[id].work].ref}` },
          { key: "vm", label: "Machine", sortValue: (id) => AGENTS[id].vm ?? "", cell: (id) => AGENTS[id].vm ?? "No VM" },
        ]}
        bulk={() => [{ label: "Archive", onClick: (ids) => toast(`Archived ${ids.length}. Their history is kept.`) }]}
      />
    </div>
  );
}

function Chat(props: { agent: string; first: string }) {
  const { store, update } = useStore();
  const [text, setText] = useState("");
  const sent = store.messages[props.agent] ?? [];

  function send() {
    if (text.trim() === "") {
      return;
    }
    update((before) => ({ ...before, messages: { ...before.messages, [props.agent]: [...(before.messages[props.agent] ?? []), text.trim()] } }));
    setText("");
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="max-w-[85%] rounded-xl bg-muted px-3 py-1.5">{props.first}</div>
      {sent.map((message, index) => (
        <div key={index} className="max-w-[85%] self-end rounded-xl bg-selected px-3 py-1.5">
          {message}
        </div>
      ))}
      {sent.length > 0 && <div className="text-xs text-muted-foreground">{props.agent} answers here.</div>}
      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send()}
          placeholder={`Message ${props.agent}`}
          aria-label="Message"
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 outline-none focus-visible:border-ring"
        />
        <Button size="sm" onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

export function AgentPage(props: { id: string }) {
  const { store } = useStore();
  const agent = AGENTS[props.id];

  // An agent made just now by assigning an issue to New agent.
  if (!agent) {
    const issueId = Object.keys(store.assigned).find((id) => store.assigned[id].agent === props.id);
    const issue = allIssues(store).find((each) => each.id === issueId);
    if (!issue || !issueId) {
      return <PageHeader title="Not found" back />;
    }
    return (
      <div>
        <PageHeader
          back
          title={props.id}
          meta={
            <span className="flex items-center gap-1.5">
              <StatusDot tone="green" /> Working · starting
            </span>
          }
        />
        <div className="flex max-w-3xl flex-col gap-4 p-4">
          <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-muted-foreground">Working on</dt>
            <dd>
              <a href={`#/p/${issue.short}/${issue.id}`} className="text-primary hover:underline">
                {issue.ref}
              </a>{" "}
              <span className="text-muted-foreground">{issue.title}</span>
            </dd>
            <dt className="text-muted-foreground">Machine</dt>
            <dd>
              <Go kind="vm" id={store.assigned[issueId].vm}>
                {store.assigned[issueId].vm}
              </Go>
            </dd>
          </dl>
          <Chat agent={props.id} first="Starting: reading the issue and setting up the project." />
        </div>
      </div>
    );
  }

  const work = WORK_BY_ID[agent.work];
  return (
    <div>
      <PageHeader
        back
        title={props.id}
        meta={
          <span className="flex items-center gap-1.5">
            <StatusDot tone={TONE[agent.status]} />
            {agent.status} · {agent.note}
          </span>
        }
        right={
          <Button size="sm" variant="outline" onClick={() => toast("Archive: asks first. Its history is kept.")}>
            Archive
          </Button>
        }
      />
      <div className="flex max-w-3xl flex-col gap-4 p-4">
        <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">Working on</dt>
          <dd>
            <Go kind="work" id={work.id}>
              {work.ref}
            </Go>{" "}
            <span className="text-muted-foreground">{work.title}</span>
          </dd>
          <dt className="text-muted-foreground">Machine</dt>
          <dd>
            {agent.vm ? (
              <Go kind="vm" id={agent.vm}>
                {agent.vm}
                {agent.desk ? ` · desktop ${agent.desk}` : ""}
              </Go>
            ) : (
              "No VM"
            )}
          </dd>
          <dt className="text-muted-foreground">Recent</dt>
          <dd className="flex flex-col gap-0.5">
            {agent.recent.map((id) => (
              <span key={id}>
                <Go kind="work" id={id}>
                  {WORK_BY_ID[id].ref}
                </Go>{" "}
                <span className="text-muted-foreground">{WORK_BY_ID[id].title}</span>
              </span>
            ))}
          </dd>
          <dt className="text-muted-foreground">Memory</dt>
          <dd className="flex items-center gap-2 pt-0.5">
            <div className="h-1 w-40 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 bg-idle" />
            </div>
            <span className="text-xs text-muted-foreground">a third used</span>
          </dd>
        </dl>
        <Chat agent={props.id} first={`${agent.note}.`} />
      </div>
    </div>
  );
}
