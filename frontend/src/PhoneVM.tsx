/*
The Workspace tab's VM page (#/vm), listed only in phone mode's Menu (WorkspaceNav.tsx): one VM desktop to use
yourself from the phone. Held upright: the screen on top, as wide as the phone, then Type here and the keys, then the
desktop list and Release, so the screen and the keys stay above the phone's keyboard while you type. Turned sideways
(a phone: landscape and under 500px tall): only the screen, over the whole page, the header too; no keys and no list.
Turn it upright again for those. Only while a desktop shows; else the page stays as it is.

The list has every desktop of every VM, and New VM. Picking a desktop takes it over (the same as Take over
on the VM's page): it is yours, and no agent gets it until you Release it, also after a restart. An agent that held it
is interrupted and waits first in line for it again. The page shows the desktop you hold (the first one, when you hold
more); picking another releases it first. New VM opens NewVMDialog, and the new VM's desktop 1 is yours at once.

The screen is LiveDesktop.tsx, always through the backend (the websocket /api/vms/{name}/vnc), so it works the same
through the remote access domain and on this computer. A tap clicks, a long press right-clicks, two fingers scroll.
Under it, Type here opens the phone's keyboard: what you type goes to the VM, Return and backspace too. Then the keys a
phone keyboard lacks. Ctrl and Alt stay on for the next key (lit until then); Super, Esc, Tab and the arrows are
pressed at once. The keys don't take the focus, so the phone's keyboard stays open.

Creating, starting, stopping and off say so (Start while off). A VM from a terminal-only image has no desktop to show.
*/

import type RFB from "@novnc/novnc";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Loader2, Play, Plus, Power } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import LiveDesktop from "@/LiveDesktop";
import NewVMDialog from "@/NewVMDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, useLive, type VMSummary } from "@/live";

// X keysyms: what VNC sends for each key.
const ESCAPE = 0xff1b;
const TAB = 0xff09;
const ENTER = 0xff0d;
const BACKSPACE = 0xff08;
const LEFT = 0xff51;
const UP = 0xff52;
const RIGHT = 0xff53;
const DOWN = 0xff54;
const CONTROL = 0xffe3;
const ALT = 0xffe9;
const SUPER = 0xffeb;

// A phone turned sideways. A tablet is taller than this, also sideways.
const LANDSCAPE = "(orientation: landscape) and (max-height: 500px)";

export default function PhoneVM() {
  const vms = useLive("vms");
  const agents = useLive("agents");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  // Ctrl and Alt, on for the next key.
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  // The VM has no desktop (a terminal-only image).
  const [terminalOnly, setTerminalOnly] = useState(false);
  const rfbRef = useRef<RFB | null>(null);
  const [landscape, setLandscape] = useState(window.matchMedia(LANDSCAPE).matches);

  // Follow the phone as it turns.
  useEffect(() => {
    const media = window.matchMedia(LANDSCAPE);
    function update() {
      setLandscape(media.matches);
    }
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // The desktop you hold: the first one found.
  let held: VMSummary | null = null;
  let heldDesktop = 1;
  for (const vm of vms) {
    for (let index = 0; index < vm.desktops.length; index++) {
      if (held === null && vm.desktops[index].holder === "user") {
        held = vm;
        heldDesktop = index + 1;
      }
    }
  }
  const heldName = held !== null ? held.name : null;
  const running = held !== null && held.status === "running";

  // Once it runs, ask whether it has a desktop at all; right after a start it has no address yet, so again shortly.
  useEffect(() => {
    setTerminalOnly(false);
    if (heldName === null || !running) {
      return;
    }
    const name = heldName;
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<{ desktop: string | null }>(`/api/vms/${encodeURIComponent(name)}/viewer?desktop=${heldDesktop}`);
        if (!stopped) {
          setTerminalOnly(answer.desktop === null);
        }
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
  }, [heldName, heldDesktop, running]);

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  // "vm1:2" takes desktop 2 of vm1 over, after letting go of the one you hold; "new" opens New VM.
  async function pick(value: string) {
    if (value === "new") {
      setCreating(true);
      return;
    }
    const [vmName, number] = value.split(":");
    setBusy(true);
    try {
      if (held !== null) {
        await api(`/api/vms/${encodeURIComponent(held.name)}/release`, { method: "POST", body: { desktop: heldDesktop } });
      }
      await api(`/api/vms/${encodeURIComponent(vmName)}/take_over`, { method: "POST", body: { desktop: Number(number) } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function release() {
    if (held === null) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api/vms/${encodeURIComponent(held.name)}/release`, { method: "POST", body: { desktop: heldDesktop } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function start() {
    if (held === null) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api/vms/${encodeURIComponent(held.name)}/start`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not start ${held.name}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy(false);
  }

  // One key, with Ctrl and Alt held around it when they are on; then they go off.
  function press(keysym: number) {
    const rfb = rfbRef.current;
    if (rfb === null) {
      return;
    }
    if (ctrl) {
      rfb.sendKey(CONTROL, null, true);
    }
    if (alt) {
      rfb.sendKey(ALT, null, true);
    }
    rfb.sendKey(keysym, null);
    if (alt) {
      rfb.sendKey(ALT, null, false);
    }
    if (ctrl) {
      rfb.sendKey(CONTROL, null, false);
    }
    setCtrl(false);
    setAlt(false);
  }

  // What was typed in Type here goes to the VM, and the box is empty again.
  function typeText(input: HTMLInputElement) {
    const text = input.value;
    input.value = "";
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (char === "\n") {
        press(ENTER);
      } else if (code < 0x100) {
        // A Latin-1 character is its own keysym.
        press(code);
      } else {
        // Any other character: 0x1000000 + its code point.
        press(0x1000000 + code);
      }
    }
  }

  const value = held !== null ? `${held.name}:${heldDesktop}` : "";
  const url = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/vms/${encodeURIComponent(heldName ?? "")}/vnc?desktop=${heldDesktop}`;
  // A key under the screen: it doesn't take the focus, so the phone's keyboard stays open.
  const key = "h-9 touch-manipulation px-0";
  const keep = (event: React.MouseEvent) => event.preventDefault();
  // Sideways with a desktop showing: only the screen. The screen's box stays the same element, so turning the phone
  // doesn't connect again.
  const full = landscape && held !== null && running && !terminalOnly;

  return (
    <div className="flex h-full flex-col">
      <div className={full ? "fixed inset-0 z-50 bg-black" : "relative aspect-[16/10] max-h-[60vh] w-full shrink-0 bg-muted/30"}>
        {held === null && (
          <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground">
            Pick a VM. Its desktop is yours until you release it: no agent uses it.
          </div>
        )}
        {held !== null && running && !terminalOnly && (
          <LiveDesktop url={url} viewOnly={false} rfbRef={rfbRef} className="absolute inset-0 size-full bg-black" />
        )}
        {held !== null && running && terminalOnly && (
          <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground">{held.name} has no desktop: its image is terminal only.</div>
        )}
        {held !== null && (held.status === "creating" || held.status === "starting" || held.status === "stopping") && (
          <div className="flex h-full items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {held.status === "creating" && `Creating ${held.name}. This takes about a minute.`}
            {held.status === "starting" && `Starting ${held.name}…`}
            {held.status === "stopping" && `Stopping ${held.name}…`}
          </div>
        )}
        {held !== null && (held.status === "stopped" || held.status === "failed") && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <Power className="size-6" />
            {held.status === "stopped" ? `${held.name} is off.` : `${held.name} failed.`}
            {held.error !== null && <span className="text-xs text-destructive">{held.error}</span>}
            <Button disabled={busy} onClick={start}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />} Start
            </Button>
          </div>
        )}
      </div>

      {!full && held !== null && running && !terminalOnly && (
        <div className="shrink-0 space-y-2 border-t p-2">
          <Input
            type="text"
            placeholder="Type here"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            // 16px: a smaller box makes the iPhone zoom in on it.
            className="h-9 text-base"
            onInput={(event) => {
              // While a word is still being composed (pinyin, ...), it goes when it is done.
              if (!(event.nativeEvent as InputEvent).isComposing) {
                typeText(event.currentTarget);
              }
            }}
            onCompositionEnd={(event) => typeText(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                press(ENTER);
              }
              // The box is always empty, so backspace has nothing to delete there: it goes to the VM.
              if (event.key === "Backspace" && event.currentTarget.value === "") {
                event.preventDefault();
                press(BACKSPACE);
              }
            }}
          />
          <div className="grid grid-cols-9 gap-1">
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(ESCAPE)}>
              Esc
            </Button>
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(TAB)}>
              Tab
            </Button>
            <Button variant={ctrl ? "default" : "outline"} className={key} onMouseDown={keep} onClick={() => setCtrl(!ctrl)}>
              Ctrl
            </Button>
            <Button variant={alt ? "default" : "outline"} className={key} onMouseDown={keep} onClick={() => setAlt(!alt)}>
              Alt
            </Button>
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(SUPER)}>
              Super
            </Button>
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(LEFT)} aria-label="Left">
              <ArrowLeft />
            </Button>
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(UP)} aria-label="Up">
              <ArrowUp />
            </Button>
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(DOWN)} aria-label="Down">
              <ArrowDown />
            </Button>
            <Button variant="outline" className={key} onMouseDown={keep} onClick={() => press(RIGHT)} aria-label="Right">
              <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {!full && (
        <div className="flex shrink-0 items-center gap-2 border-t p-2">
          <Select value={value} onValueChange={pick} disabled={busy}>
            <SelectTrigger className="h-9 min-w-0 flex-1">
              <SelectValue placeholder="Pick a VM" />
            </SelectTrigger>
            <SelectContent>
              {vms.map((vm) =>
                vm.desktops.map((line, index) => {
                  const number = index + 1;
                  let heldBy = "Free";
                  if (line.holder === "user") {
                    heldBy = "Held by you";
                  }
                  if (line.holder !== null && line.holder !== "user") {
                    heldBy = `Held by ${agentNames[line.holder] ?? line.holder}`;
                  }
                  return (
                    <SelectItem key={`${vm.name}:${number}`} value={`${vm.name}:${number}`}>
                      {vm.desktops.length === 1 ? vm.name : `${vm.name} · Desktop ${number}`}
                      <span className="text-muted-foreground">{heldBy}</span>
                    </SelectItem>
                  );
                }),
              )}
              {vms.length > 0 && <SelectSeparator />}
              <SelectItem value="new">
                <Plus /> New VM
              </SelectItem>
            </SelectContent>
          </Select>
          {held !== null && (
            <Button variant="outline" className="h-9" disabled={busy} onClick={release}>
              Release
            </Button>
          )}
        </div>
      )}

      <NewVMDialog open={creating} onOpenChange={setCreating} onCreated={(name) => pick(`${name}:1`)} />
    </div>
  );
}
