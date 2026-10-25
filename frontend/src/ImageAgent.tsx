/*
The Agent tab of an image's Details: a chat with the image's agent (sandbox/image_agent.py). It wrote the image's
image.yaml (the Definition tab) when the image was made, and its steps from then show here; it changes image.yaml
when asked. Nothing changes in the image until it is rebuilt (by Rebuild, or by the agent when you ask it to).

The chat comes from GET /api/images/<name>/agent, asked again every second while the agent works. What you type
and don't send is kept in this browser per image (localStorage), so it is still there when you come back, after a
reload, and after a backend restart.
*/

import { ArrowUp, Loader2, MessageSquarePlus, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { api, type Image, type ImageAgentChat } from "@/live";
import { cn } from "@/lib/utils";

export default function ImageAgent(props: { image: Image }) {
  const [chat, setChat] = useState<ImageAgentChat | null>(null);
  const [error, setError] = useState("");
  // The unsent message: from localStorage at first, and saved there as you type.
  const draftKey = `draft:image-agent:${props.image.name}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      // Storage blocked (private window): start empty.
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  // Bumped after sending, so the chat is followed again until the turn ends.
  const [follow, setFollow] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (text === "") {
        localStorage.removeItem(draftKey);
      } else {
        localStorage.setItem(draftKey, text);
      }
    } catch {
      // Storage blocked (private window): the draft just isn't kept.
    }
  }, [draftKey, text]);

  const name = props.image.name;
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

  return (
    <div className="space-y-2">
      <div ref={scrollRef} className="h-72 space-y-2 overflow-auto border bg-background p-2.5">
        {chat === null && error === "" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {chat !== null && chat.history.length === 0 && (
          <div className="text-muted-foreground">
            For example: "add Rust and Go", "use KDE instead", "why did the last Rebuild fail?"
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
    </div>
  );
}
