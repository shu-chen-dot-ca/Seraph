/*
One VM's page: a header with its state and power buttons, and four tabs.

Overview is three areas with draggable dividers:
  desktop (noVNC in an iframe)  |  queue (who holds the desktop, who waits)
  ------------------------------+------------------------------------------
  stats (CPU, memory and internet speed over the last minute, disk, internet used)  and  the jobs on this VM
In phone mode (App.tsx, a screen under 768px wide) the queue is under the desktop instead, and stats and jobs take
half the width each.

A VM has one desktop or more, up to its max desktops (Settings). Each has its own screen, mouse, keyboard and home folder, so agents on different
desktops work at the same time without getting in each other's way. Each keeps its number: removing desktop 1 leaves
desktops 2 and 3 as they are, and the next new one is desktop 1 again (the lowest number free). With more than one,
buttons Desktop 1, Desktop 2, ... above the desktop pick which one the desktop area, its Lock, and the queue panel (its
holder, Priority and Runs) are about; each button's tooltip says who holds it, and its dot is green while the
desktop is free, amber while someone (an agent or you) holds it. × removes the desktop shown (it asks
first). + after them adds a desktop and shows it once it is up
(while the VM runs it is set up right away: under a minute the first time; it is gone once the VM has its max
desktops), and × after the last one removes that one (it asks first; its home folder stays). Both work running or
not. Waiting
is one line for the whole VM: the next agent gets the first desktop that frees up, unless it asked for one ("for
desktop 2"); Give hands the desktop shown to that agent. A desktop's iframe stays mounted once opened, so switching
back is instant.
Notes is VMNotes: what agents (and you) set up in this VM, for the next agent. #/vms/<name>?tab=notes opens it
(the VMs overview's Notes card links there).
Resources is VMResources: copy files and folders between this computer and the VM (only you; agents can't).
Settings is VMSettings. Fork (only while stopped) makes a new VM that starts as a copy of this one (ForkVMDialog).

App keeps this page mounted (hidden) after you leave it, and the Overview stays mounted while the
Notes, Resources or Settings tab is open, so the desktop iframe never reloads: coming back is instant, and always to the
Overview (the tab you were on isn't remembered). The iframe only
exists while the VM runs; its address comes from GET /api/vms/{name}/viewer?desktop=n, asked again (every 3 s)
until the VM has one. A VM from a terminal-only image has no desktop: the same area shows its terminal (ttyd).
Through the remote access domain (a phone) the VM's address can't be reached: the page draws the desktop itself
(LiveDesktop.tsx, its VNC connection through the backend), without New tab, and the terminal of a terminal-only image
isn't shown (it opens only on this computer).

The queue buttons map one to one onto the backend, for the desktop shown: Take over, Release (your own hold), Give
(the desktop goes to that agent now), Front (next in line) and Remove (out of the line, or the desktop taken away; the
agent is interrupted). An agent keeps its desktop while its run goes: nobody steps aside. Runs lists the long commands agents
left going in the VM, who started each and for how long; Stop ends one (it asks first), and its agent is told. When the desktop is locked (by an agent while it works, or by you),
a cover stops clicks and keys from reaching it, with an Unlock button. Over the desktop, the agent's cursor
(AgentCursor.tsx) shows where the agent on it clicks, with its name: white while it works, gray while it doesn't.

When the VM runs but doesn't answer (still booting, or frozen: Incus still says Running), a notice over
the desktop says so and offers Restart. Once it answers again after more than a few seconds, the desktop
reloads by itself: noVNC's own reconnect can't recover a page that failed to load while the VM was down.

Internet used is what the VM downloaded and uploaded since the last Reset, for watching a metered connection
(a phone hotspot). It counts only traffic that leaves this machine: not the desktop or terminals shown here.
What the backend itself uses (the agents talking to Claude and GitHub) isn't in it.
*/

import { Copy, ExternalLink, Loader2, Lock, Monitor, Play, Plus, Power, RotateCw, Square, Unlock, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import AgentCursor from "@/AgentCursor";
import ForkVMDialog from "@/ForkVMDialog";
import LiveDesktop, { REMOTE } from "@/LiveDesktop";
import VMNotes from "@/VMNotes";
import VMResources from "@/VMResources";
import VMSettings from "@/VMSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
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
import { JobProgressBar, currentJob } from "@/components/ui/job-progress";
import { AGENT_TONE, JOB_LABEL, JOB_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type VMRun } from "@/live";
import { cn } from "@/lib/utils";

// The backend keeps one sample per second for the last minute.
const SAMPLES = 60;

const OPEN_JOB = ["queued", "working", "waiting_on_user", "waiting_on_maintainers"];

const STATUS_TEXT: Record<string, string> = {
  creating: "Creating",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  starting: "Starting",
  failed: "Failed",
  missing: "Missing",
};

// Data in the units a phone's data counter uses: 1 MB = 1,000,000 bytes. Used for every speed and total on the page.
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

// The internet chart never scales below this, so an idle VM's few packets don't look like a busy line.
const INTERNET_CHART_MIN = 100_000;

export default function VMPage(props: { name: string; active: boolean; tab: string | null }) {
  const vms = useLive("vms");
  const loaded = useLoaded("vms");
  const imagesData = useLive("images");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const [tab, setTab] = useState("overview");
  // Leaving the page puts it back on the Overview, so coming back always starts there, unless the address names
  // the Notes tab (#/vms/<name>?tab=notes).
  useEffect(() => {
    if (!props.active) {
      setTab("overview");
      return;
    }
    if (props.tab === "notes") {
      setTab("notes");
    }
  }, [props.active, props.tab]);
  // Each desktop's noVNC page by its number (1, 2, 3), once known.
  const [desktopUrls, setDesktopUrls] = useState<Record<number, string>>({});
  // The VM has no desktop (a terminal-only image): desktopUrls[1] is its terminal.
  const [terminalOnly, setTerminalOnly] = useState(false);
  // The desktop shown, and the ones opened since the page loaded (their iframes stay, so switching back is instant).
  const [desk, setDesk] = useState(1);
  const [opened, setOpened] = useState<number[]>([1]);
  const [viewerError, setViewerError] = useState("");
  // Bumped by Reconnect: a new iframe key loads the desktop again.
  const [reload, setReload] = useState(0);
  // The button whose request is on its way, e.g. "start" or "give:agent_x".
  const [busy, setBusy] = useState("");
  const [hover, setHover] = useState<{ chart: string; index: number } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // × after the last desktop asks "are you sure?" now.
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The run whose Stop asks "are you sure?" now.
  const [stopRun, setStopRun] = useState<VMRun | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [forking, setForking] = useState(false);
  // Phone mode (App.tsx, under 768px): the queue goes under the desktop instead of beside it.
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  // Follow the screen's width, also when a phone turns sideways.
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    function update() {
      setPhone(media.matches);
    }
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // When the VM stopped answering (Date.now()), or null while it answers.
  const silentSince = useRef<number | null>(null);

  const name = props.name;
  const vm = vms.find((each) => each.name === name);
  const running = vm !== undefined && vm.status === "running";
  const count = vm !== undefined ? vm.desktops.length : 1;
  // The VM's desktops by number, e.g. [2, 3] after desktop 1 was removed.
  const numbers = vm !== undefined ? vm.desktops.map((each) => each.number) : [1];
  const numbersKey = numbers.join(",");
  // A desktop that went away falls back to the VM's first one.
  const shown = numbers.includes(desk) ? desk : numbers[0];
  // The number the next new desktop gets: the lowest one free.
  let nextNumber = 1;
  while (numbers.includes(nextNumber)) {
    nextNumber++;
  }
  const lockedBy = vm !== undefined ? (vm.locked_by[shown] ?? null) : null;
  const locked = lockedBy !== null;
  const desktopUrl = desktopUrls[shown] ?? null;
  const silent = running && vm.usage !== null && vm.usage.on && !vm.usage.responding;

  // Ask where each desktop is once the VM runs; forget them when it stops.
  useEffect(() => {
    if (!running) {
      setDesktopUrls({});
      setViewerError("");
      return;
    }
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const urls: Record<number, string> = {};
        let terminal = false;
        for (const number of numbersKey.split(",").map(Number)) {
          const answer = await api<{ desktop: string | null; terminal: string | null }>(
            `/api/vms/${encodeURIComponent(name)}/viewer?desktop=${number}`,
          );
          urls[number] = answer.desktop ?? answer.terminal ?? "";
          terminal = answer.desktop === null;
          // A terminal-only image has no desktops: its one terminal is all there is.
          if (terminal) {
            break;
          }
        }
        if (stopped) {
          return;
        }
        setDesktopUrls(urls);
        setTerminalOnly(terminal);
        setViewerError("");
      } catch (err) {
        if (stopped) {
          return;
        }
        // Right after a start the VM has no address yet: try again shortly.
        setViewerError(err instanceof Error ? err.message : String(err));
        timer = window.setTimeout(load, 3000);
      }
    }
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [name, running, numbersKey]);

  // Reload the desktop when the VM answers again after a while (a blip of a second or two doesn't count).
  useEffect(() => {
    if (silent) {
      silentSince.current = Date.now();
      return;
    }
    if (silentSince.current !== null && Date.now() - silentSince.current > 5000) {
      setReload((current) => current + 1);
    }
    silentSince.current = null;
  }, [silent]);

  // When the desktop gets locked, take the keyboard away from it too.
  useEffect(() => {
    if (locked && frameRef.current !== null && document.activeElement === frameRef.current) {
      frameRef.current.blur();
    }
  }, [locked]);

  if (!loaded) {
    return <div className="p-3 text-muted-foreground">Loading…</div>;
  }
  if (vm === undefined) {
    return (
      <div className="p-3 text-muted-foreground">
        There is no VM named {name}.{" "}
        <a href="#/vms" className="text-primary hover:underline">
          All VMs
        </a>
      </div>
    );
  }

  const agentById: Record<string, (typeof agents)[number]> = {};
  for (const agent of agents) {
    agentById[agent.id] = agent;
  }
  const error = vm.error;
  // The desktop shown: who holds it, who waits for it, and the runs going on it. Runs on a desktop the VM no longer has
  // (taken back while the VM was full) show on every desktop, so they can still be stopped.
  const line = vm.desktops.find((each) => each.number === shown) ?? vm.desktops[0];
  const holder = line.holder;
  const runs = vm.runs.filter((run) => (run.desktop ?? 1) === shown || !vm.desktops.some((each) => each.number === (run.desktop ?? 1)));
  const holderAgent = holder !== null && holder !== "user" ? agentById[holder] : undefined;
  // The job the holding agent is on, with its progress, for the queue panel.
  const holderJob = holderAgent !== undefined ? currentJob(holderAgent.id, jobs) : undefined;
  // The image's name now (it may have been renamed since), or the name it was made with.
  const madeFrom = imagesData.images.find((image) => image.fingerprint === vm.image_fingerprint);
  const imageName = madeFrom !== undefined ? madeFrom.name : vm.image || "unknown image";

  // Jobs on this VM: open ones first, then the latest.
  const vmJobs = jobs
    .filter((job) => job.vm === name)
    .sort((a, b) => {
      const aOpen = OPEN_JOB.includes(a.status) ? 0 : 1;
      const bOpen = OPEN_JOB.includes(b.status) ? 0 : 1;
      if (aOpen !== bOpen) {
        return aOpen - bOpen;
      }
      return b.updated_at.localeCompare(a.updated_at);
    });
  const openJobs = vmJobs.filter((job) => OPEN_JOB.includes(job.status)).length;

  // Usage is null until the first sample after a start (and disk until the VM's agent runs).
  const cpu = vm.usage?.cpu_percent ?? null;
  const memory = vm.usage?.memory_used_gb ?? null;
  const disk = vm.usage?.disk_used_gb ?? null;
  const down = vm.usage?.net_down_rate ?? null;
  const up = vm.usage?.net_up_rate ?? null;
  // The chart shows download and upload together: it is all data used.
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
      values: vm.samples.map((sample) => sample.cpu_percent),
      max: 100,
      value: cpu === null ? "–" : `${Math.round(cpu)}%`,
      detail: `${vm.cpus} CPUs`,
      format: (value: number) => `${value.toFixed(0)}%`,
    },
    {
      key: "memory",
      label: "Memory",
      values: vm.samples.map((sample) => sample.memory_used_gb),
      max: vm.memory_gb,
      value: memory === null ? "–" : `${memory.toFixed(1)} GB`,
      detail: `of ${vm.memory_gb} GB`,
      format: (value: number) => `${value.toFixed(1)} GB`,
    },
    {
      key: "internet",
      label: "Internet",
      values: internetValues,
      max: internetMax,
      value: down === null || up === null ? "–" : `${formatBytes(down + up)}/s`,
      detail: down === null || up === null ? "" : `↓ ${formatBytes(down)}/s ↑ ${formatBytes(up)}/s`,
      format: (value: number) => `${formatBytes(value)}/s`,
    },
  ];

  async function power(action: "start" | "stop" | "restart") {
    setBusy(action);
    try {
      await api(`/api/vms/${encodeURIComponent(name)}/${action}`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not ${action} ${name}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  // take_over, release and give act on the desktop shown; give, front, skip and remove name an agent.
  async function queueAction(action: "take_over" | "release" | "give" | "front" | "skip" | "remove", agentId: string | null) {
    setBusy(agentId === null ? action : `${action}:${agentId}`);
    try {
      const body = agentId === null ? { desktop: shown } : { agent: agentId, desktop: shown };
      await api(`/api/vms/${encodeURIComponent(name)}/${action}`, { method: "POST", body: body });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function stopRunNow(runId: string) {
    setBusy(`stop:${runId}`);
    try {
      await api(`/api/vms/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not stop the run: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function resetTraffic() {
    try {
      await api(`/api/vms/${encodeURIComponent(name)}/traffic/reset`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not reset the count: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function setLock(enabled: boolean) {
    if (enabled && frameRef.current !== null) {
      frameRef.current.blur();
    }
    setBusy("lock");
    try {
      await api(`/api/vms/${encodeURIComponent(name)}/lock`, { method: "PUT", body: { enabled: enabled, desktop: shown } });
    } catch (err) {
      toast.error(`Could not ${enabled ? "lock" : "unlock"} the desktop: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  const canStart = vm.status === "stopped" || vm.status === "failed";

  function showDesktop(number: number) {
    setDesk(number);
    if (!opened.includes(number)) {
      setOpened([...opened, number]);
    }
  }

  // Answers once the new desktop is up, then shows it.
  async function addDesktop() {
    setBusy("add_desktop");
    try {
      const answer = await api<{ desktop: number }>(`/api/vms/${encodeURIComponent(name)}/desktops`, { method: "POST" });
      showDesktop(answer.desktop);
    } catch (err) {
      toast.error(`Could not add desktop ${nextNumber}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function removeDesktop(number: number) {
    setBusy("remove_desktop");
    try {
      await api(`/api/vms/${encodeURIComponent(name)}/desktops/${number}`, { method: "DELETE" });
    } catch (err) {
      toast.error(`Could not remove desktop ${number}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
        <Monitor className="size-4 text-muted-foreground" />
        <h1 className="font-semibold">{vm.name}</h1>
        <Badge variant="secondary" title={error ?? undefined}>
          <StatusDot tone={VM_TONE[vm.status]} />
          {STATUS_TEXT[vm.status] ?? vm.status}
        </Badge>
        <span className="text-muted-foreground max-md:hidden">
          {imageName}
          {vm.forked_from !== "" && ` · forked from ${vm.forked_from}`}
          {vm.internet ? "" : " · no internet"}
        </span>
        <div className="ml-2 flex items-center gap-1 max-md:ml-0">
          <Button variant="outline" size="sm" disabled={!canStart || busy !== ""} onClick={() => power("start")}>
            {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} Start
          </Button>
          <Button variant="outline" size="sm" disabled={!running || busy !== ""} onClick={() => power("stop")}>
            {busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />} Stop
          </Button>
          <Button variant="outline" size="sm" disabled={!running || busy !== ""} onClick={() => power("restart")}>
            {busy === "restart" ? <Loader2 className="animate-spin" /> : <RotateCw />} Restart
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={vm.status !== "stopped" || busy !== ""}
            title={vm.status === "stopped" ? `A new VM that starts as a copy of ${vm.name}` : `Stop ${vm.name} to fork it`}
            onClick={() => setForking(true)}
          >
            <Copy /> Fork
          </Button>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="ml-auto max-w-full overflow-x-auto max-md:ml-0">
          <TabsList>
            <TabsTrigger value="overview" className="px-2.5">
              Overview
            </TabsTrigger>
            <TabsTrigger value="notes" className="px-2.5">
              Notes
              {vm.notes.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{vm.notes.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="resources" className="px-2.5">
              Resources
            </TabsTrigger>
            <TabsTrigger value="settings" className="px-2.5">
              Settings
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Hidden, not unmounted, while another tab is open: the desktop keeps its connection.
          While a divider is dragged the desktop (iframe or canvas) ignores the pointer, or it would swallow the drag. */}
      <div
        className={
          tab === "overview"
            ? "min-h-0 flex-1 [&:has([data-separator=active])_canvas]:pointer-events-none [&:has([data-separator=active])_iframe]:pointer-events-none"
            : "hidden"
        }
      >
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel defaultSize="68" minSize="25">
            <ResizablePanelGroup key={phone ? "phone" : "computer"} orientation={phone ? "vertical" : "horizontal"}>
              <ResizablePanel defaultSize="76" minSize="30">
                <div className="flex h-full flex-col">
                  <div className="flex h-7 shrink-0 items-center gap-1 border-b bg-muted/40 px-2 text-xs">
                    {terminalOnly && <span className="font-medium text-muted-foreground">Terminal</span>}
                    {!terminalOnly && count === 1 && (
                      <span
                        className="flex items-center gap-1.5 font-medium text-muted-foreground"
                        title={vm.desktops[0].holder === null ? "Free" : "Held"}
                      >
                        <span className={cn("size-2 shrink-0 rounded-full", vm.desktops[0].holder === null ? "bg-ok" : "bg-warn")} />
                        {numbers[0] === 1 ? "Desktop" : `Desktop ${numbers[0]}`}
                      </span>
                    )}
                    {!terminalOnly &&
                      count > 1 &&
                      vm.desktops.map((each) => {
                        const number = each.number;
                        let heldBy = "Free";
                        if (each.holder === "user") {
                          heldBy = "Held by you";
                        }
                        if (each.holder !== null && each.holder !== "user") {
                          heldBy = `Held by ${agentById[each.holder]?.name ?? each.holder}`;
                        }
                        return (
                          <Button
                            key={number}
                            variant={number === shown ? "secondary" : "ghost"}
                            size="xs"
                            title={heldBy}
                            onClick={() => showDesktop(number)}
                          >
                            <span className={cn("size-2 shrink-0 rounded-full", each.holder === null ? "bg-ok" : "bg-warn")} />
                            Desktop {number}
                          </Button>
                        );
                      })}
                    {!terminalOnly && count > 1 && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title={`Remove desktop ${shown}`}
                        aria-label={`Remove desktop ${shown}`}
                        disabled={busy !== ""}
                        onClick={() => setConfirmRemove(true)}
                      >
                        {busy === "remove_desktop" ? <Loader2 className="animate-spin" /> : <X />}
                      </Button>
                    )}
                    {!terminalOnly && count < vm.max_desktops && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title={busy === "add_desktop" ? `Setting up desktop ${nextNumber}…` : "New desktop"}
                        aria-label="New desktop"
                        disabled={busy !== ""}
                        onClick={addDesktop}
                      >
                        {busy === "add_desktop" ? <Loader2 className="animate-spin" /> : <Plus />}
                      </Button>
                    )}
                    {running && desktopUrl !== null && (
                      <div className="ml-auto flex items-center gap-0.5">
                        {!terminalOnly && (
                          <Button variant="ghost" size="xs" disabled={busy === "lock"} onClick={() => setLock(!locked)}>
                            {locked ? <Unlock /> : <Lock />}
                            {locked ? "Unlock" : "Lock"}
                          </Button>
                        )}
                        <Button variant="ghost" size="xs" title="Connect again" onClick={() => setReload(reload + 1)}>
                          <RotateCw /> Reconnect
                        </Button>
                        {!REMOTE && (
                          <Button variant="ghost" size="xs" asChild>
                            <a href={desktopUrl} target="_blank" rel="noreferrer" title="Open it in its own tab">
                              <ExternalLink /> New tab
                            </a>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="relative min-h-0 flex-1 bg-muted/30">
                    {running &&
                      (opened.includes(shown) ? opened : [...opened, shown]).map((number) => {
                        const url = desktopUrls[number];
                        if (url === undefined || !numbers.includes(number)) {
                          return null;
                        }
                        if (REMOTE && terminalOnly) {
                          return (
                            <div key={number} className="flex h-full items-center justify-center px-4 text-center text-muted-foreground">
                              The terminal opens only on this computer.
                            </div>
                          );
                        }
                        if (REMOTE) {
                          return (
                            <LiveDesktop
                              key={`${number}-${reload}`}
                              url={`wss://${window.location.host}/api/vms/${encodeURIComponent(name)}/vnc?desktop=${number}`}
                              viewOnly={(vm.locked_by[number] ?? null) !== null}
                              className={cn("absolute inset-0 size-full bg-black", number !== shown && "hidden")}
                            />
                          );
                        }
                        return (
                          <iframe
                            key={`${url}-${reload}`}
                            ref={number === shown ? frameRef : undefined}
                            src={url}
                            title={terminalOnly ? `Terminal of ${vm.name}` : `Desktop ${number} of ${vm.name}`}
                            allow="clipboard-write"
                            className={cn("absolute inset-0 size-full border-0 bg-black", number !== shown && "hidden")}
                          />
                        );
                      })}

                    {/* The agent's cursor where it clicks; a new one for each desktop, so switching doesn't glide. */}
                    {running && desktopUrl !== null && !terminalOnly && <AgentCursor key={shown} vm={vm} desktop={shown} />}

                    {silent && (
                      <div className="absolute inset-x-0 top-2 z-10 flex justify-center px-2">
                        <div className="flex items-center gap-2 rounded-md border bg-background py-1 pr-1 pl-2.5">
                          <Loader2 className="size-3.5 animate-spin text-warn" />
                          {vm.name} isn't answering: it is still booting, or it froze.
                          <Button size="xs" variant="outline" disabled={busy !== ""} onClick={() => power("restart")}>
                            <RotateCw /> Restart
                          </Button>
                        </div>
                      </div>
                    )}

                    {running && desktopUrl !== null && locked && !terminalOnly && (
                      <div className="absolute inset-0 cursor-not-allowed">
                        <div className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background py-1 pr-1 pl-2.5 whitespace-nowrap">
                          <Lock className="size-3.5 text-warn" />
                          {lockedBy === "agent" ? "Locked by the agent while it works" : "You locked your mouse and keyboard out"}
                          <Button size="xs" variant="outline" disabled={busy === "lock"} onClick={() => setLock(false)}>
                            <Unlock /> Unlock
                          </Button>
                        </div>
                      </div>
                    )}

                    {running && desktopUrl === null && (
                      <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
                        <span className="flex items-center gap-2">
                          <Loader2 className="size-3.5 animate-spin" /> Connecting…
                        </span>
                        {viewerError !== "" && <span className="text-xs">{viewerError} Trying again.</span>}
                      </div>
                    )}

                    {!running && (
                      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                        {(vm.status === "creating" || vm.status === "starting" || vm.status === "stopping") && (
                          <span className="flex items-center gap-2">
                            <Loader2 className="size-3.5 animate-spin" />
                            {vm.status === "creating" && `Creating ${vm.name}. This takes about a minute.`}
                            {vm.status === "starting" && `Starting ${vm.name}…`}
                            {vm.status === "stopping" && `Stopping ${vm.name}…`}
                          </span>
                        )}
                        {(vm.status === "stopped" || vm.status === "failed") && (
                          <>
                            <Power className="size-6" />
                            <span>{vm.status === "stopped" ? `${vm.name} is off.` : `${vm.name} failed.`}</span>
                            {error !== null && <span className="max-w-lg text-xs text-destructive">{error}</span>}
                            <Button size="sm" disabled={busy !== ""} onClick={() => power("start")}>
                              {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} Start
                            </Button>
                          </>
                        )}
                        {vm.status === "missing" && (
                          <span>
                            The Incus VM {vm.incus_name} is gone. Delete {vm.name} in Settings, or bring the Incus VM back.
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle />

              <ResizablePanel defaultSize="24" minSize={phone ? 60 : 220}>
                <div className="flex h-full flex-col">
                  <div className="flex h-7 shrink-0 items-center gap-1 border-b bg-muted/40 px-2 text-xs">
                    <span className="font-medium text-muted-foreground">{count > 1 ? `Queue · Desktop ${shown}` : "Queue"}</span>
                    {holder !== "user" && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ml-auto"
                        title={holderAgent !== undefined ? `${holderAgent.name} goes back to the front of the queue` : "Hold this desktop yourself"}
                        disabled={busy !== ""}
                        onClick={() => queueAction("take_over", null)}
                      >
                        <User /> Take over
                      </Button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Holder</div>
                    {holder === null && <div className="flex h-7 items-center px-2 text-muted-foreground">Free</div>}
                    {holder === "user" && (
                      <div className="flex h-7 items-center gap-2 px-2">
                        <User className="size-3.5 text-primary" />
                        You
                        <Button variant="outline" size="xs" className="ml-auto" disabled={busy !== ""} onClick={() => queueAction("release", null)}>
                          Release
                        </Button>
                      </div>
                    )}
                    {holder !== null && holder !== "user" && (
                      <div className="px-2">
                        <div className="flex h-7 items-center gap-2">
                          <StatusDot tone={holderAgent !== undefined ? AGENT_TONE[holderAgent.status] : "gray"} />
                          <a href={`#/agents/${holder}`} className="truncate text-primary hover:underline">
                            {holderAgent?.name ?? holder}
                          </a>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            title="Take the desktop away from this agent (it is interrupted)"
                            disabled={busy !== ""}
                            onClick={() => queueAction("remove", holder)}
                          >
                            <X /> Remove
                          </Button>
                        </div>
                        {holderJob !== undefined && (
                          <div className="space-y-0.5 pb-1">
                            <a href={`#/jobs/${holderJob.id}`} className="block truncate hover:underline" title={holderJob.title}>
                              {holderJob.title}
                            </a>
                            <JobProgressBar job={holderJob} />
                            {holderJob.headline !== "" && <div className="line-clamp-2 text-xs">{holderJob.headline}</div>}
                          </div>
                        )}
                        {holderAgent !== undefined && holderAgent.activity !== "" && (
                          <div className="truncate pb-1 text-xs text-muted-foreground" title={holderAgent.activity}>
                            {holderAgent.activity}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="mt-1 border-t px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Waiting ({vm.queue.length})</div>
                    {vm.queue.length === 0 && <div className="flex h-7 items-center px-2 text-muted-foreground">No agent is waiting.</div>}
                    {vm.queue.map((agentId, index) => {
                      const agent = agentById[agentId];
                      const wants = vm.wants[agentId];
                      return (
                        <div key={agentId} className="flex h-7 items-center gap-1.5 px-2 hover:bg-accent/40">
                          <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
                          <a href={`#/agents/${agentId}`} className="min-w-0 truncate text-primary hover:underline">
                            {agent?.name ?? agentId}
                          </a>
                          {count > 1 && wants !== undefined && <span className="shrink-0 text-xs text-muted-foreground">for desktop {wants}</span>}
                          <span className="ml-auto flex shrink-0 items-center">
                            <Button
                              variant="ghost"
                              size="xs"
                              title={`Give desktop ${shown} to this agent now`}
                              disabled={busy !== ""}
                              onClick={() => queueAction("give", agentId)}
                            >
                              Give
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              title="Make this agent next in line"
                              disabled={index === 0 || busy !== ""}
                              onClick={() => queueAction("front", agentId)}
                            >
                              Front
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Remove ${agent?.name ?? agentId} from the queue`}
                              title="Remove from the queue (the agent is interrupted)"
                              disabled={busy !== ""}
                              onClick={() => queueAction("remove", agentId)}
                            >
                              <X />
                            </Button>
                          </span>
                        </div>
                      );
                    })}

                    {runs.length > 0 && (
                      <div className="mt-1 border-t px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Runs ({runs.length})</div>
                    )}
                    {runs.map((run) => {
                      const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(run.started_at)) / 60000));
                      const took = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
                      return (
                        <div key={run.id} className="flex items-center gap-1.5 px-2 py-1 hover:bg-accent/40">
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-xs" title={run.label}>
                              {run.label}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              <a href={`#/agents/${run.agent}`} className="hover:underline">
                                {agentById[run.agent]?.name ?? run.agent}
                              </a>
                              {(run.desktop ?? 1) !== shown && ` · desktop ${run.desktop ?? 1}, taken back`}
                              {" · "}
                              {run.stopped_by_user ? "stopping" : took}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Stop ${run.label}`}
                            title="Stop this run"
                            disabled={busy !== "" || run.stopped_by_user}
                            onClick={() => setStopRun(run)}
                          >
                            <Square />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize="32" minSize={120}>
            <div className="flex h-full">
              <div className="w-80 shrink-0 overflow-auto border-r max-md:w-1/2">
                <div className="flex h-7 items-center border-b bg-muted/40 px-2 text-xs font-medium text-muted-foreground">Stats</div>
                <div className="space-y-2.5 p-2">
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
                    const hovered = hover !== null && hover.chart === chart.key ? hover.index : null;
                    const hoveredValue = hovered === null ? null : chart.values[hovered];
                    const hoverX = hovered === null ? 0 : ((offset + hovered) / (SAMPLES - 1)) * 100;
                    const hoverY = hoveredValue === null || hoveredValue === undefined ? 0 : 100 - Math.min(hoveredValue / chart.max, 1) * 100;
                    const secondsAgo = hovered === null ? 0 : chart.values.length - 1 - hovered;
                    return (
                      <div key={chart.key}>
                        <div className="flex items-baseline gap-2">
                          <span className="text-muted-foreground">{chart.label}</span>
                          <span className="ml-auto font-medium tabular-nums">{chart.value}</span>
                          <span className="text-xs text-muted-foreground">{chart.detail}</span>
                        </div>
                        <div
                          className="relative mt-1 h-10 border-b"
                          onMouseMove={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            const slot = Math.round(((event.clientX - rect.left) / rect.width) * (SAMPLES - 1));
                            const index = slot - offset;
                            if (index < 0 || index >= chart.values.length) {
                              setHover(null);
                              return;
                            }
                            setHover({ chart: chart.key, index: index });
                          }}
                          onMouseLeave={() => setHover(null)}
                        >
                          {points.length === 0 && (
                            <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                              {running ? "Waiting for the first sample…" : "No data while the VM is off"}
                            </span>
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
                          {hoveredValue !== null && hoveredValue !== undefined && (
                            <>
                              <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30" style={{ left: `${hoverX}%` }} />
                              <div
                                className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
                                style={{ left: `${hoverX}%`, top: `${hoverY}%` }}
                              />
                              <div
                                className={cn(
                                  "pointer-events-none absolute -top-6 rounded-sm border bg-popover px-1.5 text-xs whitespace-nowrap tabular-nums",
                                  hoverX > 60 ? "-translate-x-full" : "",
                                )}
                                style={{ left: `${hoverX}%` }}
                              >
                                {chart.format(hoveredValue)} <span className="text-muted-foreground">{secondsAgo === 0 ? "now" : `${secondsAgo}s ago`}</span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-muted-foreground">Disk</span>
                      <span className="ml-auto font-medium tabular-nums">{disk === null ? "–" : `${disk.toFixed(1)} GB`}</span>
                      <span className="text-xs text-muted-foreground">of {vm.disk_gb} GB</span>
                    </div>
                    {/* Gray like the other meters, amber once the disk is 90% full (the VM starts failing when it fills). */}
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", disk !== null && disk >= vm.disk_gb * 0.9 ? "bg-warn" : "bg-muted-foreground/70")}
                        style={{ width: `${disk === null ? 0 : Math.min((disk / vm.disk_gb) * 100, 100)}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Internet used</span>
                      <span className="ml-auto font-medium tabular-nums">{formatBytes(vm.traffic.down + vm.traffic.up)}</span>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmReset(true)}>
                        Reset
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      ↓ {formatBytes(vm.traffic.down)} ↑ {formatBytes(vm.traffic.up)} since{" "}
                      {new Date(vm.traffic.since).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">State</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <StatusDot tone={VM_TONE[vm.status]} />
                      {STATUS_TEXT[vm.status] ?? vm.status}
                    </span>
                  </div>
                  {error !== null && <div className="text-xs text-destructive">{error}</div>}
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Internet</span>
                    <span className="ml-auto">{vm.internet ? "On" : "Off"}</span>
                  </div>
                </div>
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-muted/40 px-2 text-xs font-medium text-muted-foreground">
                  Jobs on {vm.name}
                  <span className="font-normal tabular-nums">
                    {openJobs} open · {vmJobs.length} total
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {vmJobs.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">No jobs on this VM yet. Assign an issue to an agent aimed at it.</div>}
                  {vmJobs.map((job) => (
                    <div key={job.id} className="flex h-7 items-center gap-3 border-b px-2" title={job.notes || undefined}>
                      <span className="flex w-28 shrink-0 items-center gap-1.5">
                        <StatusDot tone={JOB_TONE[job.status] ?? "gray"} />
                        {JOB_LABEL[job.status] ?? job.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{job.title}</span>
                      <a href={`#/agents/${job.agent}`} className="shrink-0 text-primary hover:underline">
                        {agentById[job.agent]?.name ?? job.agent}
                      </a>
                      {job.drafts.map((draft) => (
                        <a key={draft} href={`#/inbox/${draft}`} className="shrink-0 font-mono text-xs text-primary hover:underline">
                          {draft}
                        </a>
                      ))}
                      <span className="shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">
                        {new Date(job.updated_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {tab === "notes" && (
        <div className="min-h-0 flex-1">
          <VMNotes name={vm.name} />
        </div>
      )}

      {tab === "resources" && (
        <div className="min-h-0 flex-1">
          <VMResources name={vm.name} />
        </div>
      )}

      {tab === "settings" && (
        <div className="min-h-0 flex-1">
          <VMSettings name={vm.name} />
        </div>
      )}

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the internet count of {vm.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {formatBytes(vm.traffic.down + vm.traffic.up)} used so far. It counts from zero again, from now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={resetTraffic}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove desktop {shown} of {vm.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {running && "Its windows close. "}
              The other desktops keep their numbers. Its home folder stays, with everything in it, for when {vm.name} gets
              a desktop {shown} again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeDesktop(shown)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={stopRun !== null}
        onOpenChange={(open) => {
          if (!open) {
            setStopRun(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this run?</AlertDialogTitle>
            <AlertDialogDescription>
              {stopRun !== null && `${agentById[stopRun.agent]?.name ?? stopRun.agent}'s run ends now: ${stopRun.label}. The agent is told you stopped it; a stopped test run doesn't count.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (stopRun !== null) {
                  stopRunNow(stopRun.id);
                }
              }}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {forking && <ForkVMDialog vm={vm.name} onClose={() => setForking(false)} />}
    </div>
  );
}
