/*
A repository's Live tab on the Workspace tab (Repository.tsx with live, from Home.tsx; right of Agents): the repo
running in a VM of its own, next to a chat with its agent. The agent knows the repo's code, issues and pull
requests, and when you ask for a change it drafts the issue for you to create (AgentChat.tsx, compact).

Before it is set up: one line on what it is, and Set up (backend/repo_live_api.py): a new VM named after the repo, and
the repo's agent, which puts the code in the VM and sets the repo up on its desktop 1 (github_searcher/agents.py,
prepare_live). While that goes, a line over the desktop says so, and the chat shows the agent's progress. A failed
set-up says why, with Try again.

Once set up: the desktop on the left, the chat on the right. The desktop is desktop 1 of the agent's target VM, to use,
like on the VM's page: noVNC in an iframe (asked for once the VM runs, again every 3 s until it has an address), its
name (a link to its page) and state above it, Start while it is off, Lock (keeps your mouse and keyboard out) and
Reconnect. Locked (by the agent while it works, or by you), a cover stops clicks and keys, with Unlock. On a narrow
screen (a phone) one side shows at a time, picked with Desktop and Chat on top.
*/

import { Loader2, Lock, Monitor, Play, Power, RotateCw, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import AgentChat from "@/AgentChat";
import { Button } from "@/components/ui/button";
import { StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLiveValue, useLoaded, type VMStatus } from "@/live";
import { cn } from "@/lib/utils";

const STATUS_TEXT: Record<string, string> = {
  creating: "Creating",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  starting: "Starting",
  failed: "Failed",
  missing: "Missing",
};

type LiveVM = { name: string; status: VMStatus; error: string | null; responding: boolean; locked: "user" | "agent" | null };

export default function RepoLive(props: { repo: string }) {
  const agents = useLive("agents");
  const agentsLoaded = useLoaded("agents");
  // Only what the desktop needs of the VMs, as one string: the whole list changes every second while a VM runs (its
  // usage samples), and this page would re-render with it.
  const vmsText = useLiveValue((topics) =>
    JSON.stringify(
      topics.vms.map((vm) => ({
        name: vm.name,
        status: vm.status,
        error: vm.error,
        responding: vm.usage === null || !vm.usage.on || vm.usage.responding,
        locked: vm.locked_by["1"] ?? null,
      })),
    ),
  );
  const vms = JSON.parse(vmsText) as LiveVM[];
  // The button whose request is on its way: "set_up", "start" or "lock".
  const [busy, setBusy] = useState("");
  // On a phone: the side shown.
  const [side, setSide] = useState("desktop");
  // Desktop 1's noVNC page (or the terminal, for an image without a desktop), once known.
  const [desktopUrl, setDesktopUrl] = useState<string | null>(null);
  const [terminalOnly, setTerminalOnly] = useState(false);
  // Bumped by Reconnect: a new iframe key loads the desktop again.
  const [reload, setReload] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const agent = agents.find((each) => each.repo === props.repo);
  const vmName = agent !== undefined ? agent.target_vm : null;
  const vm = vms.find((each) => each.name === vmName);
  const running = vm !== undefined && vm.status === "running";
  const locked = vm !== undefined ? vm.locked : null;
  const live = agent !== undefined ? agent.live : null;

  // Ask where desktop 1 is once the VM runs; forget it when it stops.
  useEffect(() => {
    setDesktopUrl(null);
    if (vmName === null || !running) {
      return;
    }
    const name = vmName;
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<{ desktop: string | null; terminal: string | null }>(`/api/vms/${encodeURIComponent(name)}/viewer?desktop=1`);
        if (stopped) {
          return;
        }
        setDesktopUrl(answer.desktop ?? answer.terminal);
        setTerminalOnly(answer.desktop === null);
      } catch {
        // Right after a start the VM has no address yet: try again shortly.
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
  }, [vmName, running]);

  // When the desktop gets locked, take the keyboard away from it too.
  useEffect(() => {
    if (locked !== null && frameRef.current !== null && document.activeElement === frameRef.current) {
      frameRef.current.blur();
    }
  }, [locked]);

  // Set up, and Try again after a failed set-up.
  async function setUp() {
    setBusy("set_up");
    try {
      await api(`/api/repo_live/${props.repo}`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not set it up: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function start() {
    if (vmName === null) {
      return;
    }
    setBusy("start");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/start`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not start ${vmName}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function setLock(enabled: boolean) {
    if (vmName === null) {
      return;
    }
    if (enabled && frameRef.current !== null) {
      frameRef.current.blur();
    }
    setBusy("lock");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/lock`, { method: "PUT", body: { enabled: enabled, desktop: 1 } });
    } catch (err) {
      toast.error(`Could not ${enabled ? "lock" : "unlock"} the desktop: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  if (!agentsLoaded) {
    return <div className="p-3 text-muted-foreground">Loading…</div>;
  }

  if (agent === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <Monitor className="size-8 text-muted-foreground" />
        <p className="max-w-md">Run {props.repo} in a VM of its own, with an agent that knows its code, issues and pull requests.</p>
        <Button disabled={busy !== ""} onClick={setUp}>
          {busy === "set_up" ? <Loader2 className="animate-spin" /> : <Play />} Set up
        </Button>
        <p className="max-w-md text-xs text-muted-foreground">Makes a VM for it, puts the code in it and starts the app on its desktop.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center border-b px-3 md:hidden">
        <Tabs value={side} onValueChange={setSide}>
          <TabsList>
            <TabsTrigger value="desktop" className="px-2.5">
              Desktop
            </TabsTrigger>
            <TabsTrigger value="chat" className="px-2.5">
              Chat
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn("flex min-w-0 flex-1 flex-col", side !== "desktop" && "max-md:hidden")}>
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b bg-muted/40 px-2 text-xs">
            <span className="font-medium text-muted-foreground">Desktop</span>
            {vmName !== null && (
              <a href={`#/vms/${encodeURIComponent(vmName)}`} className="text-primary hover:underline">
                {vmName}
              </a>
            )}
            {vm !== undefined && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <StatusDot tone={VM_TONE[vm.status]} />
                {STATUS_TEXT[vm.status] ?? vm.status}
              </span>
            )}
            {running && desktopUrl !== null && (
              <div className="ml-auto flex items-center gap-0.5">
                {!terminalOnly && (
                  <Button variant="ghost" size="xs" disabled={busy === "lock"} onClick={() => setLock(locked === null)}>
                    {locked !== null ? <Unlock /> : <Lock />}
                    {locked !== null ? "Unlock" : "Lock"}
                  </Button>
                )}
                <Button variant="ghost" size="xs" title="Connect again" onClick={() => setReload(reload + 1)}>
                  <RotateCw /> Reconnect
                </Button>
              </div>
            )}
          </div>

          {live !== null && live.state === "preparing" && (
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              {running ? "Putting the code in the VM…" : "Waiting for the VM; then the code goes in."}
            </div>
          )}
          {live !== null && live.state === "failed" && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-destructive">
              <span className="min-w-0 flex-1">{live.error}</span>
              <Button size="xs" variant="outline" disabled={busy !== ""} onClick={setUp}>
                {busy === "set_up" && <Loader2 className="animate-spin" />}
                Try again
              </Button>
            </div>
          )}

          <div className="relative min-h-0 flex-1 bg-muted/30">
            {running && desktopUrl !== null && (
              <iframe
                key={`${desktopUrl}-${reload}`}
                ref={frameRef}
                src={desktopUrl}
                title={terminalOnly ? `Terminal of ${vmName}` : `Desktop of ${vmName}`}
                allow="clipboard-write"
                className="absolute inset-0 size-full border-0 bg-black"
              />
            )}

            {running && desktopUrl !== null && locked !== null && !terminalOnly && (
              <div className="absolute inset-0 cursor-not-allowed">
                <div className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background py-1 pr-1 pl-2.5 whitespace-nowrap">
                  <Lock className="size-3.5 text-warn" />
                  {locked === "agent" ? "Locked by the agent while it works" : "You locked your mouse and keyboard out"}
                  <Button size="xs" variant="outline" disabled={busy === "lock"} onClick={() => setLock(false)}>
                    <Unlock /> Unlock
                  </Button>
                </div>
              </div>
            )}

            {running && desktopUrl !== null && !vm.responding && (
              <div className="absolute inset-x-0 top-2 z-10 flex justify-center px-2">
                <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1">
                  <Loader2 className="size-3.5 animate-spin text-warn" />
                  {vmName} isn't answering: it is still booting, or it froze.
                </div>
              </div>
            )}

            {running && desktopUrl === null && (
              <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Connecting…
              </div>
            )}

            {!running && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                {vm === undefined && <span>{vmName === null ? "It has no VM." : `There is no VM named ${vmName}.`}</span>}
                {vm !== undefined && (vm.status === "creating" || vm.status === "starting" || vm.status === "stopping") && (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    {vm.status === "creating" && `Creating ${vm.name}. This takes about a minute.`}
                    {vm.status === "starting" && `Starting ${vm.name}…`}
                    {vm.status === "stopping" && `Stopping ${vm.name}…`}
                  </span>
                )}
                {vm !== undefined && (vm.status === "stopped" || vm.status === "failed") && (
                  <>
                    <Power className="size-6" />
                    <span>{vm.status === "stopped" ? `${vm.name} is off.` : `${vm.name} failed.`}</span>
                    {vm.error !== null && <span className="max-w-lg text-xs text-destructive">{vm.error}</span>}
                    <Button size="sm" disabled={busy !== ""} onClick={start}>
                      {busy === "start" ? <Loader2 className="animate-spin" /> : <Play />} Start
                    </Button>
                  </>
                )}
                {vm !== undefined && vm.status === "missing" && <span>The Incus VM of {vm.name} is gone.</span>}
              </div>
            )}
          </div>
        </div>

        <div className={cn("flex w-[26rem] shrink-0 flex-col border-l max-md:w-full max-md:border-l-0", side !== "chat" && "max-md:hidden")}>
          <AgentChat key={agent.id} agentId={agent.id} compact />
        </div>
      </div>
    </div>
  );
}
