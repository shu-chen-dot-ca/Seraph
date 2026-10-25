/*
One agent's page: its name and id in the header (the id is unique and never changes); under the header, the job it is on now (its title and every step, the current one marked, and a
warning when it has been quiet too long; the rest of its progress is on the Jobs page); the conversation on the left;
on the right where it stands in a VM queue, its jobs in two lists that each fold with their header: In queue (still to
do, being done or waiting on you, in the order it takes them, with their progress; a queued one has an x that takes it
off: the job is cancelled, and the agent is told) and Finished (done and cancelled, newest first), and its latest todo
list.

The header has two tabs: Chat (all of the above) and Artifacts (AgentArtifacts.tsx: the agent's own folder of files,
pictures and screenshots). In the conversation, a picture the agent keeps there shows where it writes
![...](artifact:path).

The header's ⋯ menu has Archive (or Unarchive) and Delete, both asking first. Archive stops the agent, cancels its open
jobs and takes it out of every VM queue, but keeps this conversation; an archived agent's page says so, and sending it
a message brings it back. An agent that made PRs can't be deleted, only archived, so it keeps its context for updates.

The conversation is the agent's history (HistoryEntry in live.ts; append-only on the server). The page
loads the last 200 entries, then fetches only the new part (/history?since=<end>) whenever the live
agent summary's history_length grows. "Show earlier" loads up to 200 more in front. A tool call and its
result are paired by id and shown as one row that opens to the input and the result. New entries scroll
the view down only while it is at the bottom, so reading further up is never interrupted.

A message sent while the agent works waits for its turn to end; the composer shows those as queued (10 at most,
each gets a turn of its own; the live agent list carries their texts, so they show after a reload too), each with an x
that takes it out before it goes in. Esc anywhere on the page (not while a dialog or menu is open) interrupts the turn, and
the next queued message goes in. What you type
and don't send is kept in this browser per agent (localStorage), so it is still there when you come back, after a
reload, and after a backend restart.
Compact sends "/compact", which Claude Code runs on the conversation itself. The target VM can only
change while the agent is not queued for or holding a VM (the backend refuses it then).
*/

import {
  ArrowUp,
  Ban,
  BookOpen,
  Brain,
  Camera,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleHelp,
  Clock,
  FileText,
  FlaskConical,
  FolderGit2,
  GitPullRequest,
  Keyboard,
  ListOrdered,
  ListTodo,
  Loader2,
  MessageSquare,
  Minimize2,
  Monitor,
  MousePointer2,
  Search,
  Square,
  Terminal,
  Trash2,
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import AgentArtifacts from "@/AgentArtifacts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { JobProgressBar, JobSteps, currentJob, stuckFor, useNow } from "@/components/ui/job-progress";
import { IssueRefText, Markdown } from "@/components/ui/markdown";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, JOB_LABEL, JOB_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useLive, useLiveValue, useLoaded, type HistoryEntry, type Todo, type VMStatus } from "@/live";
import { cn } from "@/lib/utils";

// Entries loaded at first, and per "Show earlier".
const PAGE = 200;
// The context bar's full width: the backend compacts at AGENT_CONTEXT_CAP (500k) tokens, or earlier
// when the model's window is smaller.
const CONTEXT_CAP = 500_000;
const OPEN_STATUSES = ["queued", "working", "waiting_on_user"];
// The messages that may wait for their turn at once (MAX_QUEUED in agents.py).
const MAX_QUEUED = 10;
const NO_VM = "__none__";

// An icon per tool; anything else gets the wrench.
const TOOL_ICONS: Record<string, LucideIcon> = {
  TodoWrite: ListTodo,
  bash: Terminal,
  screenshot: Camera,
  check: Monitor,
  vm_start: Monitor,
  vm_stop: Monitor,
  vm_restart: Monitor,
  vm_health: Monitor,
  click: MousePointer2,
  drag: MousePointer2,
  scroll: MousePointer2,
  type: Keyboard,
  key: Keyboard,
  wait: Clock,
  read_readme: BookOpen,
  read_files: FileText,
  list_files: FileText,
  read_thread: MessageSquare,
  search_code: Search,
  search_issues: Search,
  repos_list: FolderGit2,
  repos_add: FolderGit2,
  repos_remove: FolderGit2,
  repos_note: FolderGit2,
  issues_list: CircleDot,
  issues_add: CircleDot,
  issues_remove: CircleDot,
  issues_note: CircleDot,
  draft_pr: GitPullRequest,
  run_tests: FlaskConical,
  draft_comment: MessageSquare,
  draft_question: CircleHelp,
  queue_for_vm: ListOrdered,
  release_vm: ListOrdered,
  vm_queue_status: ListOrdered,
};

type ToolEntry = Extract<HistoryEntry, { type: "tool" }>;
type ToolResult = Extract<HistoryEntry, { type: "tool_result" }>;

// One tool call and its result: a row that opens to the input and the result. Memoized, so the page's frequent
// re-renders (every agent update while it works) skip the rows that are done, and their JSON.
const ToolRow = memo(function ToolRow(props: { entry: ToolEntry; result: ToolResult | undefined; running: boolean }) {
  const { entry, result, running } = props;
  const Icon = TOOL_ICONS[entry.name] ?? Wrench;
  return (
    <details className="group">
      <summary
        className={cn(
          "flex h-7 cursor-pointer list-none items-center gap-2 rounded-sm px-1 select-none hover:bg-accent/50 [&::-webkit-details-marker]:hidden",
          result?.is_error && "text-destructive"
        )}
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          <IssueRefText text={entry.summary || entry.name} />
        </span>
        {running && <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-primary" />}
        {result?.is_error && <X className="ml-auto size-3.5 shrink-0" />}
      </summary>
      <div className="mt-1 mb-2 ml-3 space-y-1.5 border-l pl-3">
        <div className="font-mono text-xs text-muted-foreground">{entry.name}</div>
        <pre className="max-h-80 overflow-auto rounded-sm border bg-muted/50 px-2 py-1.5 text-xs break-all whitespace-pre-wrap">
          {JSON.stringify(entry.input, null, 2)}
        </pre>
        {result === undefined && !running && <div className="text-xs text-muted-foreground">No result (the turn ended first).</div>}
        {result !== undefined && result.text !== "" && (
          <pre
            className={cn(
              "max-h-96 overflow-auto rounded-sm border bg-muted/50 px-2 py-1.5 text-xs break-all whitespace-pre-wrap",
              result.is_error && "border-destructive/50 text-destructive"
            )}
          >
            {result.text}
          </pre>
        )}
        {result !== undefined && result.image && <div className="text-xs text-muted-foreground">It returned an image (not kept).</div>}
      </div>
    </details>
  );
});

export default function AgentChat(props: { agentId: string }) {
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  // Only the VMs' names, states and holders, as one string: the whole VM list changes every second while a VM
  // runs (its usage samples), and this page would re-render with it.
  const vmsText = useLiveValue((topics) => JSON.stringify(topics.vms.map((vm) => ({ name: vm.name, status: vm.status, holder: vm.holder }))));
  const vms = JSON.parse(vmsText) as { name: string; status: VMStatus; holder: string | null }[];
  const agentsLoaded = useLoaded("agents");

  // entries[0] is history[start] on the server.
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [start, setStart] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // The unsent message: from localStorage at first, and saved there as you type.
  const draftKey = `draft:agent:${props.agentId}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      // Storage blocked (private window): start empty.
      return "";
    }
  });
  const [seen, setSeen] = useState(false);
  // The header's confirm dialog: archive or delete this agent; null while closed.
  const [confirmAction, setConfirmAction] = useState<"archive" | "delete" | null>(null);
  // Chat or Artifacts. The chat stays mounted under Artifacts, so its scroll and desktop stay.
  const [pageTab, setPageTab] = useState("chat");
  // The job lists (In queue, Finished) folded on the right, by key.
  const [foldedLists, setFoldedLists] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    try {
      if (text === "") {
        localStorage.removeItem(draftKey);
      } else {
        localStorage.setItem(draftKey, text);
      }
    } catch {
      // Storage blocked (private window): the draft just isn't kept.
    }
  }, [draftKey, text]);
  // Set by "Show earlier": the distance from the bottom to keep, so the view doesn't jump.
  const keepFromBottom = useRef<number | null>(null);
  const fetching = useRef(false);
  const now = useNow();

  const summary = agents.find((agent) => agent.id === props.agentId);
  const historyLength = summary?.history_length ?? 0;
  const end = start + entries.length;

  // Once the agent was there, its disappearing means it was deleted (not that the list is still loading).
  if (summary !== undefined && !seen) {
    setSeen(true);
  }

  // The first load (the last PAGE entries), then only what is new whenever history_length grows.
  // One fetch at a time; when one ends, `end` changes and this runs again if more came meanwhile.
  useEffect(() => {
    if (fetching.current) {
      return;
    }
    if (historyLoaded && historyLength <= end) {
      return;
    }
    fetching.current = true;
    const since = historyLoaded ? end : -PAGE;
    api<{ entries: HistoryEntry[]; total: number }>(`/api/agents/${props.agentId}/history?since=${since}`)
      .then((body) => {
        fetching.current = false;
        setHistoryError("");
        if (!historyLoaded) {
          setStart(body.total - body.entries.length);
          setEntries(body.entries);
          setHistoryLoaded(true);
          return;
        }
        setEntries((current) => [...current, ...body.entries]);
      })
      .catch((err) => {
        fetching.current = false;
        setHistoryError(err instanceof Error ? err.message : String(err));
      });
  }, [props.agentId, historyLoaded, historyLength, end]);

  // Follow new entries while at the bottom; after "Show earlier", stay on what was on screen.
  const busy = summary?.busy ?? false;
  const pending = summary?.pending ?? 0;
  const exists = summary !== undefined;
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box === null) {
      return;
    }
    if (keepFromBottom.current !== null) {
      box.scrollTop = box.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
      return;
    }
    if (atBottom.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [entries, busy, pending, exists]);

  // Esc anywhere on the page interrupts the turn; the next queued message then goes in. An open dialog or
  // menu takes Esc first (Radix marks it handled), so closing one never interrupts.
  useEffect(() => {
    if (!busy) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      api(`/api/agents/${props.agentId}/interrupt`, { method: "POST" }).catch((err) => {
        toast.error(`Could not interrupt: ${err instanceof Error ? err.message : err}`);
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, props.agentId]);

  async function showEarlier() {
    const from = Math.max(0, start - PAGE);
    setLoadingEarlier(true);
    try {
      const body = await api<{ entries: HistoryEntry[]; total: number }>(`/api/agents/${props.agentId}/history?since=${from}`);
      // The answer runs to the end; only the part before what is shown is new.
      const earlier = body.entries.slice(0, start - from);
      const box = scrollRef.current;
      if (box !== null) {
        keepFromBottom.current = box.scrollHeight - box.scrollTop;
      }
      setEntries((current) => [...earlier, ...current]);
      setStart(from);
    } catch (err) {
      toast.error(`Could not load earlier messages: ${err instanceof Error ? err.message : err}`);
    }
    setLoadingEarlier(false);
  }

  async function send() {
    const message = text.trim();
    if (message === "" || pending >= MAX_QUEUED) {
      return;
    }
    setText("");
    // Sending takes you to the bottom, to follow the answer.
    atBottom.current = true;
    try {
      await api(`/api/agents/${props.agentId}/message`, { method: "POST", body: { text: message } });
    } catch (err) {
      setText(message);
      toast.error(`Could not send: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function compact() {
    atBottom.current = true;
    try {
      await api(`/api/agents/${props.agentId}/message`, { method: "POST", body: { text: "/compact" } });
    } catch (err) {
      toast.error(`Could not compact: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Take a queued message out before it goes in.
  async function cancelQueued(index: number, message: string) {
    try {
      await api(`/api/agents/${props.agentId}/queue/cancel`, { method: "POST", body: { index, text: message } });
    } catch (err) {
      toast.error(`Could not take it out: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function interrupt() {
    try {
      await api(`/api/agents/${props.agentId}/interrupt`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not interrupt: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function setTargetVM(value: string) {
    try {
      await api(`/api/agents/${props.agentId}/target_vm`, { method: "PUT", body: { vm: value === NO_VM ? null : value } });
    } catch (err) {
      toast.error(`Could not change the target VM: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function archive(action: "archive" | "unarchive") {
    try {
      await api(`/api/agents/${props.agentId}/${action}`, { method: "POST" });
      toast.success(action === "archive" ? `Archived ${summary?.name ?? props.agentId}` : `${summary?.name ?? props.agentId} is back`);
    } catch (err) {
      toast.error(`Could not ${action}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove() {
    try {
      await api(`/api/agents/${props.agentId}`, { method: "DELETE" });
      toast.success(`Deleted ${summary?.name ?? props.agentId}`);
      window.location.hash = "#/agents";
    } catch (err) {
      toast.error(`Could not delete: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (summary === undefined) {
    if (agentsLoaded && (seen || historyError !== "")) {
      return (
        <div className="p-4 text-muted-foreground">
          This agent doesn't exist (anymore).{" "}
          <a href="#/agents" className="text-primary hover:underline">
            All agents
          </a>
        </div>
      );
    }
    return <div className="p-4 text-muted-foreground">Loading…</div>;
  }

  // Pair tool calls with their results, find where the last turn ended (a call after it with no result
  // yet is still running) and the latest todo list.
  const results: Record<string, ToolResult> = {};
  const toolIds = new Set<string>();
  let lastTurnEnd = -1;
  let todos: Todo[] = [];
  entries.forEach((entry, index) => {
    if (entry.type === "tool_result") {
      results[entry.id] = entry;
    }
    if (entry.type === "tool") {
      toolIds.add(entry.id);
    }
    if (entry.type === "turn_end") {
      lastTurnEnd = index;
    }
    if (entry.type === "tool" && entry.name === "TodoWrite" && Array.isArray(entry.input.todos)) {
      todos = entry.input.todos as Todo[];
    }
  });

  const locked = summary.status === "in_queue" || summary.status === "using_vm";
  const cap = summary.context_max > 0 ? Math.min(summary.context_max, CONTEXT_CAP) : CONTEXT_CAP;
  const capText = cap >= 1_000_000 ? `${cap / 1_000_000}M` : `${Math.round(cap / 1000)}k`;
  const percent = Math.min(100, (summary.context_used / cap) * 100);
  // Summaries from before the backend sent the texts have none.
  const queued = summary.queued ?? [];

  const vmNames = vms.map((vm) => vm.name);
  const queueVM = vms.find((vm) => vm.name === summary.vm);
  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  // Its jobs in two lists. In queue is oldest first, the order the agent takes them; Finished newest first (the
  // jobs topic is newest first).
  const mine = jobs.filter((job) => job.agent === summary.id);
  const jobLists = [
    {
      key: "queue",
      label: "In queue",
      jobs: mine.filter((job) => OPEN_STATUSES.includes(job.status)).reverse(),
      empty: "Nothing to do. Assign issues to it from the Issues page.",
    },
    {
      key: "finished",
      label: "Finished",
      jobs: mine.filter((job) => !OPEN_STATUSES.includes(job.status)),
      empty: "No finished jobs yet.",
    },
  ];
  // The job it is on now, for the progress strip under the header.
  const job = currentJob(summary.id, jobs);
  const stuck = stuckFor(summary, now);

  // Take a queued job off its list: it is cancelled (it moves to Finished as Cancelled), and the agent is told.
  async function removeJob(id: string) {
    try {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not remove ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <StatusDot tone={AGENT_TONE[summary.status] ?? "gray"} />
        <h1 className="font-semibold">{summary.name}</h1>
        <span className="font-mono text-xs text-muted-foreground" title="Its id: unique, and it never changes, also when renamed">
          {summary.id}
        </span>
        <Tabs value={pageTab} onValueChange={setPageTab}>
          <TabsList>
            <TabsTrigger value="chat" className="px-2.5">
              Chat
            </TabsTrigger>
            <TabsTrigger value="artifacts" className="px-2.5">
              Artifacts
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="truncate text-muted-foreground">
          {summary.status === "idle" && "idle"}
          {summary.status === "working" && "working"}
          {summary.status === "in_queue" && `in queue #${summary.place} · ${summary.vm}`}
          {summary.status === "using_vm" && `using ${summary.vm}`}
          {summary.busy && summary.status !== "working" && " · working"}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground">Target VM</span>
          <span title={locked ? `It can't change while ${summary.name} waits for or holds ${summary.vm}.` : undefined}>
            <Select value={summary.target_vm ?? NO_VM} onValueChange={setTargetVM} disabled={locked}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={NO_VM}>No VM</SelectItem>
                {summary.target_vm !== null && !vmNames.includes(summary.target_vm) && (
                  <SelectItem value={summary.target_vm}>{summary.target_vm}</SelectItem>
                )}
                {vms.map((vm) => (
                  <SelectItem key={vm.name} value={vm.name}>
                    <StatusDot tone={VM_TONE[vm.status] ?? "gray"} />
                    {vm.name}
                    <span className="text-muted-foreground">{vm.status}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-2 flex items-center gap-2">
                <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full", percent > 80 ? "bg-warn" : "bg-muted-foreground/70")} style={{ width: `${percent}%` }} />
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(summary.context_used / 1000)}k / {capText}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Context: {summary.context_used.toLocaleString()} tokens. It is compacted at {capText}. Cost so far ${summary.cost_usd.toFixed(2)}.
            </TooltipContent>
          </Tooltip>

          <Button variant="outline" size="sm" className="ml-2" onClick={interrupt} disabled={!summary.busy} title="Stop the current turn; the next queued message goes in (Esc)">
            <Square /> Interrupt
          </Button>
          <Button variant="outline" size="sm" onClick={compact} disabled={summary.history_length === 0} title="Summarize the conversation to free context">
            <Minimize2 /> Compact
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${summary.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {summary.archived_at === null && (
                <DropdownMenuItem onSelect={() => setConfirmAction("archive")}>
                  <Archive /> Archive
                </DropdownMenuItem>
              )}
              {summary.archived_at !== null && (
                <DropdownMenuItem onSelect={() => archive("unarchive")}>
                  <ArchiveRestore /> Unarchive
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={summary.prs > 0} onSelect={() => setConfirmAction("delete")}>
                <Trash2 /> Delete
                {summary.prs > 0 && <span className="ml-auto text-xs">made PRs: archive it</span>}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirmAction === "archive" ? "Archive" : "Delete"} {summary.name}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmAction === "archive"
                    ? "It stops, its open jobs are cancelled and it leaves every VM queue. Its conversation stays: it is under Archived on the Agents page, and a message or a job brings it back."
                    : "Its conversation is deleted, its open jobs are cancelled and it leaves every VM queue. Its drafts stay in the Inbox."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant={confirmAction === "archive" ? "default" : "destructive"}
                  onClick={() => (confirmAction === "archive" ? archive("archive") : remove())}
                >
                  {confirmAction === "archive" ? "Archive" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {summary.archived_at !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-muted-foreground">
          <Archive className="size-3.5" />
          Archived {new Date(summary.archived_at).toLocaleString()}. Its conversation is kept; a message brings it back.
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => archive("unarchive")}>
            <ArchiveRestore /> Unarchive
          </Button>
        </div>
      )}

      {job !== undefined && (
        <div className="shrink-0 space-y-1.5 border-b bg-muted/20 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <a href={`#/jobs/${job.id}`} className="truncate font-medium hover:underline" title={job.title}>
              {job.title}
            </a>
            <JobSteps job={job} />
          </div>
          {stuck !== "" && <div className="text-xs text-warn">No activity for {stuck}: it may be stuck, or running something slow.</div>}
        </div>
      )}

      {pageTab === "artifacts" && (
        <div className="min-h-0 flex-1">
          <AgentArtifacts key={summary.id} agentId={summary.id} stamp={summary.artifacts_stamp ?? 0} />
        </div>
      )}

      <div className={pageTab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="70%" minSize="35%">
          <div className="flex h-full flex-col">
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto"
              onScroll={(event) => {
                const box = event.currentTarget;
                // Within a few pixels of the end counts as the bottom.
                atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
              }}
            >
              <div className="mx-auto flex max-w-4xl flex-col gap-1.5 px-4 py-3">
                {start > 0 && (
                  <Button variant="ghost" size="sm" className="self-center text-muted-foreground" onClick={showEarlier} disabled={loadingEarlier}>
                    {loadingEarlier && <Loader2 className="animate-spin" />}
                    Show earlier ({start} more)
                  </Button>
                )}
                {!historyLoaded && historyError === "" && <div className="text-muted-foreground">Loading the conversation…</div>}
                {historyError !== "" && <div className="text-destructive">Could not load the conversation: {historyError}</div>}
                {historyLoaded && entries.length === 0 && !summary.busy && (
                  <div className="py-8 text-center text-muted-foreground">
                    Nothing yet. Tell {summary.name} what to look for, or give it an issue from the Issues page.
                  </div>
                )}

                {entries.map((entry, index) => {
                  const key = start + index;

                  if (entry.type === "user") {
                    return (
                      <div key={key} className="flex justify-end py-1">
                        <div className="max-w-[85%] rounded-md border bg-muted/60 px-3 py-1.5">
                          <div className="break-words whitespace-pre-wrap">{entry.text}</div>
                          <div className="text-right text-[11px] text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</div>
                        </div>
                      </div>
                    );
                  }

                  if (entry.type === "text") {
                    // ![...](artifact:path): a picture from its artifacts, loaded from this app.
                    const text = entry.text.replace(
                      /\]\(artifact:([^)\s]+)\)/g,
                      (_, file: string) => `](${window.location.origin}/api/agents/${summary.id}/artifacts/file?path=${encodeURIComponent(file)})`,
                    );
                    return <Markdown key={key} text={text} className="py-1" githubImagesOnly issueRefs />;
                  }

                  if (entry.type === "thinking") {
                    return (
                      <details key={key} className="group text-muted-foreground">
                        <summary className="flex h-6 cursor-pointer list-none items-center gap-1.5 select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
                          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                          <Brain className="size-3.5" />
                          Thinking
                        </summary>
                        <div className="mt-1 mb-2 ml-1.5 border-l-2 pl-3 break-words whitespace-pre-wrap italic">{entry.text}</div>
                      </details>
                    );
                  }

                  if (entry.type === "tool") {
                    const result = results[entry.id];
                    const running = result === undefined && summary.busy && index > lastTurnEnd;
                    return <ToolRow key={key} entry={entry} result={result} running={running} />;
                  }

                  if (entry.type === "tool_result") {
                    // Shown with its call. A result whose call is before the loaded part stands alone.
                    if (toolIds.has(entry.id)) {
                      return null;
                    }
                    return (
                      <details key={key} className="group">
                        <summary
                          className={cn(
                            "flex h-7 cursor-pointer list-none items-center gap-2 rounded-sm px-1 text-muted-foreground select-none hover:bg-accent/50 [&::-webkit-details-marker]:hidden",
                            entry.is_error && "text-destructive"
                          )}
                        >
                          <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
                          <Wrench className="size-3.5 shrink-0" />
                          Result of an earlier tool call
                        </summary>
                        <pre
                          className={cn(
                            "mt-1 mb-2 ml-3 max-h-96 overflow-auto rounded-sm border bg-muted/50 px-2 py-1.5 text-xs break-all whitespace-pre-wrap",
                            entry.is_error && "text-destructive"
                          )}
                        >
                          {entry.text}
                        </pre>
                      </details>
                    );
                  }

                  if (entry.type === "system") {
                    return (
                      <div
                        key={key}
                        className={cn("py-0.5 text-center text-xs text-muted-foreground", entry.text.startsWith("Error") && "text-destructive")}
                      >
                        {entry.text}
                        <span className="ml-1.5 opacity-70">{new Date(entry.time).toLocaleTimeString()}</span>
                      </div>
                    );
                  }

                  if (entry.type === "turn_end") {
                    return (
                      <div key={key} className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
                        <div className="h-px flex-1 bg-border" />
                        {entry.stopped ? (
                          <span className="flex items-center gap-1 text-warn">
                            <Ban className="size-3" /> Stopped
                          </span>
                        ) : (
                          <span>Turn ended</span>
                        )}
                        <span className="tabular-nums">${entry.cost_usd.toFixed(2)}</span>
                        <span>{new Date(entry.time).toLocaleTimeString()}</span>
                        <div className="h-px flex-1 bg-border" />
                      </div>
                    );
                  }

                  // A kind of entry this page doesn't know yet.
                  return null;
                })}

                {summary.busy && (
                  <div className="flex h-7 items-center gap-2 px-1 text-muted-foreground">
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                    <span className="truncate">Working…</span>
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 border-t px-3 py-2">
              {pending > 0 && (
                <div className="mx-auto mb-2 max-w-4xl space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {pending} of {MAX_QUEUED} queued, each gets its own turn · Esc stops this turn and sends the next
                  </div>
                  {queued.map((message, index) => (
                    <div key={index} className="flex items-center gap-1 rounded-sm border border-dashed py-0.5 pr-0.5 pl-2 text-muted-foreground" title={message}>
                      <span className="min-w-0 flex-1 truncate">{message}</span>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0"
                        title="Take it out: it won't be sent"
                        aria-label="Cancel this queued message"
                        onClick={() => cancelQueued(index, message)}
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mx-auto flex max-w-4xl items-end gap-2">
                <Textarea
                  className="max-h-48 min-h-14 resize-none"
                  placeholder={
                    pending >= MAX_QUEUED
                      ? `${MAX_QUEUED} messages wait; send more when one has gone in`
                      : summary.archived_at !== null
                        ? `Message ${summary.name} (it comes back from the archive)`
                        : summary.busy
                        ? `Message ${summary.name} (sent when this turn ends)`
                        : `Message ${summary.name}`
                  }
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <Button size="icon" onClick={send} disabled={text.trim() === "" || pending >= MAX_QUEUED} aria-label="Send" title="Send (Enter)">
                  <ArrowUp />
                </Button>
              </div>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize="30%" minSize={240}>
          <div className="h-full overflow-y-auto">
            <div className="flex h-7 items-center border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground">VM queue</div>
            <div className="space-y-1 border-b px-3 py-2">
              {summary.place === 0 && summary.vm !== null && (
                <div className="flex items-center gap-1.5">
                  <StatusDot tone="green" />
                  Holds
                  <a href={`#/vms/${summary.vm}`} className="text-primary hover:underline">
                    {summary.vm}
                  </a>
                </div>
              )}
              {summary.place !== null && summary.place > 0 && summary.vm !== null && (
                <>
                  <div className="flex items-center gap-1.5">
                    <StatusDot tone="amber" />
                    Number {summary.place} in
                    <a href={`#/vms/${summary.vm}`} className="text-primary hover:underline">
                      {summary.vm}
                    </a>
                    's queue
                  </div>
                  {queueVM !== undefined && (
                    <div className="text-muted-foreground">
                      {queueVM.holder === null && `${queueVM.name} is free.`}
                      {queueVM.holder === "user" && `You hold ${queueVM.name}.`}
                      {queueVM.holder !== null && queueVM.holder !== "user" && `${agentNames[queueVM.holder] ?? queueVM.holder} holds ${queueVM.name}.`}
                      {queueVM.status !== "running" && ` It is ${queueVM.status}.`}
                    </div>
                  )}
                </>
              )}
              {summary.place === null && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <StatusDot tone="gray" />
                  Not in a VM queue.
                </div>
              )}
              <div className="text-muted-foreground">
                Target VM:{" "}
                {summary.target_vm === null ? (
                  "none"
                ) : (
                  <a href={`#/vms/${summary.target_vm}`} className="text-primary hover:underline">
                    {summary.target_vm}
                  </a>
                )}
              </div>
            </div>

            {jobLists.map((list) => {
              const folded = foldedLists.includes(list.key);
              return (
                <div key={list.key}>
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-1 border-b bg-muted/40 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-expanded={!folded}
                    onClick={() => setFoldedLists(folded ? foldedLists.filter((key) => key !== list.key) : [...foldedLists, list.key])}
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", !folded && "rotate-90")} />
                    {list.label}
                    <span className="ml-0.5 tabular-nums">{list.jobs.length}</span>
                  </button>
                  {!folded && list.jobs.length === 0 && <div className="border-b px-3 py-2 text-muted-foreground">{list.empty}</div>}
                  {!folded &&
                    list.jobs.map((job) => (
                      <div key={job.id} className={cn("border-b px-3 py-1.5", !OPEN_STATUSES.includes(job.status) && "text-muted-foreground")}>
                        <div className="flex items-center gap-1.5">
                          <StatusDot tone={JOB_TONE[job.status] ?? "gray"} />
                          {job.repo !== null ? (
                            <a href={`#/issues?repo=${encodeURIComponent(job.repo)}`} className="truncate hover:underline" title={job.title}>
                              {job.title}
                            </a>
                          ) : (
                            <span className="truncate" title={job.title}>
                              {job.title}
                            </span>
                          )}
                          {job.status === "queued" && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="ml-auto shrink-0"
                              aria-label={`Remove ${job.id}`}
                              title="Remove it from the queue: the job is cancelled and the agent is told"
                              onClick={() => removeJob(job.id)}
                            >
                              <X />
                            </Button>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 pl-3.5 text-xs text-muted-foreground">
                          <span>{JOB_LABEL[job.status] ?? job.status}</span>
                          <span className="font-mono">{job.id}</span>
                          {job.vm !== null && (
                            <a href={`#/vms/${job.vm}`} className="text-primary hover:underline">
                              {job.vm}
                            </a>
                          )}
                          {job.drafts.map((draft) => (
                            <a key={draft} href={`#/inbox/${draft}`} className="font-mono text-primary hover:underline">
                              {draft}
                            </a>
                          ))}
                        </div>
                        {OPEN_STATUSES.includes(job.status) && (
                          <div className="space-y-0.5 py-0.5 pl-3.5">
                            <JobProgressBar job={job} />
                            {job.headline !== "" && <div className="line-clamp-2 text-xs">{job.headline}</div>}
                          </div>
                        )}
                        {job.notes !== "" && <div className="line-clamp-3 pl-3.5 text-xs whitespace-pre-wrap text-muted-foreground">{job.notes}</div>}
                      </div>
                    ))}
                </div>
              );
            })}

            <div className="flex h-7 items-center border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground">Todo</div>
            <div className="space-y-0.5 px-3 py-2">
              {todos.length === 0 && <div className="text-muted-foreground">No todo list yet.</div>}
              {todos.map((todo, index) => (
                <div key={index} className="flex items-start gap-2">
                  {todo.status === "completed" && <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" />}
                  {todo.status === "in_progress" && <CircleDot className="mt-0.5 size-3.5 shrink-0 text-primary" />}
                  {todo.status !== "completed" && todo.status !== "in_progress" && <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                  <span className={cn(todo.status === "completed" && "text-muted-foreground line-through", todo.status === "in_progress" && "font-medium")}>
                    {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
    </div>
  );
}
