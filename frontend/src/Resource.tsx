/*
The Resource page (#/resource): this computer's use, from the sidebar's Resource line (under the VMs, below a line).
Everything comes from the live "resource" topic (sandbox/resource_usage.py, a reading about once a second) and the
"vms" topic, so the page never polls.
A card each for the CPU (use, threads, speed, temperature, fan, and a small bar per thread), memory (how much the
running VMs hold, and swap), every GPU, disk (space, read and write speed, temperature), network (download and
upload of the internet connection) and battery. Each has a chart of the last minute; hovering it shows the value at
that second. Below: every running VM's CPU, memory, disk and internet, each a link to its page.
A GPU card without numbers says why: asleep (the NVIDIA GPU is only read while this page is open, and never while
it sleeps, since reading it wakes it and drains the battery), given to a VM, or its driver isn't loaded.
*/

import { useState } from "react";

import { useLive, useWatchResource } from "@/live";
import { cn } from "@/lib/utils";

const SAMPLES = 60;
// The rate charts never scale below these, so a few packets or a small write don't look like a busy line.
const NETWORK_CHART_MIN = 100_000;
const DISK_CHART_MIN = 1_000_000;

// A GPU without numbers: what its card shows instead.
const GPU_STATE_VALUE: Record<string, string> = {
  asleep: "Asleep",
  not_watched: "–",
  in_vm: "In a VM",
  no_driver: "No driver",
  unknown: "–",
  error: "Error",
};
const GPU_STATE_TEXT: Record<string, string> = {
  asleep: "Asleep: nothing uses it now. Reading it would wake it, so it is left alone.",
  not_watched: "Waiting for the first reading…",
  in_vm: "Given to a VM: only that VM can read it.",
  no_driver: "Its driver isn't loaded.",
  unknown: "No numbers for this kind of GPU.",
  error: "Could not read it.",
};

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

type Card = {
  key: string;
  label: string;
  sub: string; // under the label: the part's name
  value: string;
  detail: string;
  meter: number | null; // 0..1, a bar under the title
  warn: boolean; // the meter in amber
  values: (number | null)[] | null; // the chart's samples, or null for no chart
  max: number;
  format: (value: number) => string;
  empty: string; // in the chart while it has nothing to draw
  lines: string[];
};

export default function Resource() {
  useWatchResource();
  const resource = useLive("resource");
  const vms = useLive("vms");
  const [hover, setHover] = useState<{ chart: string; index: number } | null>(null);

  const header = <div className="flex h-9 shrink-0 items-center border-b px-3 font-medium">Resource</div>;
  if (resource === null) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="px-3 py-2 text-muted-foreground">Waiting for the first reading…</div>
      </div>
    );
  }

  const samples = resource.samples;
  const running = vms.filter((vm) => vm.status === "running");
  let vmMemory = 0;
  let vmDisk = 0;
  for (const vm of vms) {
    if (vm.status === "running") {
      vmMemory += vm.usage?.memory_used_gb ?? 0;
    }
    vmDisk += vm.usage?.disk_used_gb ?? 0;
  }

  const cards: Card[] = [];

  const cpu = resource.cpu;
  const cpuDetail: string[] = [`${cpu.threads} threads`];
  if (cpu.mhz !== null) {
    cpuDetail.push(`${(cpu.mhz / 1000).toFixed(1)} GHz`);
  }
  if (cpu.temp_c !== null) {
    cpuDetail.push(`${Math.round(cpu.temp_c)}°C`);
  }
  const cpuLines: string[] = [];
  for (const rpm of resource.fans) {
    cpuLines.push(rpm === 0 ? "Fan off" : `Fan ${rpm} rpm`);
  }
  cards.push({
    key: "cpu",
    label: "CPU",
    sub: cpu.name,
    value: cpu.percent === null ? "–" : `${Math.round(cpu.percent)}%`,
    detail: cpuDetail.join(" · "),
    meter: null,
    warn: false,
    values: samples.map((sample) => sample.cpu_percent),
    max: 100,
    format: (value) => `${value.toFixed(0)}%`,
    empty: "Waiting for the first sample…",
    lines: cpuLines,
  });

  const memory = resource.memory;
  const memoryLines: string[] = [];
  if (running.length > 0) {
    memoryLines.push(`Running VMs hold ${vmMemory.toFixed(1)} GB`);
  }
  if (memory.swap_total_gb > 0) {
    memoryLines.push(`Swap ${memory.swap_used_gb.toFixed(1)} of ${memory.swap_total_gb.toFixed(0)} GB`);
  }
  cards.push({
    key: "memory",
    label: "Memory",
    sub: "",
    value: `${memory.used_gb.toFixed(1)} GB`,
    detail: `of ${memory.total_gb.toFixed(0)} GB`,
    meter: null,
    warn: false,
    values: samples.map((sample) => sample.memory_used_gb),
    max: memory.total_gb,
    format: (value) => `${value.toFixed(1)} GB`,
    empty: "Waiting for the first sample…",
    lines: memoryLines,
  });

  resource.gpus.forEach((gpu, index) => {
    const on = gpu.state === "on";
    const gpuLines: string[] = [];
    if (on && gpu.memory_used_gb !== null && gpu.memory_total_gb !== null) {
      gpuLines.push(`Memory ${gpu.memory_used_gb.toFixed(1)} of ${gpu.memory_total_gb.toFixed(1)} GB`);
    }
    if (on && gpu.shared_used_gb !== null && gpu.shared_total_gb !== null) {
      gpuLines.push(`Shared memory ${gpu.shared_used_gb.toFixed(1)} of ${gpu.shared_total_gb.toFixed(0)} GB`);
    }
    const gpuDetail: string[] = [];
    if (on && gpu.temp_c !== null) {
      gpuDetail.push(`${Math.round(gpu.temp_c)}°C`);
    }
    if (on && gpu.power_w !== null) {
      gpuDetail.push(`${Math.round(gpu.power_w)} W`);
    }
    if (on && gpu.mhz !== null) {
      gpuDetail.push(`${Math.round(gpu.mhz)} MHz`);
    }
    cards.push({
      key: `gpu-${gpu.address}`,
      label: "GPU",
      sub: gpu.name,
      value: !on ? GPU_STATE_VALUE[gpu.state] : gpu.percent === null ? "–" : `${Math.round(gpu.percent)}%`,
      detail: gpuDetail.join(" · "),
      meter: null,
      warn: false,
      values: samples.map((sample) => sample.gpu_percent[index] ?? null),
      max: 100,
      format: (value) => `${value.toFixed(0)}%`,
      empty: on ? "Waiting for the first sample…" : GPU_STATE_TEXT[gpu.state],
      lines: gpuLines,
    });
  });

  const disk = resource.disk;
  const diskValues = samples.map((sample) => {
    if (sample.disk_read_rate === null || sample.disk_write_rate === null) {
      return null;
    }
    return sample.disk_read_rate + sample.disk_write_rate;
  });
  let diskMax = DISK_CHART_MIN;
  for (const value of diskValues) {
    if (value !== null && value > diskMax) {
      diskMax = value;
    }
  }
  const diskLines: string[] = [];
  if (disk.read_rate !== null && disk.write_rate !== null) {
    diskLines.push(`Read ${formatBytes(disk.read_rate)}/s · Write ${formatBytes(disk.write_rate)}/s`);
  }
  if (vms.length > 0) {
    diskLines.push(`VMs use ${vmDisk.toFixed(0)} GB`);
  }
  cards.push({
    key: "disk",
    label: "Disk",
    sub: "",
    value: `${disk.used_gb.toFixed(0)} GB`,
    detail: `of ${disk.total_gb.toFixed(0)} GB${disk.temp_c !== null ? ` · ${Math.round(disk.temp_c)}°C` : ""}`,
    meter: disk.used_gb / disk.total_gb,
    warn: disk.used_gb >= disk.total_gb * 0.9,
    values: diskValues,
    max: diskMax,
    format: (value) => `${formatBytes(value)}/s`,
    empty: "Waiting for the first sample…",
    lines: diskLines,
  });

  const network = resource.network;
  const networkValues = samples.map((sample) => {
    if (sample.net_down_rate === null || sample.net_up_rate === null) {
      return null;
    }
    return sample.net_down_rate + sample.net_up_rate;
  });
  let networkMax = NETWORK_CHART_MIN;
  for (const value of networkValues) {
    if (value !== null && value > networkMax) {
      networkMax = value;
    }
  }
  const down = network.down_rate;
  const up = network.up_rate;
  cards.push({
    key: "network",
    label: "Network",
    sub: network.interface ?? "",
    value: down === null || up === null ? "–" : `${formatBytes(down + up)}/s`,
    detail: down === null || up === null ? "" : `↓ ${formatBytes(down)}/s ↑ ${formatBytes(up)}/s`,
    meter: null,
    warn: false,
    values: networkValues,
    max: networkMax,
    format: (value) => `${formatBytes(value)}/s`,
    empty: network.interface === null ? "Not connected" : "Waiting for the first sample…",
    lines: [],
  });

  const battery = resource.battery;
  if (battery !== null) {
    const batteryLines: string[] = [];
    if (battery.plugged_in !== null) {
      batteryLines.push(battery.plugged_in ? "Plugged in" : "On battery");
    }
    if (battery.power_w !== null && battery.power_w > 0) {
      batteryLines.push(`${battery.power_w.toFixed(1)} W`);
    }
    cards.push({
      key: "battery",
      label: "Battery",
      sub: "",
      value: `${battery.percent}%`,
      detail: battery.status,
      meter: battery.percent / 100,
      warn: battery.percent <= 20 && battery.plugged_in !== true,
      values: null,
      max: 100,
      format: (value) => `${value}`,
      empty: "",
      lines: batteryLines.length > 0 ? [batteryLines.join(" · ")] : [],
    });
  }

  // Name, CPU, memory, disk, internet. In phone mode (App.tsx) the table scrolls sideways instead of squeezing Name.
  const columns = "grid grid-cols-[minmax(0,1fr)_5rem_8rem_8rem_10rem] items-center gap-3 max-md:min-w-[560px]";

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {cards.map((card) => {
            const values = card.values ?? [];
            // Samples fill the chart from the right: the newest is at the right edge.
            const offset = SAMPLES - values.length;
            const points: string[] = [];
            values.forEach((value, index) => {
              if (value === null) {
                return;
              }
              const x = ((offset + index) / (SAMPLES - 1)) * 100;
              const y = 100 - Math.min(value / card.max, 1) * 100;
              points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
            });
            const first = points.length > 0 ? points[0].split(",")[0] : "0";
            const last = points.length > 0 ? points[points.length - 1].split(",")[0] : "0";
            const hovered = hover !== null && hover.chart === card.key ? hover.index : null;
            const hoveredValue = hovered === null ? null : values[hovered];
            const hoverX = hovered === null ? 0 : ((offset + hovered) / (SAMPLES - 1)) * 100;
            const hoverY = hoveredValue === null || hoveredValue === undefined ? 0 : 100 - Math.min(hoveredValue / card.max, 1) * 100;
            const secondsAgo = hovered === null ? 0 : values.length - 1 - hovered;
            return (
              <div key={card.key} className="rounded-lg border bg-card p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{card.label}</span>
                  <span className="ml-auto font-medium tabular-nums">{card.value}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{card.detail}</span>
                </div>
                {card.sub !== "" && <div className="truncate text-xs text-muted-foreground">{card.sub}</div>}

                {card.meter !== null && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", card.warn ? "bg-warn" : "bg-muted-foreground/70")}
                      style={{ width: `${Math.min(card.meter * 100, 100)}%` }}
                    />
                  </div>
                )}

                {card.values !== null && (
                  <div
                    className="relative mt-2 h-16 border-b"
                    onMouseMove={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const slot = Math.round(((event.clientX - rect.left) / rect.width) * (SAMPLES - 1));
                      const index = slot - offset;
                      if (index < 0 || index >= values.length) {
                        setHover(null);
                        return;
                      }
                      setHover({ chart: card.key, index: index });
                    }}
                    onMouseLeave={() => setHover(null)}
                  >
                    {points.length === 0 && (
                      <span className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">{card.empty}</span>
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
                          {card.format(hoveredValue)} <span className="text-muted-foreground">{secondsAgo === 0 ? "now" : `${secondsAgo}s ago`}</span>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* One bar per thread, like a CPU meter. */}
                {card.key === "cpu" && (
                  <div className="mt-2 flex h-6 gap-0.5">
                    {cpu.per_thread.map((percent, index) => (
                      <div key={index} className="flex h-full flex-1 items-end rounded-[1px] bg-muted" title={`Thread ${index + 1}: ${percent === null ? "–" : `${Math.round(percent)}%`}`}>
                        <div className="w-full rounded-[1px] bg-primary/70" style={{ height: `${percent === null ? 0 : Math.min(percent, 100)}%` }} />
                      </div>
                    ))}
                  </div>
                )}

                {card.lines.map((line, index) => (
                  <div key={index} className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {line}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <div className="mb-1 font-medium">Running VMs</div>
          {running.length === 0 && <div className="text-muted-foreground">No VM is running.</div>}
          {running.length > 0 && (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <div className={cn(columns, "h-7 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
                <span>Name</span>
                <span>CPU</span>
                <span>Memory</span>
                <span>Disk</span>
                <span>Internet</span>
              </div>
              {running.map((vm) => {
                const vmCpu = vm.usage?.cpu_percent ?? null;
                const vmMemoryUsed = vm.usage?.memory_used_gb ?? null;
                const vmDiskUsed = vm.usage?.disk_used_gb ?? null;
                const vmDown = vm.usage?.net_down_rate ?? null;
                const vmUp = vm.usage?.net_up_rate ?? null;
                return (
                  <a key={vm.name} href={`#/vms/${encodeURIComponent(vm.name)}`} className={cn(columns, "h-7 border-b px-3 tabular-nums last:border-b-0 hover:bg-accent/50")}>
                    <span className="truncate font-medium">{vm.name}</span>
                    <span>{vmCpu === null ? "–" : `${Math.round(vmCpu)}%`}</span>
                    <span>
                      {vmMemoryUsed === null ? "–" : vmMemoryUsed.toFixed(1)} / {vm.memory_gb} GB
                    </span>
                    <span>
                      {vmDiskUsed === null ? "–" : vmDiskUsed.toFixed(1)} / {vm.disk_gb} GB
                    </span>
                    <span>{vmDown === null || vmUp === null ? "–" : `↓ ${formatBytes(vmDown)}/s ↑ ${formatBytes(vmUp)}/s`}</span>
                  </a>
                );
              })}
            </div>
          )}
          {vms.length > running.length && <div className="mt-1 text-xs text-muted-foreground">{vms.length - running.length} more are off.</div>}
        </div>
      </div>
    </div>
  );
}
