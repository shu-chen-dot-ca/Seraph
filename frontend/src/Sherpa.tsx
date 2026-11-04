/*
Sherpa: the round button at the bottom right of every page. It opens a chat with a helper that does things in the
app for you (github_searcher/sherpa.py), the way you would with the buttons, many at once: "remove every issue opened
more than 30 days ago" is one message. It reads what the pages show and uses the app's own actions. It never sends
anything to GitHub (Approve, comments and PR actions stay yours), and asks in the chat before something that can't be
undone (deleting a VM, cancelling jobs). Each message takes the page you are on along, so "these" means what you see.

The panel: the chat (your messages, Sherpa's answers, and a gray line for each thing it did), a box to write in (Enter
sends, Shift+Enter is a new line; what you haven't sent is kept in this browser), Send, and Stop while it works (a
message sent meanwhile waits for its turn). New chat (the plus) starts over; X closes the panel, and the work goes on.
While open it asks GET /api/sherpa every second.

The button can be dragged anywhere (and the panel by its title bar); it stays where you put it, kept in this browser
as its distance from the bottom right corner. A press that doesn't move is a click.
*/

import { ArrowUp, Bot, Loader2, MessageSquarePlus, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/live";

type SherpaEntry = { type: "user" | "text" | "tool" | "error" | "turn_end"; text: string; time: string };
type SherpaState = { history: SherpaEntry[]; busy: boolean; queued: string[]; cost_usd: number };

const DRAFT_KEY = "sherpa-draft";
const SPOT_KEY = "sherpa-spot";

type Spot = { right: number; bottom: number };

function savedSpot(): Spot {
  try {
    const saved = JSON.parse(localStorage.getItem(SPOT_KEY) ?? "null");
    if (saved !== null && typeof saved.right === "number" && typeof saved.bottom === "number") {
      return saved;
    }
  } catch {
    // Not kept: a private window, or storage turned off.
  }
  return { right: 16, bottom: 16 };
}

export default function Sherpa() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SherpaState | null>(null);
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const bottom = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot>(savedSpot);
  // The drag going on: where the pointer and the spot were when it started, and whether it moved yet.
  const drag = useRef<{ x: number; y: number; spot: Spot; moved: boolean } | null>(null);
  // Set when a press turned into a drag, so the click that follows it doesn't open the panel.
  const dragged = useRef(false);

  // The chat, every second while the panel is open.
  useEffect(() => {
    if (!open) {
      return;
    }
    let stopped = false;
    const load = () => {
      api<SherpaState>("/api/sherpa")
        .then((answer) => {
          if (!stopped) {
            setState(answer);
          }
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open]);

  // New entries keep the end in view.
  const count = state === null ? 0 : state.history.length + state.queued.length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, open]);

  function keepDraft(value: string) {
    setText(value);
    try {
      localStorage.setItem(DRAFT_KEY, value);
    } catch {
      // Not kept: a private window, or storage turned off.
    }
  }

  async function send() {
    const message = text.trim();
    if (message === "") {
      return;
    }
    keepDraft("");
    try {
      setState(await api<SherpaState>("/api/sherpa/send", { method: "POST", body: { text: message, page: window.location.hash } }));
    } catch (err) {
      keepDraft(message);
      toast.error(`Could not send it: ${err instanceof Error ? err.message : err}`);
    }
  }

  function startDrag(event: PointerEvent<HTMLElement>) {
    // The panel's own buttons (New chat, Close) stay buttons.
    const onButton = (event.target as HTMLElement).closest("button");
    if (event.button !== 0 || (onButton !== null && onButton !== event.currentTarget)) {
      return;
    }
    drag.current = { x: event.clientX, y: event.clientY, spot: spot, moved: false };
    dragged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const start = drag.current;
    if (start === null) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.abs(dx) + Math.abs(dy) < 5) {
      return;
    }
    start.moved = true;
    const right = Math.min(Math.max(start.spot.right - dx, 0), window.innerWidth - 48);
    const bottomEdge = Math.min(Math.max(start.spot.bottom - dy, 0), window.innerHeight - 48);
    setSpot({ right: right, bottom: bottomEdge });
  }

  function endDrag() {
    const start = drag.current;
    drag.current = null;
    if (start === null || !start.moved) {
      return;
    }
    dragged.current = true;
    try {
      localStorage.setItem(SPOT_KEY, JSON.stringify(spot));
    } catch {
      // Not kept: a private window, or storage turned off.
    }
  }

  async function act(path: string) {
    try {
      setState(await api<SherpaState>(path, { method: "POST" }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        title="Sherpa: ask it to do things in the app for you. Drag to move it."
        className="fixed z-40 flex size-11 touch-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        style={{ right: spot.right, bottom: spot.bottom }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (!dragged.current) {
            setOpen(true);
          }
          dragged.current = false;
        }}
      >
        <Bot className="size-5" />
      </button>
    );
  }

  const busy = state !== null && state.busy;
  const entries = state === null ? [] : state.history.filter((entry) => entry.type !== "turn_end");
  // The panel opens from the button's corner, moved in as far as it takes to fit on the screen.
  const width = Math.min(400, window.innerWidth - 32);
  const height = Math.min(560, window.innerHeight - 96);
  const right = Math.max(Math.min(spot.right, window.innerWidth - width - 8), 8);
  const bottomEdge = Math.max(Math.min(spot.bottom, window.innerHeight - height - 8), 8);
  return (
    <div className="fixed z-40 flex flex-col rounded-lg border bg-background shadow-2xl" style={{ right: right, bottom: bottomEdge, width: width, height: height }}>
      <div
        className="flex h-10 shrink-0 cursor-move touch-none items-center gap-2 border-b px-3"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Bot className="size-4 text-muted-foreground" />
        <span className="font-medium">Sherpa</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" title="New chat" disabled={busy} onClick={() => act("/api/sherpa/new")}>
            <MessageSquarePlus />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Close" onClick={() => setOpen(false)}>
            <X />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm">
        {state !== null && entries.length === 0 && (
          <div className="text-muted-foreground">
            Tell me what to do in the app, for example "remove every issue opened more than 30 days ago". I don't send anything to GitHub, and I ask before
            something that can't be undone.
          </div>
        )}
        {entries.map((entry, index) => (
          <div key={index}>
            {entry.type === "user" && <div className="ml-8 rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap">{entry.text}</div>}
            {entry.type === "text" && <Markdown text={entry.text} />}
            {entry.type === "tool" && (
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Wrench className="size-3 shrink-0" />
                <span className="truncate font-mono">{entry.text}</span>
              </div>
            )}
            {entry.type === "error" && <div className="text-xs text-destructive">{entry.text}</div>}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Working
          </div>
        )}
        {state !== null &&
          state.queued.map((message, index) => (
            <div key={`queued-${index}`} className="ml-8 rounded-lg border border-dashed px-3 py-2 whitespace-pre-wrap text-muted-foreground">
              {message}
            </div>
          ))}
        <div ref={bottom} />
      </div>

      <div className="flex shrink-0 items-end gap-1.5 border-t p-2">
        <Textarea
          autoFocus
          className="max-h-40 min-h-10 resize-none"
          placeholder={busy ? "It waits until Sherpa is done." : "What should I do?"}
          value={text}
          onChange={(event) => keepDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {busy && (
          <Button variant="outline" size="icon" title="Stop" onClick={() => act("/api/sherpa/stop")}>
            <Square />
          </Button>
        )}
        <Button size="icon" title="Send" disabled={text.trim() === ""} onClick={() => send()}>
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
