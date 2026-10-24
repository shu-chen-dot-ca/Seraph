/*
The Agent tab of an image's Details: a chat with the image's agent (sandbox/image_agent.py). It keeps the image's
description (system, desktop, browser, what is in it) and changes it when asked, and it builds the image from it
(New image, Rebuild: its build steps show here too). Nothing changes in the image until you rebuild it. So the top
says whether the description differs from what the image was built from, with the same amber dot as the Images
row, and offers the description (or the diff, when it changed), Discard (back to what it was built from) and Rebuild.

The chat comes from GET /api/images/<name>/agent, asked again every second while the agent works.
The description and diff come from GET /api/images/<name>/spec while shown, again whenever the agent did something.
*/

import { ArrowUp, Hammer, Loader2, MessageSquarePlus, Square, Undo2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { api, type Image, type ImageAgentChat } from "@/live";
import { cn } from "@/lib/utils";

export default function ImageAgent(props: { image: Image; onRebuild: () => void }) {
  const [chat, setChat] = useState<ImageAgentChat | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Bumped after sending, so the chat is followed again until the turn ends.
  const [follow, setFollow] = useState(0);
  const [showDiff, setShowDiff] = useState(false);
  const [spec, setSpec] = useState<{ spec: string; diff: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const name = props.image.name;
  const changed = props.image.spec_changed;
  const busy = chat !== null && chat.busy;
  const historyLength = chat === null ? 0 : chat.history.length;

  // The chat: now, and every second while the agent works.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<ImageAgentChat>(`/api/images/${encodeURIComponent(name)}/agent`);
        if (stopped) {
          return;
        }
        setChat(answer);
        if (answer.busy) {
          timer = window.setTimeout(load, 1000);
        }
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [name, follow]);

  // The description and diff, while shown: again when it changes (the dot) or the agent did something.
  useEffect(() => {
    if (!showDiff) {
      return;
    }
    let stopped = false;
    api<{ spec: string; diff: string }>(`/api/images/${encodeURIComponent(name)}/spec`)
      .then((answer) => {
        if (!stopped) {
          setSpec(answer);
        }
      })
      .catch((err) => {
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      stopped = true;
    };
  }, [name, showDiff, changed, historyLength]);

  // New messages scroll the chat to the bottom.
  useEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [historyLength]);

  async function send() {
    if (text.trim() === "" || busy || sending) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await api(`/api/images/${encodeURIComponent(name)}/agent`, { method: "POST", body: { text: text } });
      setText("");
      setFollow(follow + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSending(false);
  }

  async function stop() {
    try {
      await api(`/api/images/${encodeURIComponent(name)}/agent/stop`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not stop it: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function newChat() {
    try {
      await api(`/api/images/${encodeURIComponent(name)}/agent`, { method: "DELETE" });
      setFollow(follow + 1);
    } catch (err) {
      toast.error(`Could not start a new chat: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function discard() {
    try {
      await api(`/api/images/${encodeURIComponent(name)}/spec/discard`, { method: "POST" });
      setShowDiff(false);
      toast.success(`${name}'s description is back to what it was built from.`);
    } catch (err) {
      toast.error(`Could not discard the changes: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-9 items-center gap-2 border px-2.5 py-1">
        {!changed && (
          <>
            <span className="min-w-0 flex-1 text-muted-foreground">
              The image matches its description. Ask the agent for changes; a rebuild applies them.
            </span>
            <Button size="xs" variant="ghost" onClick={() => setShowDiff(!showDiff)}>
              {showDiff ? "Hide description" : "Show description"}
            </Button>
          </>
        )}
        {changed && (
          <>
            <StatusDot tone="amber" />
            <span className="min-w-0 flex-1">The description changed since this build. The image has none of it until you rebuild.</span>
            <Button size="xs" variant="ghost" onClick={() => setShowDiff(!showDiff)}>
              {showDiff ? "Hide changes" : "Show changes"}
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmDiscard(true)}>
              <Undo2 /> Discard
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={props.onRebuild}>
              <Hammer /> Rebuild
            </Button>
          </>
        )}
      </div>

      {showDiff && !changed && (
        <pre className="max-h-60 overflow-auto border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
          {spec === null ? "Loading…" : spec.spec}
        </pre>
      )}

      {showDiff && changed && (
        <pre className="max-h-60 overflow-auto border bg-muted/40 p-2 font-mono text-xs">
          {spec === null && "Loading…"}
          {spec !== null &&
            spec.diff
              .split("\n")
              .map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    line.startsWith("+") && !line.startsWith("+++") && "text-ok",
                    line.startsWith("-") && !line.startsWith("---") && "text-destructive",
                    (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) && "text-muted-foreground",
                  )}
                >
                  {line || " "}
                </div>
              ))}
        </pre>
      )}

      <div ref={scrollRef} className="h-72 space-y-2 overflow-auto border bg-background p-2.5">
        {chat === null && error === "" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {chat !== null && chat.history.length === 0 && (
          <div className="text-muted-foreground">
            For example: "use KDE instead", "add Rust and Go", "which Python does it have?"
          </div>
        )}
        {chat !== null &&
          chat.history.map((entry, index) => {
            if (entry.type === "user") {
              return (
                <div key={index} className="ml-auto w-fit max-w-[85%] rounded-md bg-muted px-2.5 py-1.5 whitespace-pre-wrap">
                  {entry.text}
                </div>
              );
            }
            if (entry.type === "text") {
              return <Markdown key={index} text={entry.text} />;
            }
            if (entry.type === "tool") {
              return (
                <div key={index} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Wrench className="size-3" /> {entry.summary}
                </div>
              );
            }
            if (entry.type === "tool_result" && entry.is_error) {
              return (
                <div key={index} className="text-xs text-destructive">
                  {entry.text}
                </div>
              );
            }
            if (entry.type === "system") {
              return (
                <div key={index} className={cn("text-xs", entry.text.startsWith("Error") ? "text-destructive" : "text-muted-foreground")}>
                  {entry.text}
                </div>
              );
            }
            if (entry.type === "turn_end" && entry.stopped) {
              return (
                <div key={index} className="text-xs text-muted-foreground">
                  Stopped
                </div>
              );
            }
            return null;
          })}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin text-primary" /> Working…
          </div>
        )}
      </div>

      {error !== "" && <p className="text-destructive">{error}</p>}

      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-9 flex-1 resize-none"
          rows={2}
          placeholder={`Tell the agent what ${name} should have`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <Button size="sm" variant="outline" onClick={stop}>
            <Square /> Stop
          </Button>
        ) : (
          <Button size="sm" disabled={text.trim() === "" || sending} onClick={send}>
            {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />} Send
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{chat !== null && chat.cost_usd > 0 && `$${chat.cost_usd.toFixed(2)} so far`}</span>
        <Button size="xs" variant="ghost" className="ml-auto" disabled={busy || historyLength === 0} onClick={newChat}>
          <MessageSquarePlus /> New chat
        </Button>
      </div>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard the changes to {name}'s description?</AlertDialogTitle>
            <AlertDialogDescription>The description goes back to what the image was built from. The chat stays.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
