import { ChevronLeftIcon, ChevronRightIcon, PaperAirplaneIcon, SquareFillIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";

// The chat with one VM's agent, in the right panel, with how full its context window is.
// The agent can always be messaged, VM on or off: it can start the VM itself.
export default function AgentChat(props: { sessionId: string; sessionName: string; open: boolean; onToggle: () => void }) {
  const [vmChatMessages, setVmChatMessages] = useState<{ role: string; text: string }[]>([]);
  const [vmChatInput, setVmChatInput] = useState("");
  const [vmChatBusy, setVmChatBusy] = useState(false);
  // How full the agent's context window is, in tokens; null until the agent has started.
  const [vmContext, setVmContext] = useState<{ used: number; max: number } | null>(null);
  const vmChatBox = useRef<HTMLTextAreaElement>(null);
  // The message list, and whether the user is at its bottom. Only then do new messages scroll it
  // down; scrolled up to read, it stays where it is.
  const messagesBox = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    if (atBottom.current && messagesBox.current) {
      messagesBox.current.scrollTop = messagesBox.current.scrollHeight;
    }
  }, [vmChatMessages, vmChatBusy]);

  // Show the chat so far, and whether the agent is still answering.
  useEffect(() => {
    fetch(`/api/vm/sessions/${props.sessionId}/agent`)
      .then((response) => response.json())
      .then((body) => {
        if (body.history) {
          setVmChatMessages(body.history);
          setVmChatBusy(body.busy);
          setVmContext(body.context);
        }
      })
      .catch(() => undefined);
  }, [props.sessionId]);

  async function sendVmChat() {
    const message = vmChatInput.trim();
    const sessionId = props.sessionId;
    if (!message || vmChatBusy) {
      return;
    }
    // Sending a message takes you to the bottom, to follow the answer.
    atBottom.current = true;
    setVmChatMessages((old) => [...old, { role: "user", text: message }]);
    setVmChatInput("");
    if (vmChatBox.current) {
      vmChatBox.current.style.height = "";
    }

    setVmChatBusy(true);
    // While the agent works, show what it did so far.
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/vm/sessions/${sessionId}/agent`);
        const body = await response.json();
        if (body.history) {
          setVmChatMessages(body.history);
          setVmContext(body.context);
        }
      } catch {
        return;
      }
    }, 500);

    try {
      const response = await fetch(`/api/vm/sessions/${sessionId}/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setVmChatMessages(body.history);
      setVmContext(body.context);
    } catch (err) {
      setVmChatMessages((old) => [...old, { role: "error", text: `Chat failed: ${err instanceof Error ? err.message : err}` }]);
    }
    window.clearInterval(timer);
    setVmChatBusy(false);
  }

  function stopVmChat() {
    fetch(`/api/vm/sessions/${props.sessionId}/agent/interrupt`, { method: "POST" });
  }

  // The agent's context window as "123k/1M".
  let contextText = "Not started";
  if (vmContext !== null) {
    const max = vmContext.max >= 1000000 ? `${vmContext.max / 1000000}M` : `${Math.round(vmContext.max / 1000)}k`;
    contextText = `${Math.round(vmContext.used / 1000)}k/${max}`;
  }

  return (
    <aside className={props.open ? "right-panel agent-panel" : "right-panel agent-panel right-panel-folded"}>
      <button
        className="fold-tab"
        type="button"
        aria-label={props.open ? "Hide agent" : "Show agent"}
        title={props.open ? "Hide agent" : "Show agent"}
        onClick={props.onToggle}
      >
        {props.open ? <ChevronRightIcon size={12} /> : <ChevronLeftIcon size={12} />}
      </button>
      <div className="left-panel-header agent-header">
        <div className="context-bar" title="How full the agent's context window is">
          <div className="context-bar-fill" style={{ width: vmContext && vmContext.max > 0 ? `${Math.min(100, (vmContext.used / vmContext.max) * 100)}%` : "0%" }} />
        </div>
        <div className="context-text">
          <strong>Agent</strong>
          <span className="muted">{contextText}</span>
        </div>
      </div>
      <div className="chat">
        <div
          className="chat-messages"
          ref={messagesBox}
          onScroll={(event) => {
            const box = event.currentTarget;
            // Within a few pixels of the end counts as the bottom.
            atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
          }}
        >
          {vmChatMessages.length === 0 && <p className="chat-empty">Talk to the agent of {props.sessionName}.</p>}
          {vmChatMessages.map((message, i) => (
            <div key={i} className={`chat-message chat-message-${message.role}`}>
              {message.role === "assistant" || message.role === "activity" ? <Markdown>{message.text}</Markdown> : message.text}
            </div>
          ))}
          {vmChatBusy && (
            <p className="status-line">
              <span className="spinner" /> Thinking…
            </p>
          )}
        </div>
        <form
          className="chat-input"
          onSubmit={(event) => {
            event.preventDefault();
            sendVmChat();
          }}
        >
          <textarea
            ref={vmChatBox}
            className="form-control"
            rows={1}
            value={vmChatInput}
            placeholder="Message the agent…"
            onChange={(event) => {
              setVmChatInput(event.target.value);
              event.target.style.height = "";
              event.target.style.height = `${event.target.scrollHeight + 2}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendVmChat();
              }
              if (event.key === "Escape" && vmChatBusy) {
                stopVmChat();
              }
            }}
          />
          <div className="chat-input-row vm-chat-input-row">
            {vmChatBusy ? (
              <button className="btn" type="button" aria-label="Stop" onClick={stopVmChat}>
                <SquareFillIcon size={16} />
              </button>
            ) : (
              <button className="btn btn-primary" type="submit" aria-label="Send" disabled={!vmChatInput.trim()}>
                <PaperAirplaneIcon size={16} />
              </button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
}
