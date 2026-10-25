/*
The VMs overview: one row per VM with its state, CPU and memory use, who holds it and how many agents wait.

Everything comes from the live "vms" topic (the backend samples usage about once a second), so the
numbers move on their own. A row opens that VM's page; the holder links to its agent.
New VM opens NewVMDialog. The Images tab (#/vms?tab=images) manages the images VMs start from (Images.tsx),
which puts its own buttons in this same header row, right of the tabs. The Defaults tab (#/vms?tab=defaults) is
the YAML that goes under every image's image.yaml (Defaults.tsx).
*/

import { Monitor, Plus } from "lucide-react";
import { useState } from "react";

import Defaults from "@/Defaults";
import Images from "@/Images";
import NewVMDialog from "@/NewVMDialog";
import { Button } from "@/components/ui/button";
import { StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLive, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[minmax(0,1fr)_minmax(0,160px)_130px_72px_130px_minmax(0,180px)_64px] items-center gap-3";

export default function VMs(props: { tab: "vms" | "images" | "defaults" }) {
  const vms = useLive("vms");
  const agents = useLive("agents");
  const imagesData = useLive("images");
  const loaded = useLoaded("vms");
  const [creating, setCreating] = useState(false);

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

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span>Name</span>
        <span>Image</span>
        <span>State</span>
        <span className="text-right">CPU</span>
        <span className="text-right">Memory</span>
        <span>Held by</span>
        <span className="text-right">Waiting</span>
      </div>

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
          // The usage numbers are null until the first sample after a start.
          const cpu = vm.usage?.cpu_percent ?? null;
          const memory = vm.usage?.memory_used_gb ?? null;
          const error = vm.error;
          return (
            <div
              key={vm.name}
              className={cn(COLUMNS, "h-7 cursor-pointer border-b px-3 hover:bg-accent/50")}
              onClick={() => {
                window.location.hash = `#/vms/${encodeURIComponent(vm.name)}`;
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                <a href={`#/vms/${encodeURIComponent(vm.name)}`} className="truncate font-medium" onClick={(event) => event.stopPropagation()}>
                  {vm.name}
                </a>
                <span className="truncate text-xs text-muted-foreground">
                  {vm.cpus} CPU · {vm.memory_gb} GB · {vm.disk_gb} GB disk
                </span>
              </span>
              <span className="truncate text-muted-foreground">{imageNames[vm.image_fingerprint] ?? (vm.image || "–")}</span>
              <span className="flex min-w-0 items-center gap-1.5" title={error ?? undefined}>
                <StatusDot tone={VM_TONE[vm.status]} />
                <span className="truncate">{vm.status}</span>
              </span>
              <span className="text-right tabular-nums">{cpu === null ? "–" : `${Math.round(cpu)}%`}</span>
              <span className="text-right tabular-nums">
                {memory === null ? "–" : memory.toFixed(1)} / {vm.memory_gb} GB
              </span>
              <span className="truncate">
                {vm.holder === null && <span className="text-muted-foreground">–</span>}
                {vm.holder === "user" && "You"}
                {vm.holder !== null && vm.holder !== "user" && (
                  <a href={`#/agents/${vm.holder}`} className="text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
                    {agentNames[vm.holder] ?? vm.holder}
                  </a>
                )}
              </span>
              <span className={cn("text-right tabular-nums", vm.queue.length === 0 && "text-muted-foreground")}>
                {vm.queue.length === 0 ? "–" : vm.queue.length}
              </span>
            </div>
          );
        })}
      </div>

      <NewVMDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
