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
*/

import { ArrowUp, Bot, Loader2, MessageSquarePlus, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/live";

type SherpaEntry = { type: "user" | "text" | "tool" | "error" | "turn_end"; text: string; time: string };
type SherpaState = { history: SherpaEntry[]; busy: boolean; queued: string[]; cost_usd: number };

const DRAFT_KEY = "sherpa-draft";

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
        title="Sherpa: ask it to do things in the app for you"
        className="fixed right-4 bottom-4 z-40 flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        onClick={() => setOpen(true)}
      >
        <Bot className="size-5" />
      </button>
    );
  }

  const busy = state !== null && state.busy;
  const entries = state === null ? [] : state.history.filter((entry) => entry.type !== "turn_end");
  return (
    <div className="fixed right-4 bottom-4 z-40 flex h-[min(560px,calc(100dvh-96px))] w-[min(400px,calc(100vw-32px))] flex-col rounded-lg border bg-background shadow-2xl">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
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
