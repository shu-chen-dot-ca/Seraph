/*
One VM's page: a header with its state and power buttons, and three tabs.

Overview is three areas with draggable dividers:
  desktop (noVNC in an iframe)  |  queue (who holds the VM, who waits)
  ------------------------------+--------------------------------------
  stats (CPU, memory and internet speed over the last minute, disk, internet used)  and  the jobs on this VM
Resources is VMResources: copy files and folders between this computer and the VM (only you; agents can't).
Settings is VMSettings. Fork (only while stopped) makes a new VM that starts as a copy of this one (ForkVMDialog).

App keeps this page mounted (hidden) after you leave it, and the Overview stays mounted while the
Resources or Settings tab is open, so the desktop iframe never reloads: coming back is instant, and always to the
Overview (the tab you were on isn't remembered). The iframe only
exists while the VM runs; its address comes from GET /api/vms/{name}/viewer, asked again (every 3 s)
until the VM has one. A VM from a terminal-only image has no desktop: the same area shows its terminal (ttyd).

The queue buttons map one to one onto the backend: Take over, Release (your own hold), Give (the VM
goes to that agent now), Front (next in line) and Remove (out of the queue, or the VM taken away;
the agent is interrupted). When the desktop is locked (by an agent while it works, or by you),
a cover stops clicks and keys from reaching it, with an Unlock button.

When the VM runs but doesn't answer (still booting, or frozen: Incus still says Running), a notice over
the desktop says so and offers Restart. Once it answers again after more than a few seconds, the desktop
reloads by itself: noVNC's own reconnect can't recover a page that failed to load while the VM was down.

Internet used is what the VM downloaded and uploaded since the last Reset, for watching a metered connection
(a phone hotspot). It counts only traffic that leaves this machine: not the desktop or terminals shown here.
What the backend itself uses (the agents talking to Claude and GitHub) isn't in it.
*/

import { Copy, ExternalLink, Loader2, Lock, Monitor, Play, Power, RotateCw, Square, Unlock, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import ForkVMDialog from "@/ForkVMDialog";
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
import { api, useLive, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

// The backend keeps one sample per second for the last minute.
const SAMPLES = 60;

const OPEN_JOB = ["queued", "working", "waiting_on_user"];

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

export default function VMPage(props: { name: string; active: boolean }) {
  const vms = useLive("vms");
  const loaded = useLoaded("vms");
  const imagesData = useLive("images");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const [tab, setTab] = useState("overview");
  // Leaving the page puts it back on the Overview, so coming back always starts there.
  useEffect(() => {
    if (!props.active) {
      setTab("overview");
    }
  }, [props.active]);
  const [desktopUrl, setDesktopUrl] = useState<string | null>(null);
  // The VM has no desktop (a terminal-only image): desktopUrl is its terminal.
  const [terminalOnly, setTerminalOnly] = useState(false);
  const [viewerError, setViewerError] = useState("");
  // Bumped by Reconnect: a new iframe key loads the desktop again.
  const [reload, setReload] = useState(0);
  // The button whose request is on its way, e.g. "start" or "give:agent_x".
  const [busy, setBusy] = useState("");
  const [hover, setHover] = useState<{ chart: string; index: number } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [forking, setForking] = useState(false);
  // When the VM stopped answering (Date.now()), or null while it answers.
  const silentSince = useRef<number | null>(null);

  const name = props.name;
  const vm = vms.find((each) => each.name === name);
  const running = vm !== undefined && vm.status === "running";
  const locked = vm !== undefined && vm.locked_by !== null;
  const silent = running && vm.usage !== null && vm.usage.on && !vm.usage.responding;

  // Ask where the desktop is once the VM runs; forget it when it stops.
  useEffect(() => {
    if (!running) {
      setDesktopUrl(null);
      setViewerError("");
      return;
    }
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<{ desktop: string | null; terminal: string | null }>(`/api/vms/${encodeURIComponent(name)}/viewer`);
        if (stopped) {
          return;
        }
        setDesktopUrl(answer.desktop ?? answer.terminal);
        setTerminalOnly(answer.desktop === null);
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
  }, [name, running]);

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
  const holderAgent = vm.holder !== null && vm.holder !== "user" ? agentById[vm.holder] : undefined;
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

  // take_over and release act on the VM; give, front and remove also name an agent.
  async function queueAction(action: "take_over" | "release" | "give" | "front" | "remove", agentId: string | null) {
    setBusy(agentId === null ? action : `${action}:${agentId}`);
    try {
      const body = agentId === null ? undefined : { agent: agentId };
      await api(`/api/vms/${encodeURIComponent(name)}/${action}`, { method: "POST", body: body });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
      await api(`/api/vms/${encodeURIComponent(name)}/lock`, { method: "PUT", body: { enabled: enabled } });
    } catch (err) {
      toast.error(`Could not ${enabled ? "lock" : "unlock"} the desktop: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  const canStart = vm.status === "stopped" || vm.status === "failed";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Monitor className="size-4 text-muted-foreground" />
        <h1 className="font-semibold">{vm.name}</h1>
        <Badge variant="secondary" title={error ?? undefined}>
          <StatusDot tone={VM_TONE[vm.status]} />
          {STATUS_TEXT[vm.status] ?? vm.status}
        </Badge>
        <span className="text-muted-foreground">
          {imageName}
          {vm.forked_from !== "" && ` · forked from ${vm.forked_from}`}
          {vm.internet ? "" : " · no internet"}
        </span>
        <div className="ml-2 flex items-center gap-1">
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
        <Tabs value={tab} onValueChange={setTab} className="ml-auto">
          <TabsList>
            <TabsTrigger value="overview" className="px-2.5">
              Overview
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

      {/* Hidden, not unmounted, while Settings is open: the desktop keeps its connection.
          While a divider is dragged the iframe ignores the pointer, or it would swallow the drag. */}
      <div className={tab === "overview" ? "min-h-0 flex-1 [&:has([data-separator=active])_iframe]:pointer-events-none" : "hidden"}>
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel defaultSize="68" minSize="25">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="76" minSize="30">
                <div className="flex h-full flex-col">
                  <div className="flex h-7 shrink-0 items-center gap-1 border-b bg-muted/40 px-2 text-xs">
                    <span className="font-medium text-muted-foreground">{terminalOnly ? "Terminal" : "Desktop"}</span>
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
                        <Button variant="ghost" size="xs" asChild>
                          <a href={desktopUrl} target="_blank" rel="noreferrer" title="Open it in its own tab">
                            <ExternalLink /> New tab
                          </a>
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="relative min-h-0 flex-1 bg-muted/30">
                    {running && desktopUrl !== null && (
                      <iframe
                        key={`${desktopUrl}-${reload}`}
                        ref={frameRef}
                        src={desktopUrl}
                        title={terminalOnly ? `Terminal of ${vm.name}` : `Desktop of ${vm.name}`}
                        allow="clipboard-write"
                        className="absolute inset-0 size-full border-0 bg-black"
                      />
                    )}

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
                          {vm.locked_by === "agent" ? "Locked by the agent while it works" : "You locked your mouse and keyboard out"}
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

              <ResizablePanel defaultSize="24" minSize={220}>
                <div className="flex h-full flex-col">
                  <div className="flex h-7 shrink-0 items-center gap-1 border-b bg-muted/40 px-2 text-xs">
                    <span className="font-medium text-muted-foreground">Queue</span>
                    {vm.holder !== "user" && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ml-auto"
                        title={holderAgent !== undefined ? `${holderAgent.name} goes back to the front of the queue` : "Hold the VM yourself"}
                        disabled={busy !== ""}
                        onClick={() => queueAction("take_over", null)}
                      >
                        <User /> Take over
                      </Button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Holder</div>
                    {vm.holder === null && <div className="flex h-7 items-center px-2 text-muted-foreground">Free</div>}
                    {vm.holder === "user" && (
                      <div className="flex h-7 items-center gap-2 px-2">
                        <User className="size-3.5 text-primary" />
                        You
                        <Button variant="outline" size="xs" className="ml-auto" disabled={busy !== ""} onClick={() => queueAction("release", null)}>
                          Release
                        </Button>
                      </div>
                    )}
                    {vm.holder !== null && vm.holder !== "user" && (
                      <div className="px-2">
                        <div className="flex h-7 items-center gap-2">
                          <StatusDot tone={holderAgent !== undefined ? AGENT_TONE[holderAgent.status] : "gray"} />
                          <a href={`#/agents/${vm.holder}`} className="truncate text-primary hover:underline">
                            {holderAgent?.name ?? vm.holder}
                          </a>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            title="Take the VM away from this agent (it is interrupted)"
                            disabled={busy !== ""}
                            onClick={() => queueAction("remove", vm.holder)}
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
                      return (
                        <div key={agentId} className="flex h-7 items-center gap-1.5 px-2 hover:bg-accent/40">
                          <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
                          <a href={`#/agents/${agentId}`} className="min-w-0 truncate text-primary hover:underline">
                            {agent?.name ?? agentId}
                          </a>
                          <span className="ml-auto flex shrink-0 items-center">
                            <Button
                              variant="ghost"
                              size="xs"
                              title="Give the VM to this agent now"
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
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize="32" minSize={120}>
            <div className="flex h-full">
              <div className="w-80 shrink-0 overflow-auto border-r">
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

      {forking && <ForkVMDialog vm={vm.name} onClose={() => setForking(false)} />}
    </div>
  );
}
