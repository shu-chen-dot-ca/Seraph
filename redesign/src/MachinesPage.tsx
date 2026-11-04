import { useState } from "react";

import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import Dialog from "@/Dialog";
import PageHeader from "@/PageHeader";
import { AGENTS, VMS, WORK_BY_ID } from "@/data";
import { Go, href, toast } from "@/links";
import { cn } from "@/lib/utils";

/*
Machines: each VM with its desktops and who holds them, and who waits. A VM's page also lists every agent whose
machine it is. Watch or Use opens one desktop full size: watch the agent work, or take it over (the agent pauses
until you give it back). Stop asks first.
*/

export function MachineList() {
  const names = Object.keys(VMS);
  return (
    <div>
      <PageHeader
        title="Machines"
        meta={`${names.filter((name) => VMS[name].status === "Running").length} running · ${names.filter((name) => VMS[name].status === "Stopped").length} stopped`}
        right={
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => toast("Images: what each VM is made from, and what it has installed.")}>
              Images
            </Button>
            <Button size="sm" variant="outline" onClick={() => toast("New VM: name, image, size and how many desktops.")}>
              New VM
            </Button>
          </div>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4">
        {names.map((name) => {
          const vm = VMS[name];
          return (
            <a key={name} href={href("vm", name)} className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 hover:border-input">
              <div className="flex items-center gap-1.5">
                <StatusDot tone={vm.status === "Running" ? "green" : "gray"} />
                <span className="font-medium">{name}</span>
                <span className="text-xs text-muted-foreground">{vm.status}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Desktops {vm.desktops.map((desk) => `${desk.n}: ${desk.holder ?? "free"}`).join(" · ")}
              </div>
              {vm.waiting.length > 0 && <div className="text-xs text-muted-foreground">Waiting: {vm.waiting.join(", ")}</div>}
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full bg-idle", vm.cpu > 80 && "bg-warn")} style={{ width: `${vm.cpu}%` }} />
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function MachinePage(props: { id: string }) {
  const [stopping, setStopping] = useState(false);
  const vm = VMS[props.id];
  if (!vm) {
    return <PageHeader title="Not found" back />;
  }
  const agentsHere = Object.keys(AGENTS).filter((id) => AGENTS[id].vm === props.id);
  const busy = vm.desktops.filter((desk) => desk.holder !== null);
  return (
    <div>
      <PageHeader
        back
        title={props.id}
        meta={
          <span className="flex items-center gap-1.5">
            <StatusDot tone={vm.status === "Running" ? "green" : "gray"} />
            {vm.status} · image {vm.image}
          </span>
        }
        right={
          <Button
            size="sm"
            variant="outline"
            onClick={() => (vm.status === "Running" ? setStopping(true) : toast(`${props.id} is starting. Its desktops show here once it's up.`))}
          >
            {vm.status === "Running" ? "Stop" : "Start"}
          </Button>
        }
      />
      <div className="flex max-w-3xl flex-col gap-3 p-4">
        {vm.desktops.map((desk) => {
          const work = desk.holder ? WORK_BY_ID[AGENTS[desk.holder].work] : null;
          return (
            <div key={desk.n} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
              <div>
                <span className="font-medium">Desktop {desk.n}</span>
                <span className="text-muted-foreground"> · </span>
                {desk.holder && work ? (
                  <span>
                    <Go kind="agent" id={desk.holder}>
                      {desk.holder}
                    </Go>{" "}
                    <span className="text-muted-foreground">on</span>{" "}
                    <Go kind="work" id={work.id}>
                      {work.ref}
                    </Go>
                  </span>
                ) : (
                  <span className="text-muted-foreground">free</span>
                )}
              </div>
              <Button size="sm" variant="outline" asChild>
                <a href={`#/machines/${props.id}/${desk.n}`}>{desk.holder ? "Watch" : "Use"}</a>
              </Button>
            </div>
          );
        })}
        <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">Waiting</dt>
          <dd>
            {vm.waiting.length === 0 && "Nobody"}
            {vm.waiting.map((id, index) => (
              <span key={id}>
                {index > 0 && ", "}
                <Go kind="agent" id={id}>
                  {id}
                </Go>
              </span>
            ))}
          </dd>
          <dt className="text-muted-foreground">Agents here</dt>
          <dd>
            {agentsHere.length === 0 && "None"}
            {agentsHere.map((id, index) => (
              <span key={id}>
                {index > 0 && ", "}
                <Go kind="agent" id={id}>
                  {id}
                </Go>
              </span>
            ))}
          </dd>
          <dt className="text-muted-foreground">CPU</dt>
          <dd className="pt-1.5">
            <div className="h-1 w-48 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full bg-idle", vm.cpu > 80 && "bg-warn")} style={{ width: `${vm.cpu}%` }} />
            </div>
          </dd>
          <dt className="text-muted-foreground">Memory</dt>
          <dd className="pt-1.5">
            <div className="h-1 w-48 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-idle" style={{ width: `${vm.mem}%` }} />
            </div>
          </dd>
        </dl>
      </div>
      {stopping && (
        <Dialog
          title={`Stop ${props.id}?`}
          confirm="Stop"
          danger
          onClose={() => setStopping(false)}
          onConfirm={() => {
            toast(`${props.id} is stopping. Agents on it pause and wait for it.`);
            setStopping(false);
          }}
        >
          <p>
            {busy.length > 0
              ? `${busy.map((desk) => desk.holder).join(" and ")} ${busy.length === 1 ? "is" : "are"} using it. They pause and wait until it starts again.`
              : "Nobody is using it."}
          </p>
        </Dialog>
      )}
    </div>
  );
}

// One desktop, full size: watch the agent, or take it over and give it back.
export function DesktopPage(props: { vm: string; n: number }) {
  const [mine, setMine] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const vm = VMS[props.vm];
  const desk = vm?.desktops.find((each) => each.n === props.n);
  if (!vm || !desk) {
    return <PageHeader title="Not found" back />;
  }
  let who = "Free";
  if (desk.holder) {
    who = `${desk.holder} is working here`;
  }
  if (mine) {
    who = "You're using it";
  }
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        back
        title={`${props.vm} · desktop ${props.n}`}
        meta={who}
        right={
          mine ? (
            <Button size="sm" onClick={() => setMine(false)}>
              Give back
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => (desk.holder ? setConfirming(true) : setMine(true))}>
              {desk.holder ? "Take over" : "Use"}
            </Button>
          )
        }
      />
      <div className="flex flex-1 items-center justify-center p-4">
        <div
          className={cn(
            "flex aspect-video w-full max-w-4xl items-center justify-center rounded-lg border bg-[image:repeating-linear-gradient(135deg,var(--muted)_0_10px,var(--card)_10px_20px)] text-muted-foreground",
            mine && "ring-2 ring-primary",
          )}
        >
          <span className="rounded-md bg-card px-3 py-1.5">{mine ? "The desktop, yours to use" : "The desktop, live"}</span>
        </div>
      </div>
      {confirming && desk.holder && (
        <Dialog
          title="Take over this desktop?"
          confirm="Take over"
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setMine(true);
            setConfirming(false);
            toast(`${desk.holder} paused. Give back when you're done.`);
          }}
        >
          <p>{desk.holder} pauses until you give it back.</p>
        </Dialog>
      )}
    </div>
  );
}
