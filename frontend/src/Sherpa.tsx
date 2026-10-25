/*
Sherpa: a round button at the bottom right of every page that opens a chat with an agent who knows the whole app
(github_searcher/sherpa.py). Ask it how something works, where something is, or to do something: it sees the page you
are on and can use it while you watch: open pages, click, type into fields (a job's description, a VM's settings...)
and highlight what it talks about (a pulsing ring, gone at your next click outside the chat). It never answers an
"are you sure?" pop-up for you, and it leaves lasting changes (Save, Create, Delete...) to you unless you ask.

Each message takes the page along, as readPage reads it: the address, the sidebar, the text, and every button, link
and field, numbered (data-sherpa-id), the values of password and data-secret fields left out. With a pop-up open, only
the pop-up. While a turn runs, the chat comes from GET /api/sherpa every half second, and a page action Sherpa asks
for (pending) is done here, in the tab the message came from (TAB, kept over a reload), and its answer posted back.
That goes on with the chat closed. One conversation for the whole app; New chat starts over.

The chat works while a pop-up (Dialog) is open, to help fill it in: those keep focus, clicks and scrolling inside
themselves and close on a click outside, so Sherpa's own events never reach them (the listeners on document).
*/

import { ArrowUp, Bot, Loader2, MessageSquarePlus, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { api, type SherpaChat } from "@/live";
import { cn } from "@/lib/utils";

// What Sherpa can use on a page, each given a number for click, fill and point.
const USABLE =
  "a[href], button, input, textarea, select, [role=tab], [role=option], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=switch], [role=checkbox], [role=radio], [role=combobox]";
const ELEMENTS_KEPT = 300;
const TEXT_KEPT = 6000;

// This browser tab: Sherpa's page actions happen in the tab its message came from.
let TAB = "";
try {
  TAB = sessionStorage.getItem("sherpa-tab") ?? "";
  if (TAB === "") {
    TAB = crypto.randomUUID();
    sessionStorage.setItem("sherpa-tab", TAB);
  }
} catch {
  // Storage blocked (private window): a new id each load.
  TAB = crypto.randomUUID();
}

// The page as Sherpa sees it: the address, the sidebar, the text, and every button, link and field, numbered.
// With a pop-up open, only the pop-up (and a list or menu opened from it): the rest can't be used then.
function readPage(): string {
  for (const old of document.querySelectorAll("[data-sherpa-id]")) {
    old.removeAttribute("data-sherpa-id");
  }
  const popups = document.querySelectorAll<HTMLElement>("[role=dialog], [role=alertdialog]");
  const popup = popups.length > 0 ? popups[popups.length - 1] : null;
  const lines = [`Address: ${window.location.hash || "#/issues"}`, ""];
  let roots: Element[] = [document.body];
  if (popup !== null) {
    roots = [popup, ...document.querySelectorAll("[role=listbox], [role=menu]")];
    lines.push("A pop-up is open (close it before using the page under it):", popup.innerText.trim().slice(0, TEXT_KEPT));
  } else {
    lines.push("Sidebar:", document.querySelector("nav")?.innerText.trim() ?? "", "", "Text on the page:");
    const text = (document.querySelector("main")?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    lines.push(text.length > TEXT_KEPT ? text.slice(0, TEXT_KEPT) + "\n[...cut]" : text);
  }

  lines.push("", "What can be used (the numbers are for click, fill and point):");
  let count = 0;
  for (const root of roots) {
    for (const element of root.querySelectorAll<HTMLElement>(USABLE)) {
      if (count >= ELEMENTS_KEPT || element.hasAttribute("data-sherpa-id") || element.getClientRects().length === 0) {
        continue;
      }
      if (element.closest("[data-sherpa-panel]") !== null || element.closest("[aria-hidden=true]") !== null) {
        continue;
      }
      count += 1;
      element.setAttribute("data-sherpa-id", String(count));
      const tag = element.tagName.toLowerCase();
      const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const box = element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio");
      let kind = element.getAttribute("role") ?? tag;
      if (tag === "a") {
        kind = "link";
      } else if (tag === "textarea") {
        kind = "text box";
      } else if (element instanceof HTMLInputElement) {
        kind = box ? element.type : `${element.type} field`;
      }
      let name = element.getAttribute("aria-label") ?? "";
      if (name === "" && (field || element instanceof HTMLSelectElement)) {
        name = element.labels?.[0]?.innerText ?? "";
      }
      if (name === "" && !field) {
        name = element.innerText;
      }
      name = name.replace(/\s+/g, " ").trim().slice(0, 80);
      let line = `[${count}] ${kind} "${name}"`;
      const title = element.getAttribute("title") ?? "";
      if (title !== "" && title !== name) {
        line += ` (${title.slice(0, 120)})`;
      }
      if (field && !box) {
        const secret = (element instanceof HTMLInputElement && element.type === "password") || element.hasAttribute("data-secret");
        line += secret ? " = (hidden)" : ` = "${element.value.slice(0, 300)}"`;
        if (element.value === "" && element.placeholder !== "" && element.placeholder !== name) {
          line += `, placeholder "${element.placeholder.slice(0, 120)}"`;
        }
      }
      if (box) {
        line += (element as HTMLInputElement).checked ? " on" : " off";
      }
      if (element.getAttribute("aria-checked") !== null) {
        line += element.getAttribute("aria-checked") === "true" ? " on" : " off";
      }
      if (element.getAttribute("aria-selected") === "true") {
        line += " selected";
      }
      if (element.getAttribute("aria-pressed") === "true") {
        line += " pressed";
      }
      if (element.getAttribute("aria-expanded") === "true") {
        line += " open";
      }
      if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled")) {
        line += " disabled";
      }
      if (tag === "a") {
        line += ` → ${(element.getAttribute("href") ?? "").slice(0, 120)}`;
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export default function Sherpa() {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<SherpaChat | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Bumped after sending, so the chat is followed again until the turn ends.
  const [follow, setFollow] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The page actions done here already (the chat is asked again before the backend has the answer), and what the
  // Sherpa points at now.
  const doneActions = useRef<number[]>([]);
  const pointed = useRef<HTMLElement | null>(null);

  const busy = chat !== null && chat.busy;
  const historyLength = chat === null ? 0 : chat.history.length;

  // Pop-ups' focus trap, click-outside and scroll lock never see Sherpa's own events; a click outside Sherpa
  // ends its pointing.
  useEffect(() => {
    const kinds = ["focusin", "focusout", "pointerdown", "wheel", "touchmove"];
    function keep(event: Event) {
      const target = event.type === "focusout" ? (event as FocusEvent).relatedTarget : event.target;
      const inSherpa = target instanceof Element && target.closest("[data-sherpa-panel]") !== null;
      if (inSherpa) {
        event.stopPropagation();
      }
      if (event.type === "pointerdown" && !inSherpa && pointed.current !== null) {
        pointed.current.classList.remove("sherpa-point");
        pointed.current = null;
      }
    }
    for (const kind of kinds) {
      document.addEventListener(kind, keep, true);
    }
    return () => {
      for (const kind of kinds) {
        document.removeEventListener(kind, keep, true);
      }
    };
  }, []);

  // The chat: now, and every half second while Sherpa works, doing the page actions it asks this tab for.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<SherpaChat>("/api/sherpa");
        if (stopped) {
          return;
        }
        setChat(answer);
        const pending = answer.pending;
        if (pending !== null && pending.tab === TAB && !doneActions.current.includes(pending.id)) {
          doneActions.current.push(pending.id);
          const action = pending.action;
          const element = "element" in action ? document.querySelector<HTMLElement>(`[data-sherpa-id="${action.element}"]`) : null;
          let ok = true;
          let result = "";
          if (action.kind === "look") {
            result = readPage();
          } else if (action.kind === "go_to") {
            window.location.hash = action.address;
            await new Promise((resolve) => setTimeout(resolve, 600));
            result = readPage();
          } else if (element === null) {
            ok = false;
            result = `Element ${action.element} isn't on the page any more. The page now:\n\n${readPage()}`;
          } else if (action.kind === "point" || (action.kind === "click" && element.closest("[role=alertdialog]") !== null)) {
            pointed.current?.classList.remove("sherpa-point");
            element.classList.add("sherpa-point");
            element.scrollIntoView({ block: "nearest" });
            pointed.current = element;
            ok = action.kind === "point";
            result = ok ? "It is highlighted on the user's screen until they click somewhere." : "That is in a confirmation: the user answers those. It is highlighted for them.";
          } else if (action.kind === "click") {
            // The whole press, as a mouse does it: Radix opens menus and selects on pointerdown, tabs on mousedown.
            element.scrollIntoView({ block: "nearest" });
            const mouse = { bubbles: true, cancelable: true, button: 0, view: window };
            element.dispatchEvent(new PointerEvent("pointerdown", { ...mouse, pointerType: "mouse", isPrimary: true }));
            element.dispatchEvent(new MouseEvent("mousedown", mouse));
            element.dispatchEvent(new PointerEvent("pointerup", { ...mouse, pointerType: "mouse", isPrimary: true }));
            element.dispatchEvent(new MouseEvent("mouseup", mouse));
            element.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
            result = readPage();
          } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            // React keeps its own copy of a field's value: set it the way typing does, then tell React with an input event.
            const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, action.text);
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.scrollIntoView({ block: "nearest" });
            await new Promise((resolve) => setTimeout(resolve, 300));
            result = readPage();
          } else {
            ok = false;
            result = "That isn't a text field: fill only types into fields.";
          }
          await api("/api/sherpa/result", { method: "POST", body: { id: pending.id, ok, text: result } });
        }
        if (answer.busy && !stopped) {
          timer = window.setTimeout(load, 500);
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
  }, [follow]);

  // New messages, and opening the chat, scroll it to the bottom.
  useEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [historyLength, open]);

  async function send() {
    if (text.trim() === "" || busy || sending) {
      return;
    }
    setSending(true);
    setError("");
    try {
      await api("/api/sherpa", { method: "POST", body: { text: text, page: readPage(), tab: TAB } });
      setText("");
      setFollow(follow + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSending(false);
  }

  async function stop() {
    try {
      await api("/api/sherpa/stop", { method: "POST" });
    } catch (err) {
      toast.error(`Could not stop it: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function newChat() {
    try {
      await api("/api/sherpa", { method: "DELETE" });
      setFollow(follow + 1);
    } catch (err) {
      toast.error(`Could not start a new chat: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <>
      {open && (
        <div
          data-sherpa-panel
          className="fixed right-4 bottom-[72px] z-[60] flex h-[560px] max-h-[calc(100vh-6rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          // A pop-up sets pointer-events: none on everything outside itself; Sherpa still takes clicks.
          style={{ pointerEvents: "auto" }}
        >
          <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
            <Bot className="size-4 text-primary" />
            <span className="ml-1 font-semibold">Sherpa</span>
            <Button size="icon-sm" variant="ghost" className="ml-auto" title="New chat" aria-label="New chat" disabled={busy || historyLength === 0} onClick={newChat}>
              <MessageSquarePlus />
            </Button>
            <Button size="icon-sm" variant="ghost" title="Close" aria-label="Close Sherpa" onClick={() => setOpen(false)}>
              <X />
            </Button>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
            {chat === null && error === "" && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            )}
            {chat !== null && chat.history.length === 0 && (
              <div className="space-y-2 text-muted-foreground">
                <p>I know every page of the app and can see the one you are on. Ask how something works, where it is, or to do it for you.</p>
                <p>For example: "what does Unclaimed mean?", "make a VM with 16 GB", "write a job for this issue".</p>
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
                      <Wrench className="size-3 shrink-0" /> <span className="truncate">{entry.summary}</span>
                    </div>
                  );
                }
                if (entry.type === "tool_result" && entry.is_error) {
                  return (
                    <div key={index} className="line-clamp-3 text-xs text-destructive">
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
            {error !== "" && <p className="text-destructive">{error}</p>}
          </div>

          <div className="flex shrink-0 items-end gap-2 border-t p-2">
            <Textarea
              autoFocus
              className="max-h-40 min-h-9 flex-1 resize-none"
              rows={2}
              placeholder="Ask Sherpa"
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
              <Button size="icon" variant="outline" title="Stop" aria-label="Stop Sherpa" onClick={stop}>
                <Square />
              </Button>
            ) : (
              <Button size="icon" title="Send" aria-label="Send" disabled={text.trim() === "" || sending} onClick={send}>
                {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </Button>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        data-sherpa-panel
        className="fixed right-4 bottom-4 z-[60] flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
        style={{ pointerEvents: "auto" }}
        title={open ? "Close Sherpa" : "Sherpa: ask anything about the app"}
        aria-label={open ? "Close Sherpa" : "Open Sherpa"}
        onClick={() => setOpen(!open)}
      >
        {open ? <X className="size-5" /> : <Bot className="size-5" />}
        {busy && !open && <span className="absolute top-0 right-0 size-3 animate-pulse rounded-full border-2 border-background bg-ok" />}
      </button>
    </>
  );
}
