/*
One agent's page: its name and id in the header (the id is unique and never changes); under the header, the job it is on now (its title and every step, the current one marked, and a
warning when it has been quiet too long; the rest of its progress is on the Jobs page); the conversation on the left;
on the right where it stands in a VM queue (or its priority line, after it stepped aside while its run goes), its jobs in two lists that each fold with their header: In queue (still to
do, being done or waiting on you, in the order it takes them, with their progress; a queued one has an x that takes it
off: the job is cancelled, and the agent is told) and Finished (done and cancelled, newest first), and the Desktop.
In phone mode (App.tsx, a screen under 768px wide) the right side is left out: the conversation takes the whole width.

The header has two tabs: Chat (all of the above) and Artifacts (AgentArtifacts.tsx: the agent's own folder of files,
pictures and screenshots). In the conversation, a picture the agent keeps there shows where it writes
![...](artifact:path).

The header's ⋯ menu has Archive (or Unarchive) and Delete, both asking first. Archive stops the agent, cancels its open
jobs and takes it out of every VM queue, but keeps this conversation; an archived agent's page says so, and sending it
a message brings it back. An agent that made PRs can't be deleted, only archived, so it keeps its context for updates.

The Desktop is the live screen of the agent's own desktop of the VM it holds or waits for (a VM has one to three, each
with its own screen), else of desktop 1 of its target VM: only the screen, like the VMs page's
picture, without noVNC's page and buttons around it (noVNC's own client draws it straight from the VM's VNC
connection; LiveDesktop.tsx, through the backend when the page came through the remote access domain), so it moves as
smoothly as the VM page's desktop. View-only: nothing reaches the VM from it. A click opens
it big in a pop-up on this page (still view-only; the VM's name above it links to the VM page, where you can use it).
Off, starting, not answering, or a terminal-only image say so instead.
Under the Desktop, cards for the same VM like the VMs page's: CPU, Memory and Internet (the number now and a chart of
the last minute; Internet also the data used since its count was last reset) and Disk (space used, a bar that turns
amber at 90%). They move on their own while the VM runs and say Off while it doesn't.

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
A new agent (nothing in its conversation yet, like one just made with New agent or the sidebar's +) opens with the
focus in the composer, so you can type to it right away.
Like Claude Code, Up in the composer (with the cursor on its first line) brings back your earlier messages, newest
first, the queued ones too; Down (on its last line) goes forward again, and Down after the newest brings back what you
were typing before.
Compact sends "/compact", which Claude Code runs on the conversation itself. The target VM can only
change while the agent is not queued for or holding a VM (the backend refuses it then).

A repository's agent (one that belongs to one of your repositories) drafts issues (draft_issue): each shows where it was drafted as a card
with the issue as it would be opened (its title, labels and text), Create issue (opens it on GitHub as you) and
Discard, and once decided, what became of it (the drafts come live, topic "issue_drafts").

compact is the chat on a repository's Agents tab (RepoAgents.tsx), next to its list of agents: a slim header (the
agent's name, a link to this page, where it is, Interrupt), the job it is on, and the conversation with the composer;
no tabs, target VM, context, job lists or Desktop. Esc interrupts only from the message box there.
*/

import {
  ArrowUp,
  Ban,
  BookOpen,
  Brain,
  Camera,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleHelp,
  Clock,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderGit2,
  Globe,
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
import LiveDesktop, { REMOTE } from "@/LiveDesktop";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { JobProgressBar, JobSteps, currentJob, stuckFor, useNow } from "@/components/ui/job-progress";
import { IssueRefText, Markdown } from "@/components/ui/markdown";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, JOB_LABEL, JOB_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useLive, useLiveValue, useLoaded, type HistoryEntry, type IssueDraft, type VMStatus } from "@/live";
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
// The backend keeps one usage sample per second for the last minute.
const SAMPLES = 60;
// The internet chart never scales below this, so an idle VM's few packets don't look like a busy line.
const INTERNET_CHART_MIN = 100_000;

// Data in the units a phone's data counter uses: 1 MB = 1,000,000 bytes (the same as the VMs page).
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(2)} GB`;
  }
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }
  if (bytes >= 1e3) {
    return `${Math.round(bytes / 1e3)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

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
  draft_issue: CircleDot,
  queue_for_vm: ListOrdered,
  desktop_add: ListOrdered,
  release_vm: ListOrdered,
  vm_queue_status: ListOrdered,
  browser_open: Globe,
  browser_read: Globe,
  browser_click: Globe,
  browser_type: Globe,
  browser_select: Globe,
  browser_fetch: Globe,
  browser_screenshot: Globe,
  browser_close: Globe,
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

// An issue a repository's agent drafted (draft_issue): the issue as it would be opened, with Create issue (opens it on
// GitHub as you) and Discard. Once decided it says so, with a link to the issue. Memoized like ToolRow: its markdown is
// only drawn again when the draft changes.
const IssueDraftCard = memo(function IssueDraftCard(props: { draft: IssueDraft }) {
  const { draft } = props;
  // The button whose request is on its way: "create" or "discard".
  const [busy, setBusy] = useState("");

  async function decide(action: "create" | "discard") {
    setBusy(action);
    try {
      const result = await api<IssueDraft>(`/api/issue_drafts/${draft.id}/${action}`, { method: "POST" });
      if (action === "create") {
        toast.success(`Created ${result.repo} #${result.number}`);
      }
    } catch (err) {
      toast.error(`Could not ${action === "create" ? "create the issue" : "discard it"}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  return (
    <div className="my-1 overflow-hidden rounded-lg border bg-card">
      <div className="flex h-8 items-center gap-1.5 border-b bg-muted/40 px-3 text-xs text-muted-foreground">
        <CircleDot className="size-3.5" />
        New issue in {draft.repo}
      </div>
      <div className="space-y-1.5 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{draft.title}</span>
          {draft.labels.map((label) => (
            <Badge key={label} variant="outline" className="py-0">
              {label}
            </Badge>
          ))}
        </div>
        <Markdown text={draft.body} repo={draft.repo} className="max-h-80 overflow-y-auto" />
      </div>
      <div className="flex min-h-10 items-center gap-2 border-t px-3 py-1.5">
        {draft.status === "pending" && (
          <>
            <Button size="sm" disabled={busy !== ""} title="Open it on GitHub, as you" onClick={() => decide("create")}>
              {busy === "create" && <Loader2 className="animate-spin" />}
              Create issue
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={() => decide("discard")}>
              Discard
            </Button>
          </>
        )}
        {draft.status === "created" && (
          <a href={draft.url ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-ok hover:underline">
            <CircleCheck className="size-3.5" /> Created #{draft.number} <ExternalLink className="size-3" />
          </a>
        )}
        {draft.status === "discarded" && <span className="text-muted-foreground">Discarded</span>}
      </div>
    </div>
  );
});

// The cards under the Desktop, like the VMs page's: CPU, Memory and Internet with a chart of the last minute, and
// Disk. A component of its own because it reads the whole VM list, which changes every second while the VM runs:
// only these cards re-render with it, not the conversation.
function VMUsageCards(props: { name: string }) {
  const vms = useLive("vms");
  const vm = vms.find((each) => each.name === props.name);
  if (vm === undefined) {
    return null;
  }
  const on = vm.status === "running";
  // The usage numbers are null until the first sample after a start (disk until the VM's agent runs).
  const cpu = vm.usage?.cpu_percent ?? null;
  const memory = vm.usage?.memory_used_gb ?? null;
  const disk = vm.usage?.disk_used_gb ?? null;
  const down = vm.usage?.net_down_rate ?? null;
  const up = vm.usage?.net_up_rate ?? null;

  // The internet chart shows download and upload together: it is all data used.
  const internetValues = vm.samples.map((sample) => {
    if (sample.net_down_rate === null || sample.net_up_rate === null) {
      return null;
    }
    return sample.net_down_rate + sample.net_up_rate;
  });
  let internetMax = INTERNET_CHART_MIN;
  for (const value of internetValues) {
    if (value !== null && value > internetMax) {
      internetMax = value;
    }
  }
  const charts = [
    {
      key: "cpu",
      label: "CPU",
      value: cpu === null ? "–" : `${Math.round(cpu)}%`,
      detail: `${vm.cpus} CPUs`,
      values: vm.samples.map((sample) => sample.cpu_percent),
      max: 100,
      extra: "",
    },
    {
      key: "memory",
      label: "Memory",
      value: memory === null ? "–" : `${memory.toFixed(1)} GB`,
      detail: `of ${vm.memory_gb} GB`,
      values: vm.samples.map((sample) => sample.memory_used_gb),
      max: vm.memory_gb,
      extra: "",
    },
    {
      key: "internet",
      label: "Internet",
      value: down === null || up === null ? "–" : `${formatBytes(down + up)}/s`,
      detail: vm.internet ? "" : "off",
      values: internetValues,
      max: internetMax,
      extra: `${formatBytes(vm.traffic.down + vm.traffic.up)} since reset`,
    },
  ];

  return (
    // Two cards a row, one when the column is narrow.
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 px-2 pb-2">
      {charts.map((chart) => {
        // Samples fill the chart from the right: the newest is at the right edge.
        const offset = SAMPLES - chart.values.length;
        const points: string[] = [];
        chart.values.forEach((value, index) => {
          if (value === null) {
            return;
          }
          const x = ((offset + index) / (SAMPLES - 1)) * 100;
          const y = 100 - Math.min(value / chart.max, 1) * 100;
          points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        });
        const first = points.length > 0 ? points[0].split(",")[0] : "0";
        const last = points.length > 0 ? points[points.length - 1].split(",")[0] : "0";
        return (
          <div key={chart.key} className="flex h-32 min-w-0 flex-col rounded-lg border bg-card p-2.5">
            <div className="text-muted-foreground">{chart.label}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-medium tabular-nums">{chart.value}</span>
              <span className="truncate text-xs text-muted-foreground">{chart.detail}</span>
            </div>
            <div className="relative mt-auto h-10 border-b">
              {points.length === 0 && (
                <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{on ? "Waiting…" : "Off"}</span>
              )}
              {points.length > 0 && (
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible text-primary">
                  <polygon points={`${first},100 ${points.join(" ")} ${last},100`} fill="currentColor" opacity="0.12" />
                  <polyline
                    points={points.join(" ")}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
            </div>
            {chart.extra !== "" && <div className="mt-1 truncate text-xs text-muted-foreground tabular-nums">{chart.extra}</div>}
          </div>
        );
      })}

      <div className="flex h-32 min-w-0 flex-col rounded-lg border bg-card p-2.5">
        <div className="text-muted-foreground">Disk</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-medium tabular-nums">{disk === null ? "–" : `${disk.toFixed(1)} GB`}</span>
          <span className="truncate text-xs text-muted-foreground">of {vm.disk_gb} GB</span>
        </div>
        {/* Gray, amber once the disk is 90% full (the VM starts failing when it fills). */}
        <div className="mt-auto mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", disk !== null && disk >= vm.disk_gb * 0.9 ? "bg-warn" : "bg-muted-foreground/70")}
            style={{ width: `${disk === null ? 0 : Math.min((disk / vm.disk_gb) * 100, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export default function AgentChat(props: { agentId: string; compact?: boolean }) {
  const agents = useLive("agents");
  // The issues repository agents drafted (only theirs have any): each shows as a card where it was drafted.
  const issueDrafts = useLive("issue_drafts");
  const jobs = useLive("jobs");
  // Only the VMs' names, states, desktops' holders and whether they answer, as one string: the whole VM list changes
  // every second while a VM runs (its usage samples), and this page would re-render with it.
  const vmsText = useLiveValue((topics) =>
    JSON.stringify(
      topics.vms.map((vm) => ({
        name: vm.name,
        status: vm.status,
        holders: Object.fromEntries(vm.desktops.map((desktop) => [desktop.number, desktop.holder])),
        responding: vm.usage === null || !vm.usage.on || vm.usage.responding,
      })),
    ),
  );
  const vms = JSON.parse(vmsText) as { name: string; status: VMStatus; holders: Record<number, string | null>; responding: boolean }[];
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
  // Up / Down in the composer: which of your sent messages it shows (null: none, what you were typing is there), and
  // what you were typing, for Down to bring back after the newest.
  const [recall, setRecall] = useState<number | null>(null);
  const [recallDraft, setRecallDraft] = useState("");
  const [seen, setSeen] = useState(false);
  // The header's confirm dialog: archive or delete this agent; null while closed.
  const [confirmAction, setConfirmAction] = useState<"archive" | "delete" | null>(null);
  // Chat or Artifacts. The chat stays mounted under Artifacts, so its scroll and desktop stay.
  const [pageTab, setPageTab] = useState("chat");
  // The job lists (In queue, Finished) folded on the right, by key.
  const [foldedLists, setFoldedLists] = useState<string[]>([]);
  // Phone mode (App.tsx, under 768px): the conversation only, without the right side.
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Follow the screen's width, also when a phone turns sideways.
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    function update() {
      setPhone(media.matches);
    }
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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

  // The Desktop on the right: the desktop of the VM the agent holds or waits for, else desktop 1 of its target VM.
  // Its address is asked once it runs and answers (again every 3 s until it has one), and forgotten when it stops or
  // stops answering, so the view connects afresh when it is back.
  let deskVM: string | null = null;
  let deskNumber = 1;
  if (summary !== undefined) {
    deskVM = summary.vm !== null ? summary.vm : summary.target_vm;
    deskNumber = summary.vm !== null && summary.desktop !== null ? summary.desktop : 1;
  }
  const deskInfo = vms.find((vm) => vm.name === deskVM);
  const deskReady = deskInfo !== undefined && deskInfo.status === "running" && deskInfo.responding;
  const [deskUrl, setDeskUrl] = useState<string | null>(null);
  // The VM has no desktop (a terminal-only image).
  const [deskTerminal, setDeskTerminal] = useState(false);
  const [deskBig, setDeskBig] = useState(false);
  useEffect(() => {
    setDeskUrl(null);
    if (deskVM === null || !deskReady) {
      return;
    }
    const name = deskVM;
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<{ desktop: string | null; terminal: string | null }>(
          `/api/vms/${encodeURIComponent(name)}/viewer?desktop=${deskNumber}`,
        );
        if (stopped) {
          return;
        }
        // answer.desktop is noVNC's page (http://<VM>:<port>/vnc.html?...); LiveDesktop takes the websocket that page
        // itself uses, on the same address. Through the remote access domain it goes through the backend instead.
        let url: string | null = null;
        if (answer.desktop !== null) {
          url = `ws://${new URL(answer.desktop).host}/websockify`;
        }
        if (answer.desktop !== null && REMOTE) {
          url = `wss://${window.location.host}/api/vms/${encodeURIComponent(name)}/vnc?desktop=${deskNumber}`;
        }
        setDeskUrl(url);
        setDeskTerminal(answer.desktop === null);
      } catch {
        if (!stopped) {
          timer = window.setTimeout(load, 3000);
        }
      }
    }
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [deskVM, deskNumber, deskReady]);
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
    if (!busy || props.compact) {
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
  }, [busy, props.agentId, props.compact]);

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
    setRecall(null);
    // Sending takes you to the bottom, to follow the answer.
    atBottom.current = true;
    try {
      await api(`/api/agents/${props.agentId}/message`, { method: "POST", body: { text: message } });
    } catch (err) {
      setText(message);
      toast.error(`Could not send: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Enter sends. Up on the composer's first line goes back through your sent messages, Down on its last line forward,
  // and Down after the newest brings back what you were typing, like Claude Code.
  function composerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }
    // Compact (a repo's Agents tab): Esc interrupts from here, not from anywhere on the page.
    if (event.key === "Escape" && props.compact && busy) {
      event.preventDefault();
      interrupt();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const box = event.currentTarget;
    const onFirstLine = !text.slice(0, box.selectionStart).includes("\n");
    const onLastLine = !text.slice(box.selectionEnd).includes("\n");
    if (event.key === "ArrowUp" && onFirstLine && sentMessages.length > 0) {
      event.preventDefault();
      if (recall === null) {
        setRecallDraft(text);
      }
      // Clamped: the list may have changed while browsing ("Show earlier", a message that went in).
      const from = recall === null ? sentMessages.length : Math.min(recall, sentMessages.length);
      const index = Math.max(from - 1, 0);
      setRecall(index);
      setText(sentMessages[index]);
    }
    if (event.key === "ArrowDown" && onLastLine && recall !== null) {
      event.preventDefault();
      if (recall >= sentMessages.length - 1) {
        setRecall(null);
        setText(recallDraft);
        return;
      }
      setRecall(recall + 1);
      setText(sentMessages[recall + 1]);
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

  // Pair tool calls with their results, and find where the last turn ended (a call after it with no result
  // yet is still running).
  const results: Record<string, ToolResult> = {};
  const toolIds = new Set<string>();
  let lastTurnEnd = -1;
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
  });

  const locked = summary.status === "in_queue" || summary.status === "in_priority" || summary.status === "using_vm";
  const cap = summary.context_max > 0 ? Math.min(summary.context_max, CONTEXT_CAP) : CONTEXT_CAP;
  const capText = cap >= 1_000_000 ? `${cap / 1_000_000}M` : `${Math.round(cap / 1000)}k`;
  const percent = Math.min(100, (summary.context_used / cap) * 100);
  // Summaries from before the backend sent the texts have none.
  const queued = summary.queued ?? [];
  // What Up and Down in the composer go through, oldest first: your messages in the loaded conversation (not the
  // Compact button's), then the queued ones.
  const sentMessages: string[] = [];
  for (const entry of entries) {
    if (entry.type === "user" && !entry.text.startsWith("/compact")) {
      sentMessages.push(entry.text);
    }
  }
  sentMessages.push(...queued);

  const vmNames = vms.map((vm) => vm.name);
  const queueVM = vms.find((vm) => vm.name === summary.vm);
  // Who holds the desktop the agent waits for (undefined: not known yet).
  const queueHolder = queueVM !== undefined && summary.desktop !== null ? queueVM.holders[summary.desktop] : undefined;
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

  // The conversation and the composer: the left side of the agent's page, and all of the chat on a repository's Live
  // tab (compact).
  const conversation = (
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
              {summary.repo !== null
                ? `Nothing yet. Ask ${summary.name} about the code, issues and pull requests, or tell it what to build: it writes the issue.`
                : `Nothing yet. Tell ${summary.name} what to look for, or give it an issue from the Issues page.`}
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

            // An issue the agent drafted: its card, once the call answered with the draft's id.
            if (entry.type === "tool" && entry.name === "draft_issue") {
              const answer = results[entry.id];
              const match = answer !== undefined && !answer.is_error ? /issue_[0-9a-f]{6}/.exec(answer.text) : null;
              const draft = match !== null ? issueDrafts.find((each) => each.id === match[0]) : undefined;
              if (draft !== undefined) {
                return <IssueDraftCard key={key} draft={draft} />;
              }
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
          {/* A new agent (nothing said yet, like one just made with New agent or the sidebar's +) opens with the
              focus here, so you can type to it right away. */}
          <Textarea
            className="max-h-48 min-h-14 resize-none"
            autoFocus={summary.history_length === 0}
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
            onKeyDown={composerKeyDown}
          />
          <Button size="icon" onClick={send} disabled={text.trim() === "" || pending >= MAX_QUEUED} aria-label="Send" title="Send (Enter)">
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {!props.compact && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
          <StatusDot tone={AGENT_TONE[summary.status] ?? "gray"} />
          <h1 className="font-semibold">{summary.name}</h1>
          <span className="font-mono text-xs text-muted-foreground max-md:hidden" title="Its id: unique, and it never changes, also when renamed">
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
            {summary.status === "in_priority" && `in priority #${summary.place} · ${summary.vm}`}
            {summary.status === "using_vm" && `using ${summary.vm}`}
            {summary.busy && summary.status !== "working" && " · working"}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2 max-md:ml-0 max-md:shrink max-md:flex-wrap">
            <span className="text-muted-foreground max-md:hidden">Target VM</span>
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
      )}
      {props.compact && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <StatusDot tone={AGENT_TONE[summary.status] ?? "gray"} />
          <a href={`#/agents/${summary.id}`} className="truncate font-semibold hover:underline" title="Its own page">
            {summary.name}
          </a>
          <span className="truncate text-muted-foreground">
            {summary.status === "idle" && "idle"}
            {summary.status === "working" && "working"}
            {summary.status === "in_queue" && `in queue #${summary.place} · ${summary.vm}`}
            {summary.status === "in_priority" && `in priority #${summary.place} · ${summary.vm}`}
            {summary.status === "using_vm" && `using ${summary.vm}`}
            {summary.busy && summary.status !== "working" && " · working"}
          </span>
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={interrupt} disabled={!summary.busy} title="Stop the current turn; the next queued message goes in (Esc in the message box)">
            <Square /> Interrupt
          </Button>
        </div>
      )}

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
        {(props.compact || phone) && conversation}
        {!props.compact && !phone && (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="70%" minSize="35%">
              {conversation}
            </ResizablePanel>

            <ResizableHandle />

            <ResizablePanel defaultSize="30%" minSize={240}>
              <div className="h-full overflow-y-auto">
                <div className="flex h-7 items-center border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground">VM queue</div>
                <div className="space-y-1 border-b px-3 py-2">
                  {summary.place === 0 && summary.vm !== null && (
                    <div className="flex items-center gap-1.5">
                      <StatusDot tone="green" />
                      Holds desktop {summary.desktop} of
                      <a href={`#/vms/${summary.vm}`} className="text-primary hover:underline">
                        {summary.vm}
                      </a>
                    </div>
                  )}
                  {summary.place !== null && summary.place > 0 && summary.vm !== null && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <StatusDot tone="amber" />
                        Number {summary.place} in the {summary.status === "in_priority" ? "priority line" : "queue"} for desktop {summary.desktop} of
                        <a href={`#/vms/${summary.vm}`} className="text-primary hover:underline">
                          {summary.vm}
                        </a>
                      </div>
                      {summary.status === "in_priority" && (
                        <div className="text-muted-foreground">It stepped aside while its run goes there, and gets the desktop back first.</div>
                      )}
                      {queueHolder !== undefined && queueVM !== undefined && (
                        <div className="text-muted-foreground">
                          {queueHolder === null && `Desktop ${summary.desktop} is free.`}
                          {queueHolder === "user" && `You hold desktop ${summary.desktop}.`}
                          {queueHolder !== null && queueHolder !== "user" && `${agentNames[queueHolder] ?? queueHolder} holds desktop ${summary.desktop}.`}
                          {queueVM.status !== "running" && ` ${queueVM.name} is ${queueVM.status}.`}
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

                <div className="flex h-7 items-center gap-1.5 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground">
                  Desktop
                  {deskVM !== null && (
                    <a href={`#/vms/${deskVM}`} className="font-normal text-primary hover:underline">
                      {deskVM}
                      {deskInfo !== undefined && deskInfo.holders.length > 1 && `, desktop ${deskNumber}`}
                    </a>
                  )}
                </div>
                <div className="p-2">
                  <div className="relative aspect-video overflow-hidden rounded-md border bg-muted/30">
                    {deskReady && deskUrl !== null && (
                      <>
                        <LiveDesktop url={deskUrl} viewOnly className="pointer-events-none absolute inset-0 bg-black" />
                        {/* Over the picture: a click opens it big, here on the page. */}
                        <button
                          type="button"
                          className="absolute inset-0 cursor-zoom-in"
                          aria-label={`Show the desktop of ${deskVM} big`}
                          title="Show it big"
                          onClick={() => setDeskBig(true)}
                        />
                      </>
                    )}
                    {deskVM === null && <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">No VM yet.</span>}
                    {deskInfo !== undefined && deskInfo.status !== "running" && (
                      <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{deskInfo.status === "stopped" ? "Off" : deskInfo.status}</span>
                    )}
                    {deskInfo !== undefined && deskInfo.status === "running" && deskUrl === null && !deskTerminal && (
                      <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Waiting for the desktop…</span>
                    )}
                    {deskReady && deskTerminal && (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                        <Terminal className="size-5" />
                        Terminal only
                      </span>
                    )}
                  </div>
                </div>
                {deskVM !== null && <VMUsageCards name={deskVM} />}

                <Dialog open={deskBig && deskReady && deskUrl !== null} onOpenChange={setDeskBig}>
                  <DialogContent className="flex h-[90vh] flex-col gap-2 sm:max-w-[95vw]">
                    <DialogHeader>
                      <DialogTitle>Desktop of {deskVM}</DialogTitle>
                      <DialogDescription>
                        Only to watch: nothing you do here reaches the VM. To use it, open{" "}
                        <a href={`#/vms/${deskVM}`} className="text-primary hover:underline" onClick={() => setDeskBig(false)}>
                          its page
                        </a>
                        .
                      </DialogDescription>
                    </DialogHeader>
                    {deskUrl !== null && <LiveDesktop url={deskUrl} viewOnly className="min-h-0 flex-1 overflow-hidden rounded-md bg-black" />}
                  </DialogContent>
                </Dialog>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
}
