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
You can keep typing to Sherpa while it works: what it does on the page never takes the focus from its text box (a pop-up
it opens, a select's list), so your typing never lands in the page; and a message sent then doesn't read the page,
which would number it again under the turn using it. That goes on with the chat closed.

Chats are kept. New chat opens an empty one; History (the clock) lists them all, the newest first, named after their
first message: a click opens one to go on with it, the bin on hover deletes it. The open one is highlighted.

The chat works like an agent's (AgentChat.tsx): a message sent while Sherpa works waits for its turn to end, shown
over the text box as queued (MAX_QUEUED at most, each gets a turn of its own); Esc while Sherpa has focus stops the
turn, and the next queued message goes in. New messages scroll the chat down only while it is at the bottom, so
reading further up is never interrupted. What you type and don't send is kept in this browser (localStorage), also
after a reload. Compact (the arrows in the header) summarizes the chat to free context, when it nears the cap.

The panel stays at the bottom right; drag its left edge, top edge or top left corner to resize it. The grip reaches
8px past the border on each side, so it is easy to catch. Its size is remembered in this browser. The chat keeps its
end in view while it is resized (it stays as far from the bottom as it was). The border turns the accent color while
the panel has focus or is being resized. While dragging, a cover over the whole page keeps the mouse from getting lost
in a frame (a VM's desktop). The drag listens to mouse events: pointer events in Sherpa never reach React (the
listeners on document).

The chat works while a pop-up (Dialog) is open, to help fill it in: those keep focus, clicks and scrolling inside
themselves and close on a click outside, so Sherpa's own events never reach them (the listeners on document).
*/

import { ArrowUp, Bot, History, Loader2, MessageSquarePlus, Minimize2, Square, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { api, type SherpaChat, type SherpaChatSummary } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

// What Sherpa can use on a page, each given a number for click, fill and point.
const USABLE =
  "a[href], button, input, textarea, select, [role=tab], [role=option], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=switch], [role=checkbox], [role=radio], [role=combobox]";
const ELEMENTS_KEPT = 300;
const TEXT_KEPT = 6000;
// The messages that may wait for their turn at once (MAX_QUEUED in sherpa.py).
const MAX_QUEUED = 10;
const DRAFT_STORAGE = "draft:sherpa";

// The panel's size, as last dragged in this browser, and how small it may get.
const SIZE_STORAGE = "sherpa-size";
const MIN_SIZE = 300;
let savedSize = { width: 380, height: 560 };
try {
  const saved = JSON.parse(localStorage.getItem(SIZE_STORAGE) ?? "null");
  if (saved !== null && typeof saved.width === "number" && typeof saved.height === "number") {
    savedSize = { width: saved.width, height: saved.height };
  }
} catch {
  // Storage blocked (private window): the default size.
}

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
  // The unsent message: from localStorage at first, and saved there as you type.
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_STORAGE) ?? "";
    } catch {
      // Storage blocked (private window): start empty.
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  // The history instead of the chat, and its chats (null while loading).
  const [showHistory, setShowHistory] = useState(false);
  const [chats, setChats] = useState<SherpaChatSummary[] | null>(null);
  const [size, setSize] = useState(savedSize);
  // The cursor of the edge or corner being dragged; null when not resizing.
  const [resizing, setResizing] = useState<string | null>(null);
  // Bumped after sending, so the chat is followed again until the turn ends.
  const [follow, setFollow] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // How far the chat is scrolled up from its end, kept while the panel is resized.
  const fromBottom = useRef(0);
  // The page actions done here already (the chat is asked again before the backend has the answer), and what the
  // Sherpa points at now.
  const doneActions = useRef<number[]>([]);
  const pointed = useRef<HTMLElement | null>(null);
  // For keeping the user's typing in Sherpa while it works: whether their last click or key was in Sherpa, where in
  // Sherpa they had focus last, and whether a turn runs (for the listeners).
  const userInSherpa = useRef(false);
  const sherpaFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  const busy = chat !== null && chat.busy;
  const historyLength = chat === null ? 0 : chat.history.length;
  const queued = chat?.queued ?? [];

  useEffect(() => {
    try {
      if (text === "") {
        localStorage.removeItem(DRAFT_STORAGE);
      } else {
        localStorage.setItem(DRAFT_STORAGE, text);
      }
    } catch {
      // Storage blocked (private window): the draft just isn't kept.
    }
  }, [text]);

  useEffect(() => {
    try {
      localStorage.setItem(SIZE_STORAGE, JSON.stringify(size));
    } catch {
      // Storage blocked: the size just isn't kept.
    }
  }, [size]);

  // Dragging the left edge (sideways), the top edge (upwards) or the top left corner (both). The panel is pinned at the
  // bottom right, so moving left or up makes it bigger. It never gets smaller than MIN_SIZE or bigger than the window.
  function startResize(event: ReactMouseEvent, sideways: boolean, upwards: boolean, cursor: string) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = size;
    setResizing(cursor);
    function move(moving: MouseEvent) {
      setSize({
        width: sideways ? Math.min(Math.max(start.width + startX - moving.clientX, MIN_SIZE), window.innerWidth - 32) : start.width,
        height: upwards ? Math.min(Math.max(start.height + startY - moving.clientY, MIN_SIZE), window.innerHeight - 88) : start.height,
      });
    }
    function stop() {
      setResizing(null);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // While Sherpa works, what it does on the page never takes the focus from the user typing to it: a pop-up it opens
  // focuses itself, one that closes gives focus back to its button, a select focuses its list. Such a move is undone at
  // once, so the typing stays in Sherpa's text box and never lands in the page. The user's own click or Tab elsewhere
  // still moves it (only the user's real input counts: isTrusted).
  useEffect(() => {
    function onUserInput(event: Event) {
      if (!event.isTrusted) {
        return;
      }
      const inSherpa = event.target instanceof Element && event.target.closest("[data-sherpa-panel]") !== null;
      userInSherpa.current = inSherpa && !(event instanceof KeyboardEvent && event.key === "Tab");
    }
    function onFocusIn(event: FocusEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-sherpa-panel]") !== null) {
        sherpaFocus.current = target;
        return;
      }
      const back = sherpaFocus.current;
      if (busyRef.current && userInSherpa.current && back !== null && back.isConnected) {
        back.focus({ preventScroll: true });
      }
    }
    document.addEventListener("pointerdown", onUserInput, true);
    document.addEventListener("keydown", onUserInput, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onUserInput, true);
      document.removeEventListener("keydown", onUserInput, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);

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

  // New messages scroll the chat down only while it is at the bottom, so reading further up is never interrupted.
  useEffect(() => {
    if (scrollRef.current !== null && fromBottom.current < 40) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [historyLength, busy, queued.length]);

  // Opening the chat, and coming back from the history, start at the bottom.
  useEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      fromBottom.current = 0;
    }
  }, [open, showHistory]);

  // A new size keeps the chat as far from its end as it was, before the browser paints.
  useLayoutEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight - scrollRef.current.clientHeight - fromBottom.current;
    }
  }, [size]);

  // Sent at once, or queued while Sherpa works. Sending takes the chat to the bottom, to follow the answer.
  async function send() {
    if (text.trim() === "" || sending || queued.length >= MAX_QUEUED) {
      return;
    }
    setSending(true);
    setError("");
    fromBottom.current = 0;
    try {
      // While it works the page isn't read: that would number it again under the turn using it. Sherpa reads it later.
      await api("/api/sherpa", { method: "POST", body: { text: text, page: busy ? "" : readPage(), tab: TAB } });
      setText("");
      setFollow(follow + 1);
    } catch (err) {
      toast.error(`Could not send: ${err instanceof Error ? err.message : err}`);
    }
    setSending(false);
  }

  async function compact() {
    fromBottom.current = 0;
    try {
      await api("/api/sherpa", { method: "POST", body: { text: "/compact", page: "", tab: TAB } });
      setFollow(follow + 1);
    } catch (err) {
      toast.error(`Could not compact: ${err instanceof Error ? err.message : err}`);
    }
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
      await api("/api/sherpa/new", { method: "POST" });
      setShowHistory(false);
      setFollow(follow + 1);
    } catch (err) {
      toast.error(`Could not start a new chat: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    setChats(null);
    try {
      const answer = await api<{ chats: SherpaChatSummary[] }>("/api/sherpa/chats");
      setChats(answer.chats);
    } catch (err) {
      toast.error(`Could not load the history: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function openChat(id: string) {
    // The open one: back to it, nothing to switch.
    if (chat !== null && chat.id === id) {
      setShowHistory(false);
      return;
    }
    try {
      await api(`/api/sherpa/chats/${id}/open`, { method: "POST" });
      setShowHistory(false);
      setFollow(follow + 1);
    } catch (err) {
      toast.error(`Could not open it: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function deleteChat(id: string) {
    try {
      await api(`/api/sherpa/chats/${id}`, { method: "DELETE" });
      setChats((current) => (current === null ? null : current.filter((each) => each.id !== id)));
      // Deleting the open one opens a new chat.
      if (chat !== null && chat.id === id) {
        setFollow(follow + 1);
      }
    } catch (err) {
      toast.error(`Could not delete it: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <>
      {open && (
        <div
          data-sherpa-panel
          className="fixed right-4 bottom-[72px] z-[60] max-h-[calc(100vh-6rem)] max-w-[calc(100vw-2rem)]"
          // A pop-up sets pointer-events: none on everything outside itself; Sherpa still takes clicks.
          style={{ pointerEvents: "auto", width: size.width, height: size.height }}
        >
          {/* Drag to resize: the left edge, the top edge, the top left corner, each reaching 8px past the border (the
              panel inside clips what overflows it, so they sit out here). */}
          <div className="absolute inset-y-0 -left-2 z-10 w-4 cursor-ew-resize" onMouseDown={(event) => startResize(event, true, false, "ew-resize")} />
          <div className="absolute inset-x-0 -top-2 z-10 h-4 cursor-ns-resize" onMouseDown={(event) => startResize(event, false, true, "ns-resize")} />
          <div className="absolute -top-2 -left-2 z-20 size-5 cursor-nwse-resize" onMouseDown={(event) => startResize(event, true, true, "nwse-resize")} />
          {/* Focusable (tabIndex -1), so a click anywhere in it, not only in the text box, gives it focus and lights its border. */}
          <div
            tabIndex={-1}
            // Esc stops the turn; the next queued message then goes in. A pop-up that takes Esc first marks it handled.
            onKeyDown={(event) => {
              if (event.key === "Escape" && busy && !event.defaultPrevented) {
                event.preventDefault();
                stop();
              }
            }}
            className={cn(
              "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-background shadow-xl transition-colors outline-none focus-within:border-primary focus-within:ring-1 focus-within:ring-primary",
              resizing !== null && "border-primary ring-1 ring-primary",
            )}
          >
            <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
              <Bot className="size-4 text-primary" />
              <span className="ml-1 font-semibold">Sherpa</span>
              {/* How much of the context window the chat fills, like an agent's on the Agents page; amber past 80%. */}
              {chat !== null && (
                <span
                  className="ml-2 flex items-center gap-1.5"
                  title={`${chat.context_used.toLocaleString()} of ${chat.context_cap.toLocaleString()} tokens. The chat is compacted when it gets there.`}
                >
                  <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn("block h-full", chat.context_used / chat.context_cap > 0.8 ? "bg-warn" : "bg-primary")}
                      style={{ width: `${Math.min(100, (chat.context_used / chat.context_cap) * 100)}%` }}
                    />
                  </span>
                  <span className="text-xs tabular-nums">
                    {Math.round(chat.context_used / 1000)}k / {chat.context_cap >= 1_000_000 ? `${chat.context_cap / 1_000_000}M` : `${Math.round(chat.context_cap / 1000)}k`}
                  </span>
                </span>
              )}
              <Button size="icon-sm" variant={showHistory ? "secondary" : "ghost"} className="ml-auto" title="History" aria-label="History" onClick={toggleHistory}>
                <History />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Compact: summarize the chat to free context"
                aria-label="Compact"
                disabled={historyLength === 0 || queued.length >= MAX_QUEUED}
                onClick={compact}
              >
                <Minimize2 />
              </Button>
              <Button size="icon-sm" variant="ghost" title="New chat" aria-label="New chat" disabled={busy || historyLength === 0} onClick={newChat}>
                <MessageSquarePlus />
              </Button>
              <Button size="icon-sm" variant="ghost" title="Close" aria-label="Close Sherpa" onClick={() => setOpen(false)}>
                <X />
              </Button>
            </div>

            {showHistory && (
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {chats === null && (
                  <div className="flex items-center gap-2 p-1.5">
                    <Loader2 className="size-3.5 animate-spin" /> Loading…
                  </div>
                )}
                {chats !== null && chats.length === 0 && <div className="p-1.5">No chats yet.</div>}
                {chats !== null &&
                  chats.map((each) => (
                    <div
                      key={each.id}
                      className={cn(
                        "group flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 hover:bg-accent",
                        chat !== null && chat.id === each.id && "bg-selected hover:bg-selected",
                      )}
                      title={each.title}
                      onClick={() => openChat(each.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{each.title}</span>
                      <span className="shrink-0 text-xs group-hover:hidden">{timeAgo(each.updated_at)}</span>
                      <button
                        type="button"
                        className="hidden size-6 shrink-0 items-center justify-center rounded-sm group-hover:flex hover:bg-background hover:text-destructive"
                        title="Delete this chat"
                        aria-label={`Delete ${each.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteChat(each.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
              </div>
            )}

            <div
              ref={scrollRef}
              className={cn("min-h-0 flex-1 space-y-2 overflow-auto p-3", showHistory && "hidden")}
              onScroll={(event) => {
                fromBottom.current = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight;
              }}
            >
              {chat === null && error === "" && (
                <div className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
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
                    // In the page's own text color: prose's gray is too faint in the small panel.
                    return <Markdown key={index} className="text-foreground!" text={entry.text} />;
                  }
                  if (entry.type === "tool") {
                    return (
                      <div key={index} className="flex items-center gap-1.5 text-xs">
                        <Wrench className="size-3 shrink-0 text-primary" /> <span className="truncate">{entry.summary}</span>
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
                      <div key={index} className={cn("text-xs", entry.text.startsWith("Error") && "text-destructive")}>
                        {entry.text}
                      </div>
                    );
                  }
                  if (entry.type === "turn_end" && entry.stopped) {
                    return (
                      <div key={index} className="text-xs">
                        Stopped
                      </div>
                    );
                  }
                  return null;
                })}
              {busy && (
                <div className="flex items-center gap-2 text-xs">
                  <Loader2 className="size-3 animate-spin text-primary" /> Working…
                </div>
              )}
              {error !== "" && <p className="text-destructive">{error}</p>}
            </div>

            <div className={cn("shrink-0 border-t p-2", showHistory && "hidden")}>
              {queued.length > 0 && (
                <div className="mb-2 space-y-1">
                  <div className="text-xs">
                    {queued.length} of {MAX_QUEUED} queued, each gets its own turn · Esc stops this turn and sends the next
                  </div>
                  {queued.map((message, index) => (
                    <div key={index} className="truncate rounded-sm border border-dashed px-2 py-1" title={message}>
                      {message}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  autoFocus
                  className="max-h-40 min-h-9 flex-1 resize-none"
                  rows={2}
                  placeholder={
                    queued.length >= MAX_QUEUED
                      ? `${MAX_QUEUED} messages wait; send more when one has gone in`
                      : busy
                        ? "Message Sherpa (sent when this turn ends)"
                        : "Ask Sherpa"
                  }
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                {busy && (
                  <Button size="icon" variant="outline" title="Stop this turn; the next queued message goes in (Esc)" aria-label="Stop Sherpa" onClick={stop}>
                    <Square />
                  </Button>
                )}
                <Button size="icon" title="Send (Enter)" aria-label="Send" disabled={text.trim() === "" || sending || queued.length >= MAX_QUEUED} onClick={send}>
                  {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {resizing !== null && <div data-sherpa-panel className="fixed inset-0 z-[70]" style={{ cursor: resizing, pointerEvents: "auto" }} />}

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
