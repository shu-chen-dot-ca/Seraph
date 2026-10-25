/*
The VMs overview: one band per VM, split by a line. On top, the VM's name (a link to its page), state, image and
size; under it a row of cards, all the same size, side by side (the row scrolls sideways when the page is narrow):
- Desktop: a small picture of the VM's screen, taken again every few seconds (GET /api/vms/<name>/screen). Only a
  picture: nothing reaches the desktop, and a click opens the VM's page. Off, starting, or a terminal-only image
  say so instead.
- Jobs: how many are open, then the latest few on this VM (open ones first), each a link, with the step bar of
  the one being worked on.
- CPU, Memory and Internet: the number now and a chart of the last minute. Internet also has the total since it
  was last reset (on the VM page).
- Disk: space used, with a bar that turns amber at 90%.
- Held by: who uses the VM (you or an agent, a link) and who waits for it.

Everything comes from the live "vms", "jobs" and "agents" topics (the backend samples usage about once a second),
so the numbers move on their own. Whether a running VM has a desktop is asked once when it runs (its viewer).
New VM opens NewVMDialog. The Images tab (#/vms?tab=images) manages the
images VMs start from (Images.tsx), which puts its own buttons in this same header row, right of the tabs. The
Defaults tab (#/vms?tab=defaults) is the YAML that goes under every image's image.yaml (Defaults.tsx).
*/

import { Plus, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";

import Defaults from "@/Defaults";
import Images from "@/Images";
import NewVMDialog from "@/NewVMDialog";
import { Button } from "@/components/ui/button";
import { JobProgressBar } from "@/components/ui/job-progress";
import { JOB_LABEL, JOB_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

const SAMPLES = 60;
const OPEN_JOB = ["queued", "working", "waiting_on_user"];
const JOBS_SHOWN = 3;
// The internet chart never scales below this, so an idle VM's few packets don't look like a busy line.
const INTERNET_CHART_MIN = 100_000;
// How often the Desktop card takes a new picture of the screen.
const SCREEN_EVERY_MS = 5000;
// Every card in a VM's row: the same size.
const CARD = "h-36 rounded-lg border bg-card";

// Data in the units a phone's data counter uses: 1 MB = 1,000,000 bytes (the same as the VM page).
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

export default function VMs(props: { tab: "vms" | "images" | "defaults" }) {
  const vms = useLive("vms");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const imagesData = useLive("images");
  const loaded = useLoaded("vms");
  const [creating, setCreating] = useState(false);
  // Whether each running VM has a desktop (false: a terminal-only image); missing until known.
  const [desktops, setDesktops] = useState<Record<string, boolean>>({});
  const [retry, setRetry] = useState(0);
  // Goes up every SCREEN_EVERY_MS, so each Desktop card asks for a new picture.
  const [screenTick, setScreenTick] = useState(0);
  // The VMs whose last picture didn't come (the desktop isn't up yet): their card says so.
  const [noScreen, setNoScreen] = useState<Record<string, boolean>>({});
  // Only the names: the VM list changes every second, the running ones rarely.
  const runningNames = vms
    .filter((vm) => vm.status === "running")
    .map((vm) => vm.name)
    .join(" ");

  // Ask where each running VM's desktop is. Right after a start a VM has no address yet: try again shortly.
  // A VM that stopped drops out, so its picture goes.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const names = runningNames === "" ? [] : runningNames.split(" ");
    async function load() {
      const found: Record<string, boolean> = {};
      let failed = false;
      for (const name of names) {
        try {
          const answer = await api<{ desktop: string | null; terminal: string | null }>(`/api/vms/${encodeURIComponent(name)}/viewer`);
          found[name] = answer.desktop !== null;
        } catch {
          failed = true;
        }
      }
      if (stopped) {
        return;
      }
      setDesktops((old) => {
        const next: Record<string, boolean> = {};
        for (const name of names) {
          if (name in found) {
            next[name] = found[name];
          } else if (name in old) {
            next[name] = old[name];
          }
        }
        return next;
      });
      if (failed) {
        timer = window.setTimeout(() => setRetry((current) => current + 1), 3000);
      }
    }
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [runningNames, retry]);

  useEffect(() => {
    const timer = window.setInterval(() => setScreenTick((current) => current + 1), SCREEN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }
  const running = vms.filter((vm) => vm.status === "running").length;
  // A VM shows the image's name now (it may have been renamed since), or the name it was made with.
  const imageNames: Record<string, string> = {};
  for (const image of imagesData.images) {
    imageNames[image.fingerprint] = image.name;
  }

  function setTab(value: string) {
    window.location.hash = value === "vms" ? "#/vms" : `#/vms?tab=${value}`;
  }

  const tabs = (
    <Tabs value={props.tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="vms" className="px-2.5">
            VMs
            <span className="text-xs text-muted-foreground tabular-nums">{vms.length}</span>
          </TabsTrigger>
          <TabsTrigger value="images" className="px-2.5">
            Images
            <span className="text-xs text-muted-foreground tabular-nums">{imagesData.images.length}</span>
          </TabsTrigger>
          <TabsTrigger value="defaults" className="px-2.5">
            Defaults
          </TabsTrigger>
        </TabsList>
      </Tabs>
  );

  const header = (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      {tabs}
      {props.tab === "vms" && (
        <>
          <span className="text-muted-foreground tabular-nums">
            {running} of {vms.length} running
          </span>
          <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus /> New VM
          </Button>
        </>
      )}
    </div>
  );

  if (props.tab === "images") {
    return <Images tabs={tabs} />;
  }
  if (props.tab === "defaults") {
    return <Defaults tabs={tabs} />;
  }

  return (
    <div className="flex h-full flex-col">
      {header}

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && vms.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
            No VMs yet. Agents need one to run code.
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Plus /> New VM
            </Button>
          </div>
        )}
        {vms.map((vm) => {
          const page = `#/vms/${encodeURIComponent(vm.name)}`;
          const on = vm.status === "running";
          // The usage numbers are null until the first sample after a start (disk until the VM's agent runs).
          const cpu = vm.usage?.cpu_percent ?? null;
          const memory = vm.usage?.memory_used_gb ?? null;
          const disk = vm.usage?.disk_used_gb ?? null;
          const down = vm.usage?.net_down_rate ?? null;
          const up = vm.usage?.net_up_rate ?? null;
          const silent = on && vm.usage !== null && vm.usage.on && !vm.usage.responding;
          const desktop = desktops[vm.name];

          // Jobs on this VM: open ones first, then the latest.
          const vmJobs = jobs
            .filter((job) => job.vm === vm.name)
            .sort((a, b) => {
              const aOpen = OPEN_JOB.includes(a.status) ? 0 : 1;
              const bOpen = OPEN_JOB.includes(b.status) ? 0 : 1;
              if (aOpen !== bOpen) {
                return aOpen - bOpen;
              }
              return b.updated_at.localeCompare(a.updated_at);
            });
          const openJobs = vmJobs.filter((job) => OPEN_JOB.includes(job.status)).length;

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
            <div key={vm.name} className="border-b px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot tone={VM_TONE[vm.status]} />
                <a href={page} className="truncate font-medium hover:underline">
                  {vm.name}
                </a>
                <span className="text-muted-foreground">{silent ? "not answering" : vm.status}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {imageNames[vm.image_fingerprint] ?? (vm.image || "–")} · {vm.cpus} CPU · {vm.memory_gb} GB · {vm.disk_gb} GB disk
                </span>
                {vm.error !== null && (
                  <span className="truncate text-xs text-destructive" title={vm.error}>
                    {vm.error}
                  </span>
                )}
              </div>

              {/* Equal columns that fill the width, and scroll sideways once they would get narrower than 13rem. */}
              <div className="mt-2 grid auto-cols-[minmax(13rem,1fr)] grid-flow-col gap-2 overflow-x-auto pb-1">
                {/* The desktop: only a picture. The old one stays until the new one has loaded, so it doesn't blink. */}
                <a href={page} className={cn(CARD, "relative overflow-hidden bg-muted/30")} title={`Open ${vm.name}`}>
                  {on && desktop === true && (
                    <img
                      src={`/api/vms/${encodeURIComponent(vm.name)}/screen?at=${screenTick}`}
                      alt={`Screen of ${vm.name}`}
                      className={cn("absolute inset-0 size-full bg-black object-contain", noScreen[vm.name] && "invisible")}
                      onLoad={() => setNoScreen((old) => ({ ...old, [vm.name]: false }))}
                      onError={() => setNoScreen((old) => ({ ...old, [vm.name]: true }))}
                    />
                  )}
                  {on && desktop === true && noScreen[vm.name] && (
                    <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Waiting for the desktop…</span>
                  )}
                  {on && desktop === false && (
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                      <SquareTerminal className="size-5" />
                      Terminal only
                    </span>
                  )}
                  {on && desktop === undefined && (
                    <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Waiting for the desktop…</span>
                  )}
                  {!on && <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{vm.status === "stopped" ? "Off" : vm.status}</span>}
                </a>

                <div className={cn(CARD, "flex min-w-0 flex-col p-2.5")}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-muted-foreground">Jobs</span>
                    <span className="ml-auto font-medium tabular-nums">{openJobs} open</span>
                    <span className="text-xs text-muted-foreground tabular-nums">of {vmJobs.length}</span>
                  </div>
                  {vmJobs.length === 0 && <div className="mt-2 text-xs text-muted-foreground">No jobs on this VM yet.</div>}
                  <div className="mt-1.5 min-h-0 space-y-1.5">
                    {vmJobs.slice(0, JOBS_SHOWN).map((job) => (
                      <div key={job.id} className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <StatusDot tone={JOB_TONE[job.status]} />
                          <a href={`#/jobs/${job.id}`} className="truncate hover:underline" title={job.title}>
                            {job.title}
                          </a>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{JOB_LABEL[job.status]}</span>
                        </div>
                        {job.status === "working" && <JobProgressBar job={job} className="mt-0.5 pl-3.5" />}
                      </div>
                    ))}
                  </div>
                  {vmJobs.length > JOBS_SHOWN && (
                    <a href={page} className="mt-auto text-xs text-muted-foreground hover:underline">
                      {vmJobs.length - JOBS_SHOWN} more on its page
                    </a>
                  )}
                </div>

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
                    <div key={chart.key} className={cn(CARD, "flex min-w-0 flex-col p-2.5")}>
                      <div className="text-muted-foreground">{chart.label}</div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-lg font-medium tabular-nums">{chart.value}</span>
                        <span className="text-xs text-muted-foreground">{chart.detail}</span>
                      </div>
                      <div className="relative mt-auto h-12 border-b">
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

                <div className={cn(CARD, "flex min-w-0 flex-col p-2.5")}>
                  <div className="text-muted-foreground">Disk</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-medium tabular-nums">{disk === null ? "–" : `${disk.toFixed(1)} GB`}</span>
                    <span className="text-xs text-muted-foreground">of {vm.disk_gb} GB</span>
                  </div>
                  {/* Gray, amber once the disk is 90% full (the VM starts failing when it fills). */}
                  <div className="mt-auto mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", disk !== null && disk >= vm.disk_gb * 0.9 ? "bg-warn" : "bg-muted-foreground/70")}
                      style={{ width: `${disk === null ? 0 : Math.min((disk / vm.disk_gb) * 100, 100)}%` }}
                    />
                  </div>
                </div>

                <div className={cn(CARD, "flex min-w-0 flex-col p-2.5")}>
                  <div className="text-muted-foreground">Held by</div>
                  <div className="truncate text-lg font-medium">
                    {vm.holder === null && <span className="text-muted-foreground">Nobody</span>}
                    {vm.holder === "user" && "You"}
                    {vm.holder !== null && vm.holder !== "user" && (
                      <a href={`#/agents/${vm.holder}`} className="text-primary hover:underline">
                        {agentNames[vm.holder] ?? vm.holder}
                      </a>
                    )}
                  </div>
                  <div className="mt-auto text-xs text-muted-foreground">{vm.queue.length === 0 ? "Nobody waits" : `${vm.queue.length} waiting`}</div>
                  {vm.queue.length > 0 && (
                    <div className="truncate text-xs">
                      {vm.queue.map((id, index) => (
                        <span key={id}>
                          {index > 0 && ", "}
                          <a href={`#/agents/${id}`} className="hover:underline">
                            {agentNames[id] ?? id}
                          </a>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <NewVMDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
