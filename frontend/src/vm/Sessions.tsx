import { LockIcon, PlusCircleIcon, PlusIcon, SyncIcon, TrashIcon, UnlockIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useState, type ReactNode } from "react";

import AgentChat from "./AgentChat";
import Directory from "./Directory";
import Settings from "./Settings";
import "./vm.css";

// One VM session from GET /api/vm/sessions: its record plus the VM's live state.
export interface VmSession {
  id: string;
  name: string;
  repo: string;
  vm: string;
  cpus: number;
  memory_gb: number;
  disk_gb: number;
  internet: boolean;
  env: Record<string, string>;
  autostart: boolean;
  status: string; // creating, starting, running, stopping, stopped, failed, missing
  created_at: string;
  on: boolean;
  cpu_percent: number | null;
  memory_used_gb: number | null;
  // Who locked the human's mouse and keyboard out of the desktop.
  locked_by?: "user" | "agent" | null;
}

// What the create dialog may offer, from GET /api/vm/options (set in .env).
export interface VmOptions {
  cpus: number[];
  cpus_default: number;
  memory_gb: number[];
  memory_gb_default: number;
  disk_gb_min: number;
  disk_gb_max: number;
  disk_gb_default: number;
}

// The views and the session the user had open, so a refresh opens them again.
let saved: Record<string, string | null> = {};
try {
  saved = JSON.parse(localStorage.getItem("sessions") || "{}");
} catch {
  saved = {};
}

// VM Sessions tab: session cards on the left, the picked VM's desktop, terminals, files and settings in the middle, its agent on the right.
export default function Sessions(props: { active: boolean; leftOpen: boolean; tabs: ReactNode }) {
  const [vmView, setVmView] = useState<"sessions" | "settings">(saved.vmView === "settings" ? "settings" : "sessions");
  const [createOpen, setCreateOpen] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState("");
  const [newVmName, setNewVmName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [vmSessions, setVmSessions] = useState<VmSession[]>([]);
  const [vmSessionsLoaded, setVmSessionsLoaded] = useState(false);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  // The session whose desktop the right panel shows, and the noVNC page for it.
  const [selectedVmId, setSelectedVmId] = useState<string | null>(saved.selectedVmId ?? null);
  // Where the desktop (noVNC) and the terminals (ttyd) of the selected VM are.
  const [viewerUrls, setViewerUrls] = useState<{ desktop: string; terminal: string } | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  let savedVmPanel: "desktop" | "terminal" | "directory" | "settings" | "environment" = "desktop";
  if (saved.vmPanel === "terminal" || saved.vmPanel === "directory" || saved.vmPanel === "settings" || saved.vmPanel === "environment") {
    savedVmPanel = saved.vmPanel;
  }
  const [vmPanel, setVmPanel] = useState<"desktop" | "terminal" | "directory" | "settings" | "environment">(savedVmPanel);
  // Bumped by the Reconnect button: new iframe keys make the desktop and terminals load again.
  const [viewerReload, setViewerReload] = useState(0);
  // Terminal tabs of the selected VM: tmux session names "1", "2", ...
  const [terminals, setTerminals] = useState<string[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  // Terminals that have been on screen. A terminal is only loaded once it is shown:
  // loaded while hidden it measures itself as 0 wide and stays unusable.
  const [shownTerminals, setShownTerminals] = useState<string[]>([]);
  // The VM agent's chat, in the right panel while a session is picked.
  const [agentOpen, setAgentOpen] = useState(true);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [vmOptions, setVmOptions] = useState<VmOptions | null>(null);
  const [newCpus, setNewCpus] = useState(0);
  const [newMemoryGb, setNewMemoryGb] = useState(0);
  const [newDiskGb, setNewDiskGb] = useState(0);

  // Remember the views for the next refresh. Storage can be blocked (private window): then they just aren't kept.
  useEffect(() => {
    try {
      localStorage.setItem("sessions", JSON.stringify({ vmView, vmPanel, selectedVmId }));
    } catch {
      return;
    }
  }, [vmView, vmPanel, selectedVmId]);

  // A settings change answers with the session: put it in the list.
  function updateSession(answer: VmSession) {
    setVmSessions((current) => current.map((item) => (item.id === answer.id ? { ...item, ...answer } : item)));
  }

  const selectedVm = vmSessions.find((session) => session.id === selectedVmId) ?? null;
  const selectedVmReady = selectedVm !== null && selectedVm.on && selectedVm.status === "running";
  // Locked: the desktop and terminals ignore the human's mouse and keyboard. The user or the agent can lock it.
  const inputLocked = selectedVm !== null && selectedVm.locked_by != null;

  function setInputLocked(locked: boolean) {
    if (selectedVm === null) {
      return;
    }
    // Show it right away; the next list refresh confirms it.
    updateSession({ ...selectedVm, locked_by: locked ? "user" : null });
    fetch(`/api/vm/sessions/${selectedVm.id}/lock`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: locked }),
    });
  }

  async function deleteVmSession(session: VmSession) {
    if (!window.confirm(`Delete ${session.name}? Its VM and everything in it are removed.`)) {
      return;
    }
    setDeletingIds((current) => [...current, session.id]);
    setDeleteErrors((current) => ({ ...current, [session.id]: "" }));
    try {
      const response = await fetch(`/api/vm/sessions/${session.id}`, { method: "DELETE" });
      if (response.ok) {
        setVmSessions((current) => current.filter((item) => item.id !== session.id));
        if (selectedVmId === session.id) {
          setSelectedVmId(null);
        }
      } else {
        const body = await response.json();
        setDeleteErrors((current) => ({ ...current, [session.id]: body.detail ?? "Could not delete the session." }));
      }
    } catch {
      setDeleteErrors((current) => ({ ...current, [session.id]: "Could not reach the backend." }));
    } finally {
      setDeletingIds((current) => current.filter((id) => id !== session.id));
    }
  }

  // Open the dialog with the defaults from .env.
  async function openCreate() {
    setCreateOpen(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/vm/options");
      const options: VmOptions = await response.json();
      setVmOptions(options);
      setNewCpus(options.cpus_default);
      setNewMemoryGb(options.memory_gb_default);
      setNewDiskGb(options.disk_gb_default);
    } catch {
      setCreateError("Could not reach the backend.");
    }
  }

  function closeCreate() {
    setCreateOpen(false);
    setNewRepoUrl("");
    setNewVmName("");
    setCreateError(null);
  }

  // The backend starts creating and answers right away; the list below shows the progress.
  async function createVmSession() {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/vm/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: newRepoUrl, name: newVmName, cpus: newCpus, memory_gb: newMemoryGb, disk_gb: newDiskGb }),
      });
      const body = await response.json();
      if (!response.ok) {
        setCreateError(body.detail ?? "Could not create the session.");
        return;
      }
      const created: VmSession = { ...body, on: false, cpu_percent: null, memory_used_gb: null };
      setVmSessions((current) => [...current, created]);
      closeCreate();
    } catch {
      setCreateError("Could not reach the backend.");
    } finally {
      setCreateBusy(false);
    }
  }

  // Once the selected VM is on and set up, ask where its desktop and terminals are,
  // and which terminals are still running (they survive page reloads). Drop it all when it goes off.
  useEffect(() => {
    setTerminals([]);
    setActiveTerminal(null);
    if (selectedVmId === null || !selectedVmReady) {
      setViewerUrls(null);
      setViewerError(null);
      return;
    }
    let stopped = false;
    async function loadViewer() {
      try {
        const response = await fetch(`/api/vm/sessions/${selectedVmId}/viewer`);
        const body = await response.json();
        if (stopped) {
          return;
        }
        if (!response.ok) {
          setViewerError(body.detail ?? "Could not open the VM.");
          return;
        }
        setViewerUrls(body);
        setViewerError(null);

        const terminalsResponse = await fetch(`/api/vm/sessions/${selectedVmId}/terminals`);
        let names: string[] = terminalsResponse.ok ? await terminalsResponse.json() : [];
        if (stopped) {
          return;
        }
        if (names.length === 0) {
          names = ["1"];
        }
        setTerminals(names);
        setActiveTerminal(names[0]);
      } catch {
        if (!stopped) {
          setViewerError("Could not reach the backend.");
        }
      }
    }
    loadViewer();
    return () => {
      stopped = true;
    };
  }, [selectedVmId, selectedVmReady]);

  // A new session, the VM going on or off, or Reconnect: load terminals again only when shown.
  useEffect(() => {
    setShownTerminals([]);
  }, [selectedVmId, selectedVmReady, viewerReload]);

  useEffect(() => {
    if (vmPanel === "terminal" && activeTerminal !== null && !shownTerminals.includes(activeTerminal)) {
      setShownTerminals([...shownTerminals, activeTerminal]);
    }
  }, [vmPanel, activeTerminal, shownTerminals]);

  function addTerminal() {
    let next = 1;
    for (const name of terminals) {
      next = Math.max(next, Number(name) + 1);
    }
    setTerminals([...terminals, String(next)]);
    setActiveTerminal(String(next));
  }

  // Closing a tab stops the terminal: its shell and whatever runs in it end.
  function closeTerminal(name: string) {
    const left = terminals.filter((item) => item !== name);
    setTerminals(left);
    if (activeTerminal === name) {
      setActiveTerminal(left.length > 0 ? left[left.length - 1] : null);
    }
    fetch(`/api/vm/sessions/${selectedVmId}/terminals/${name}`, { method: "DELETE" });
  }

  // While the VM Sessions tab is open, ask for the latest list about every second.
  // The next request starts only after the last one finished, so requests never pile up,
  // and a failed request keeps the list we have instead of emptying it.
  useEffect(() => {
    if (!props.active) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loadVmSessions() {
      try {
        const response = await fetch("/api/vm/sessions");
        if (response.ok && !stopped) {
          setVmSessions(await response.json());
          setVmSessionsLoaded(true);
        }
      } catch {
        // The backend is restarting; the next round tries again.
      }
      if (!stopped) {
        timer = setTimeout(loadVmSessions, 1000);
      }
    }
    loadVmSessions();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [props.active]);

  // Ctrl+Alt+B folds the agent panel. Ctrl+B is in main.tsx.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (props.active && event.ctrlKey && event.altKey && event.code === "KeyB") {
        event.preventDefault();
        if (selectedVm !== null) {
          setAgentOpen(!agentOpen);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  let layoutClass = "layout layout-vm";
  if (!props.leftOpen) {
    layoutClass += " layout-folded";
  }
  if (selectedVm !== null && agentOpen) {
    layoutClass += " layout-right layout-agent";
  }
  if (selectedVm !== null && !agentOpen) {
    layoutClass += " layout-right-folded";
  }

  return (
    <>
      <div className="container" hidden={!props.active}>
        <div className={layoutClass}>
          <div className={props.leftOpen ? "left-panel" : "left-panel left-panel-folded"}>
            {props.tabs}
            <div className="left-panel-header">
              <div className="view-toggle">
                <button className={vmView === "sessions" ? "view-toggle-on" : ""} type="button" aria-pressed={vmView === "sessions"} onClick={() => setVmView("sessions")}>
                  Sessions
                </button>
                <button className={vmView === "settings" ? "view-toggle-on" : ""} type="button" aria-pressed={vmView === "settings"} onClick={() => setVmView("settings")}>
                  Settings
                </button>
              </div>
              <button className="btn btn-primary new-session" type="button" onClick={openCreate}>
                <PlusCircleIcon size={16} /> Create new session
              </button>
            </div>

            {vmView === "sessions" && (
              <div className="vm-session-list">
                {!vmSessionsLoaded && <p className="side-empty muted">Loading sessions…</p>}
                {vmSessionsLoaded && vmSessions.length === 0 && <p className="side-empty muted">No VM sessions yet.</p>}
                {vmSessions.map((session) => (
                  <article
                    className={session.id === selectedVmId ? "vm-card vm-card-selected" : "vm-card"}
                    key={session.id}
                    onClick={() => setSelectedVmId(session.id)}
                  >
                    <div className="vm-card-title-row">
                      <strong className="vm-card-name">{session.name}</strong>
                      <span className={session.on ? "vm-state vm-state-on" : "vm-state"}>
                        <span className="vm-state-dot" />
                        {session.on ? "On" : "Off"}
                      </span>
                    </div>
                    {session.name !== session.vm && <div className="vm-card-sub">{session.vm}</div>}
                    {session.repo && <div className="vm-card-sub">{session.repo}</div>}
                    <div className="vm-card-meta">
                      <span>
                        CPU {session.on && session.cpu_percent !== null ? `${Math.round(session.cpu_percent)}%` : "–"} of {session.cpus} cores
                      </span>
                      <span>
                        Memory {session.on && session.memory_used_gb !== null ? session.memory_used_gb.toFixed(1) : "–"} / {session.memory_gb} GB
                      </span>
                      <span>Disk {session.disk_gb} GB</span>
                    </div>
                    {session.status !== "running" && session.status !== "stopped" && (
                      <div className={session.status === "failed" || session.status === "missing" ? "vm-card-status vm-card-status-bad" : "vm-card-status"}>
                        {session.status === "creating" && "Creating…"}
                        {session.status === "starting" && "Starting…"}
                        {session.status === "stopping" && "Stopping…"}
                        {session.status === "failed" && "Setup failed"}
                        {session.status === "missing" && "VM is missing"}
                      </div>
                    )}
                    {deleteErrors[session.id] && <div className="vm-card-status vm-card-status-bad">{deleteErrors[session.id]}</div>}
                    <div className="vm-card-actions">
                      <button className="btn btn-danger btn-sm" type="button" disabled={deletingIds.includes(session.id)} onClick={(event) => {
                          event.stopPropagation();
                          deleteVmSession(session);
                        }}
                      >
                        <TrashIcon size={14} /> {deletingIds.includes(session.id) ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {vmView === "settings" && <p className="side-empty muted">No settings yet.</p>}
          </div>

          <main className="results">
            <div className="results-header">
              <div className="results-header-row">
                <div className="view-toggle">
                  <button className={vmPanel === "desktop" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "desktop"} onClick={() => setVmPanel("desktop")}>
                    Desktop
                  </button>
                  <button className={vmPanel === "terminal" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "terminal"} onClick={() => setVmPanel("terminal")}>
                    Terminal
                  </button>
                  <button className={vmPanel === "directory" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "directory"} onClick={() => setVmPanel("directory")}>
                    Directory
                  </button>
                  <button className={vmPanel === "settings" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "settings"} onClick={() => setVmPanel("settings")}>
                    Settings
                  </button>
                  <button className={vmPanel === "environment" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "environment"} onClick={() => setVmPanel("environment")}>
                    Environment
                  </button>
                </div>
                {selectedVmReady && (vmPanel === "desktop" || vmPanel === "terminal") && (
                  <button className="btn btn-sm" type="button" title="Connect the desktop and terminals again" onClick={() => setViewerReload(viewerReload + 1)}>
                    <SyncIcon size={14} /> Reconnect
                  </button>
                )}
                {selectedVmReady && (vmPanel === "desktop" || vmPanel === "terminal") && (
                  <button
                    className={inputLocked ? "btn btn-sm input-lock-on" : "btn btn-sm"}
                    type="button"
                    aria-pressed={inputLocked}
                    title={inputLocked ? "Your mouse and keyboard are locked out, so the agent works undisturbed. Click to unlock." : "Lock out your mouse and keyboard, so the agent works undisturbed"}
                    onClick={() => {
                      // Take the keyboard away from the desktop or terminal it is in.
                      if (!inputLocked && document.activeElement instanceof HTMLElement) {
                        document.activeElement.blur();
                      }
                      setInputLocked(!inputLocked);
                    }}
                  >
                    {inputLocked ? <LockIcon size={14} /> : <UnlockIcon size={14} />} {inputLocked ? "Locked" : "Lock"}
                  </button>
                )}
              </div>
            </div>

            <div className="vm-viewer">
              {selectedVm === null && <p className="vm-viewer-empty muted">Pick a session on the left to open it.</p>}
              {selectedVm !== null && !selectedVmReady && (vmPanel === "desktop" || vmPanel === "terminal") && (
                <p className="vm-viewer-empty muted">
                  {selectedVm.status === "creating" && "The VM is being set up. It opens here when it is ready."}
                  {selectedVm.status === "starting" && "The VM is starting."}
                  {selectedVm.status === "stopping" && "The VM is shutting down."}
                  {selectedVm.status === "failed" && "Setup failed, so there is nothing to open."}
                  {selectedVm.status === "missing" && "The VM is missing."}
                  {(selectedVm.status === "running" || selectedVm.status === "stopped") && "The VM is off. Start it in Settings."}
                </p>
              )}
              {selectedVmReady && viewerError && (vmPanel === "desktop" || vmPanel === "terminal") && <p className="vm-viewer-empty vm-card-status-bad">{viewerError}</p>}
              {selectedVm !== null && <Settings key={`settings-${selectedVm.id}`} session={selectedVm} panel={vmPanel} onUpdate={updateSession} />}
              {selectedVm !== null && <Directory key={`directory-${selectedVm.id}`} sessionId={selectedVm.id} ready={selectedVmReady} shown={props.active && vmPanel === "directory"} />}
              {/* Covers the desktop and terminals so clicks and keys never reach them. */}
              {selectedVmReady && inputLocked && (vmPanel === "desktop" || vmPanel === "terminal") && (
                <div className="input-lock-cover">
                  <span className="input-lock-badge">
                    <LockIcon size={12} /> {selectedVm?.locked_by === "agent" ? "Locked by the agent while it works" : "Locked: the agent is in control"}
                  </span>
                </div>
              )}
              {/* Both panels stay loaded while hidden, so switching never reconnects. */}
              {selectedVmReady && viewerUrls && !viewerError && (
                <div className={vmPanel === "desktop" ? "vm-pane" : "vm-pane vm-pane-hidden"}>
                  <iframe className="vm-viewer-frame" key={`${viewerUrls.desktop}-${viewerReload}`} src={viewerUrls.desktop} title={`Desktop of ${selectedVm.name}`} />
                </div>
              )}
              {selectedVmReady && viewerUrls && !viewerError && (
                <div className={vmPanel === "terminal" ? "vm-pane" : "vm-pane vm-pane-hidden"}>
                  <div className="terminal-tabs" role="tablist">
                    {terminals.map((name) => (
                      <div key={name} className={name === activeTerminal ? "terminal-tab terminal-tab-on" : "terminal-tab"}>
                        <button className="terminal-tab-name" type="button" role="tab" aria-selected={name === activeTerminal} onClick={() => setActiveTerminal(name)}>
                          Terminal {name}
                        </button>
                        <button className="terminal-tab-close" type="button" aria-label={`Close terminal ${name}`} title="Close (stops what runs in it)" onClick={() => closeTerminal(name)}>
                          <XIcon size={12} />
                        </button>
                      </div>
                    ))}
                    <button className="terminal-tab-add" type="button" aria-label="New terminal" title="New terminal" onClick={addTerminal}>
                      <PlusIcon size={14} />
                    </button>
                  </div>
                  {terminals.length === 0 && <p className="vm-viewer-empty muted">No terminals open. Press + to open one.</p>}
                  {terminals
                    .filter((name) => shownTerminals.includes(name))
                    .map((name) => (
                    <iframe
                      key={`${viewerUrls.terminal}-${name}-${viewerReload}`}
                      className={name === activeTerminal ? "vm-viewer-frame" : "vm-viewer-frame vm-pane-hidden"}
                      src={`${viewerUrls.terminal}?arg=${name}`}
                      title={`Terminal ${name} of ${selectedVm.name}`}
                    />
                  ))}
                </div>
              )}
            </div>
          </main>

          {selectedVm !== null && <AgentChat key={`agent-chat-${selectedVm.id}`} sessionId={selectedVm.id} sessionName={selectedVm.name} open={agentOpen} onToggle={() => setAgentOpen(!agentOpen)} />}
        </div>
      </div>

      {createOpen && (
        <div className="modal-backdrop" onClick={closeCreate}>
          <form
            className="modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              createVmSession();
            }}
          >
            <h2 className="modal-title">Create new session</h2>
            <label className="modal-field">
              GitHub repo <span className="muted">(optional)</span>
              <input className="form-control" value={newRepoUrl} placeholder="https://github.com/owner/name" spellCheck={false} autoFocus onChange={(event) => setNewRepoUrl(event.target.value)} />
            </label>
            <label className="modal-field">
              VM name <span className="muted">(optional)</span>
              <input className="form-control" value={newVmName} placeholder="my-vm" spellCheck={false} onChange={(event) => setNewVmName(event.target.value)} />
            </label>
            {vmOptions && (
              <div className="modal-grid">
                <label className="modal-field">
                  CPU
                  <select className="form-select" value={newCpus} onChange={(event) => setNewCpus(Number(event.target.value))}>
                    {vmOptions.cpus.map((cpus) => (
                      <option key={cpus} value={cpus}>
                        {cpus} cores
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  Memory
                  <select className="form-select" value={newMemoryGb} onChange={(event) => setNewMemoryGb(Number(event.target.value))}>
                    {vmOptions.memory_gb.map((gb) => (
                      <option key={gb} value={gb}>
                        {gb} GB
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  Disk
                  <span className="modal-number">
                    <input
                      className="form-control"
                      type="number"
                      min={vmOptions.disk_gb_min}
                      max={vmOptions.disk_gb_max}
                      value={newDiskGb}
                      onChange={(event) => setNewDiskGb(Number(event.target.value))}
                    />
                    GB
                  </span>
                </label>
              </div>
            )}
            {createError && <p className="modal-error">{createError}</p>}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={closeCreate}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={createBusy || !vmOptions}>
                {createBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
