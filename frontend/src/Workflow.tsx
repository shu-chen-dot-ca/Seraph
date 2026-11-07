/*
The Workflow tab: one of your own repositories that agents develop one confined issue at a time, each as a pull request
the review agent checks before it is merged or rejected (github_searcher/workflow.py, backend/workflow_api.py). With no
repository picked, the first one; with none at all, what it does and Add repository.

The bar on top: the repository (its GitHub page), the tabs and, on the right, how it is set: Paused (workers take no new
issues), who decides, and where its pull requests and issues are. The tabs:
- Overview (WorkflowOverview.tsx): the numbers and charts first, then what each agent is on.
- Pull requests (WorkflowPullRequests.tsx): Open (waiting for a decision first, then in review) and Closed, and one
  pull request with its review, its proof, Merge and Reject.
- Issues (WorkflowIssues.tsx): Open and Closed, one issue with its goal, requirements and how to check, New issue.
- Chat: the chat agent (AgentChat.tsx), where you ask for things; it writes them as issues.
- Settings: Take new issues, Approve and merge (You or the Review agent), where pull requests and issues are (only
  while it has none yet), how many workers, its VM and agents, and Remove repository (asks first).
Everything comes from the live store (workflow, agents, jobs), so it moves on its own.
*/

import { BookMarked, ExternalLink, Loader2, Monitor, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import AddRepositoryDialog from "@/AddRepositoryDialog";
import AgentChat from "@/AgentChat";
import WorkflowIssues from "@/WorkflowIssues";
import WorkflowOverview from "@/WorkflowOverview";
import WorkflowPullRequests from "@/WorkflowPullRequests";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type WorkflowRepo } from "@/live";

const TABS = ["overview", "pulls", "issues", "chat", "settings"];

export default function Workflow(props: { repo: string | null; tab: string; state: "open" | "closed"; open: string | null }) {
  const repos = useLive("workflow");
  const loaded = useLoaded("workflow");
  const [adding, setAdding] = useState(false);

  if (!loaded) {
    return <div className="p-3 text-muted-foreground">Loading…</div>;
  }

  if (repos.length === 0) {
    return (
      <div className="max-w-2xl space-y-3 p-4 max-md:p-3">
        <h2 className="text-base font-semibold">Workflow</h2>
        <p>Agents develop your own repositories here, one small, clearly defined issue at a time. You look at the result and its proof, and decide.</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>The chat agent turns what you ask for into issues: each one goal, its requirements, and how to check it is done.</li>
          <li>A worker takes each issue, reproduces it, does exactly that and nothing more, tests it and makes a pull request. What it finds on the way becomes a new issue.</li>
          <li>The review agent runs every pull request, yours too, sees its effect and tells you merge or don't merge, and what you must know.</li>
          <li>You merge or reject. Or let the review agent decide, the same way.</li>
        </ul>
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add repository
        </Button>
        <AddRepositoryDialog open={adding} onClose={() => setAdding(false)} />
      </div>
    );
  }

  let record = repos[0];
  if (props.repo !== null) {
    const found = repos.find((each) => each.repo.toLowerCase() === props.repo?.toLowerCase());
    if (found === undefined) {
      return <div className="p-4 text-muted-foreground">{props.repo} isn't in Workflow.</div>;
    }
    record = found;
  }
  const tab = TABS.includes(props.tab) ? props.tab : "overview";
  const base = `#/workflow?repo=${encodeURIComponent(record.repo)}`;
  const prs = Object.values(record.prs);
  const issues = Object.values(record.issues);
  const openPRs = prs.filter((pr) => pr.state === "review" || pr.state === "waiting").length;
  const openIssues = issues.filter((issue) => issue.state === "open").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3 max-md:h-auto max-md:flex-wrap max-md:gap-y-1 max-md:py-1">
        <a href={`https://github.com/${record.repo}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 font-medium hover:underline" title="Open on GitHub">
          <BookMarked className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{record.repo}</span>
        </a>
        <Tabs
          value={tab}
          onValueChange={(value) => (window.location.hash = value === "overview" ? base : `${base}&tab=${value}`)}
          className="max-md:order-last max-md:w-full max-md:overflow-x-auto"
        >
          <TabsList>
            <TabsTrigger value="overview" className="px-2.5">
              Overview
            </TabsTrigger>
            <TabsTrigger value="pulls" className="px-2.5">
              Pull requests <span className="text-xs text-muted-foreground tabular-nums">{openPRs}</span>
            </TabsTrigger>
            <TabsTrigger value="issues" className="px-2.5">
              Issues <span className="text-xs text-muted-foreground tabular-nums">{openIssues}</span>
            </TabsTrigger>
            <TabsTrigger value="chat" className="px-2.5">
              Chat
            </TabsTrigger>
            <TabsTrigger value="settings" className="px-2.5">
              Settings
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground max-md:hidden">
          {!record.on && "Paused · "}
          {record.decides === "you" ? "You decide" : "The review agent decides"} · {record.prs_on === "seraph" ? "In Seraph" : "On GitHub"}
        </span>
      </div>
      {record.error !== "" && <div className="border-b bg-destructive/10 px-3 py-1.5 text-destructive">The last round failed, it is tried again in a minute: {record.error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && <WorkflowOverview record={record} base={base} />}
        {tab === "pulls" && <WorkflowPullRequests key={record.repo} record={record} base={base} state={props.state} open={props.open} />}
        {tab === "issues" && <WorkflowIssues key={record.repo} record={record} base={base} state={props.state} open={props.open} />}
        {tab === "chat" && record.chat !== null && (
          <div className="h-full">
            <AgentChat key={record.chat} agentId={record.chat} compact />
          </div>
        )}
        {tab === "chat" && record.chat === null && <div className="p-3 text-muted-foreground">Its chat agent is being made.</div>}
        {tab === "settings" && <Settings key={record.repo} record={record} />}
      </div>
    </div>
  );
}

function Settings(props: { record: WorkflowRepo }) {
  const record = props.record;
  const agents = useLive("agents");
  // The request on its way: "on", "decides", "prs_on", "agents" or "remove".
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState(false);
  const fresh = Object.keys(record.issues).length === 0 && Object.keys(record.prs).length === 0;
  const names: Record<string, string> = {};
  for (const agent of agents) {
    names[agent.id] = agent.name;
  }
  const team = [
    { id: record.chat, what: "Chat agent" },
    ...record.workers.map((id) => ({ id: id as string | null, what: "Worker" })),
    { id: record.reviewer, what: "Review agent" },
  ];

  async function change(what: string, fields: Record<string, unknown>) {
    setBusy(what);
    try {
      await api(`/api/workflow/${record.repo}`, { method: "PUT", body: fields });
    } catch (err) {
      toast.error(`Could not change it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function remove() {
    setBusy("remove");
    try {
      await api(`/api/workflow/${record.repo}`, { method: "DELETE" });
      toast.success(`Removed ${record.repo} from Workflow`);
      window.location.hash = "#/workflow";
    } catch (err) {
      toast.error(`Could not remove it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  const heading = "font-medium";
  const note = "text-xs text-muted-foreground";

  return (
    <div className="max-w-2xl space-y-5 p-4 max-md:p-3">
      <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <Switch checked={record.on} disabled={busy !== ""} onCheckedChange={(on) => change("on", { on })} />
          <span className={heading}>Take new issues</span>
        </label>
        <p className={note}>{record.on ? "Workers take the open issues, the oldest first." : "Paused: workers take no new issues. What they are on goes on, and pull requests are still reviewed."}</p>
      </div>

      <div className="space-y-1.5">
        <div className={heading}>Approve and merge</div>
        <Tabs value={record.decides} onValueChange={(decides) => change("decides", { decides })}>
          <TabsList>
            <TabsTrigger value="you" className="px-2.5" disabled={busy !== ""}>
              You
            </TabsTrigger>
            <TabsTrigger value="agent" className="px-2.5" disabled={busy !== ""}>
              Review agent
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className={note}>
          {record.decides === "you"
            ? "You merge or reject each pull request. The review agent's advice is shown, but it is only advice."
            : "The review agent merges or rejects each pull request by its own review, the same way you would. Every decision is shown on its pull request."}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className={heading}>Pull requests and issues</div>
        <Tabs value={record.prs_on} onValueChange={(prsOn) => change("prs_on", { prs_on: prsOn })}>
          <TabsList>
            <TabsTrigger value="seraph" className="px-2.5" disabled={busy !== "" || !fresh}>
              In Seraph
            </TabsTrigger>
            <TabsTrigger value="github" className="px-2.5" disabled={busy !== "" || !fresh}>
              On GitHub
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className={note}>
          {record.prs_on === "seraph"
            ? "Kept here: nothing the agents write goes to GitHub. Merging puts the change on the default branch as one commit, as you. Pull requests you open on GitHub are reviewed too."
            : "On GitHub, as you: issues and pull requests are there, and the review is a comment on each pull request."}
          {!fresh && " It can't change once there are issues or pull requests."}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className={heading}>Workers</div>
        <Tabs value={String(record.agents)} onValueChange={(value) => change("agents", { agents: Number(value) })}>
          <TabsList>
            {[1, 2, 3].map((count) => (
              <TabsTrigger key={count} value={String(count)} className="px-2.5" disabled={busy !== ""}>
                {count}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className={note}>Each works on its own desktop of the VM, one issue at a time.</p>
      </div>

      <div className="space-y-1.5">
        <div className={heading}>VM and agents</div>
        {record.vm !== null && (
          <a href={`#/vms/${encodeURIComponent(record.vm)}`} className="flex items-center gap-1.5 hover:underline">
            <Monitor className="size-4 text-muted-foreground" /> {record.vm}
          </a>
        )}
        <div className="divide-y rounded-md border">
          {team.map((member, index) => (
            <div key={`${member.id}-${index}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className="w-28 shrink-0 text-muted-foreground">{member.what}</span>
              {member.id !== null && names[member.id] !== undefined ? (
                <a href={`#/agents/${member.id}`} className="flex min-w-0 items-center gap-1 truncate hover:underline">
                  {names[member.id]} <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              ) : (
                <span className="text-muted-foreground">Being made</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5 border-t pt-4">
        <Button variant="outline" disabled={busy !== ""} onClick={() => setRemoving(true)}>
          {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove repository
        </Button>
        <p className={note}>Its agents are archived and its issues and pull requests here are forgotten. The repository on GitHub and the VM stay.</p>
      </div>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {record.repo} from Workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              Its agents stop and are archived, their open jobs cancelled. Its issues and pull requests here are forgotten; nothing on GitHub changes. The
              VM {record.vm} stays: delete it on the VMs page if you don't need it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Remove repository</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
