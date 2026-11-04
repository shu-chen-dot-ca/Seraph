import { ExternalLink } from "lucide-react";
import { useState } from "react";

import AssignDialog from "@/AssignDialog";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AGENT_TONE, StatusDot } from "@/components/ui/status-dot";
import FindIssuesDialog from "@/dialogs/FindIssuesDialog";
import NewIssueDialog from "@/dialogs/NewIssueDialog";
import { useLive, type IssueItem } from "@/live";
import { cn } from "@/lib/utils";
import { askOf } from "@/model/inbox";
import { COLUMNS, projectItems, useProjects } from "@/model/projects";
import { DONE_STAGES, useWorkItems, type WorkItem } from "@/model/work";
import ProjectSettings from "@/pages/ProjectSettings";
import { href } from "@/routes";

/*
One project: where you, in charge, see all its issues from open to done at once, as a board. Open holds the issues
nobody works on yet (Assign gives one to an agent), then In progress, In review, Approval, Sent (open source only) and
Done (the newest 12, Show all for the rest). What waits for you in this project is listed at the top. Each card
opens its issue's page.

Find issues (open source) puts free issues from GitHub in Open; New issue (private) writes one. The Agents tab lists
every agent that worked here; Settings has the project's switches.
*/

const DONE_SHOWN = 12;

function Card(props: { item: WorkItem; agentName: string; onAssign: (issue: IssueItem) => void }) {
  const item = props.item;
  let line = item.job?.headline || item.job?.title || "";
  if (item.stage === "open") {
    line = item.issue?.tags?.merge ? `Merge: ${item.issue.tags.merge}` : item.workflowIssue !== null ? "Waits for a worker" : "Nobody on it";
  }
  if (item.pr !== null && item.stage === "sent") {
    line = `Pull request #${item.pr.number} · checks ${item.pr.checks}`;
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-2.5 hover:border-input">
      <a href={href.work(item.repo, item.number)} className="line-clamp-2 font-medium hover:underline">
        {item.title}
      </a>
      <span className="text-xs text-muted-foreground">
        #{item.number}
        {props.agentName !== "" && ` · ${props.agentName}`}
      </span>
      {line !== "" && <span className="line-clamp-2 text-xs text-muted-foreground">{line}</span>}
      {item.waiting !== null && item.waiting.kind === "question" && (
        <Badge variant="warn" className="mt-0.5">
          Question for you
        </Badge>
      )}
      {((item.waiting !== null && item.waiting.kind !== "question") || item.waitingPR !== null) && <Badge className="mt-0.5">Approval for you</Badge>}
      {item.stage === "open" && item.issue !== null && (
        <Button size="xs" variant="outline" className="mt-1 self-start" onClick={() => props.onAssign(item.issue!)}>
          Assign
        </Button>
      )}
    </div>
  );
}

export default function ProjectPage(props: { repo: string; tab: string | null }) {
  const items = useWorkItems();
  const projects = useProjects(items);
  const agents = useLive("agents");
  const [assigning, setAssigning] = useState<IssueItem | null>(null);
  const [dialog, setDialog] = useState<"find" | "new" | null>(null);
  const [allDone, setAllDone] = useState(false);
  const project = projects.find((each) => each.key === props.repo.toLowerCase());
  if (project === undefined) {
    return <PageHeader back title={props.repo} meta="Not one of your projects." />;
  }
  const work = projectItems(project, items);
  const tab = props.tab ?? "issues";
  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? id ?? "";
  const open = work.filter((item) => !DONE_STAGES.includes(item.stage)).length;
  const waiting = work.filter((item) => item.waiting !== null || item.waitingPR !== null);

  // Every agent that worked here: on its issues, and a private project's own workers, reviewer and chat agent.
  const agentIds = new Set<string>();
  for (const item of work) {
    for (const job of item.jobs) {
      agentIds.add(job.agent);
    }
  }
  for (const id of [project.workflow?.chat, project.workflow?.reviewer, ...(project.workflow?.workers ?? [])]) {
    if (id) {
      agentIds.add(id);
    }
  }

  let action = (
    <Button size="sm" variant="outline" onClick={() => setDialog("find")}>
      Find issues
    </Button>
  );
  if (project.kind === "private") {
    action = (
      <Button size="sm" variant="outline" disabled={project.workflow === null} onClick={() => setDialog("new")}>
        New issue
      </Button>
    );
  }

  const tabs = [
    ["issues", "Issues"],
    ["agents", "Agents"],
    ["settings", "Settings"],
  ];

  return (
    <div>
      <PageHeader
        title={project.repo}
        meta={
          <span className="flex items-center gap-1.5">
            <Badge variant="secondary">{project.kind === "private" ? "Private" : "Open source"}</Badge>
            {open} open
            <a href={`https://github.com/${project.repo}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground">
              GitHub <ExternalLink className="size-3" />
            </a>
          </span>
        }
        right={action}
      />
      {waiting.length > 0 && (
        <div className="flex flex-col gap-1 border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">Waiting for you</span>
          {waiting.map((item) => (
            <a
              key={item.key}
              href={item.waiting !== null ? href.inboxItem(item.waiting.id) : href.work(item.repo, item.number)}
              className="truncate text-primary hover:underline"
            >
              {item.waiting !== null ? askOf(item.waiting) : `Merge “${item.waitingPR?.title}”?`}
            </a>
          ))}
        </div>
      )}
      <div className="flex gap-1 border-b px-3">
        {tabs.map((each) => (
          <a
            key={each[0]}
            href={href.project(project.repo, each[0] === "issues" ? undefined : each[0])}
            className={cn(
              "relative px-2 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground",
              tab === each[0] && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
            )}
          >
            {each[1]}
          </a>
        ))}
      </div>

      {tab === "issues" && (
        <div className="flex items-start gap-3 overflow-x-auto p-4">
          {COLUMNS[project.kind].map((column) => {
            let cards = work.filter((item) => column.stages.includes(item.stage));
            const total = cards.length;
            const isDone = column.stages === DONE_STAGES;
            if (isDone && !allDone) {
              cards = cards.slice(0, DONE_SHOWN);
            }
            return (
              <div key={column.title} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted p-2">
                <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                  <span>{column.title}</span>
                  <span className="tabular-nums">{total}</span>
                </div>
                {total === 0 && <div className="px-1 pb-1 text-xs text-muted-foreground">None</div>}
                {cards.map((item) => (
                  <Card key={item.key} item={item} agentName={agentName(item.agent)} onAssign={setAssigning} />
                ))}
                {isDone && total > DONE_SHOWN && !allDone && (
                  <Button size="xs" variant="ghost" onClick={() => setAllDone(true)}>
                    Show all {total}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "agents" && (
        <div>
          {agentIds.size === 0 && <p className="p-8 text-center text-muted-foreground">No agent has worked here yet.</p>}
          {[...agentIds].map((id) => {
            const agent = agents.find((each) => each.id === id);
            return (
              <a key={id} href={href.agent(id)} className="flex items-center gap-3 border-b px-4 py-2 hover:bg-accent">
                <StatusDot tone={AGENT_TONE[agent?.status ?? "idle"] ?? "gray"} />
                <span className="w-44 truncate font-medium">{agent?.name ?? id}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{agent?.archived_at ? "Archived" : (agent?.activity ?? "")}</span>
              </a>
            );
          })}
        </div>
      )}

      {tab === "settings" && <ProjectSettings key={project.key} project={project} />}

      {assigning !== null && <AssignDialog issue={assigning} onClose={() => setAssigning(null)} />}
      {dialog === "find" && <FindIssuesDialog project={project} onClose={() => setDialog(null)} />}
      {dialog === "new" && <NewIssueDialog repo={project.workflow?.repo} onClose={() => setDialog(null)} />}
    </div>
  );
}
