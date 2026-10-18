import { PlusIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";

import type { VmOptions, VmSession } from "./Sessions";

// Settings and Environment panels of one VM. Drafts are only sent when saved or applied.
export default function Settings(props: { session: VmSession; panel: string; onUpdate: (session: VmSession) => void }) {
  const [envRows, setEnvRows] = useState<[string, string][]>(Object.entries(props.session.env ?? {}));
  // True while the user has unsaved edits; until then, changes made by the agent show up here.
  const [envEdited, setEnvEdited] = useState(false);
  const envJson = JSON.stringify(props.session.env ?? {});
  useEffect(() => {
    if (!envEdited) {
      setEnvRows(Object.entries(JSON.parse(envJson)));
    }
  }, [envJson, envEdited]);
  const [settingsCpus, setSettingsCpus] = useState(props.session.cpus);
  const [settingsMemoryGb, setSettingsMemoryGb] = useState(props.session.memory_gb);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // The CPU and memory choices, from .env.
  const [vmOptions, setVmOptions] = useState<VmOptions | null>(null);

  useEffect(() => {
    fetch("/api/vm/options")
      .then((response) => response.json())
      .then((options) => setVmOptions(options))
      .catch(() => setSettingsError("Could not reach the backend."));
  }, []);

  // One settings change: start, stop, internet, autostart, resources or env.
  async function vmSettingsCall(action: string, method: string, body?: object) {
    setSettingsError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${props.session.id}/${action}`, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const answer = await response.json();
      if (!response.ok) {
        setSettingsError(answer.detail ?? "That did not work.");
        return;
      }
      if (answer.id) {
        props.onUpdate(answer);
      }
    } catch {
      setSettingsError("Could not reach the backend.");
    }
  }

  function saveEnv() {
    const env: Record<string, string> = {};
    for (const [key, value] of envRows) {
      if (key.trim() !== "") {
        env[key.trim()] = value;
      }
    }
    vmSettingsCall("env", "PUT", { env: env });
    setEnvEdited(false);
  }

  if (props.panel === "environment") {
    return (
      <div className="vm-pane vm-settings">
        {settingsError && <p className="vm-card-status vm-card-status-bad">{settingsError}</p>}

        <section className="vm-settings-section">
          <h3 className="vm-settings-title">Environment variables</h3>
          {envRows.map((row, index) => (
            <div className="vm-settings-env-row" key={index}>
              <input
                className="form-control"
                value={row[0]}
                placeholder="NAME"
                spellCheck={false}
                onChange={(event) => {
                  setEnvEdited(true);
                  setEnvRows(envRows.map((item, i) => (i === index ? [event.target.value, item[1]] : item)));
                }}
              />
              <input
                className="form-control"
                value={row[1]}
                placeholder="value"
                spellCheck={false}
                onChange={(event) => {
                  setEnvEdited(true);
                  setEnvRows(envRows.map((item, i) => (i === index ? [item[0], event.target.value] : item)));
                }}
              />
              <button className="terminal-tab-close" type="button" aria-label="Remove variable" onClick={() => {
                  setEnvEdited(true);
                  setEnvRows(envRows.filter((_, i) => i !== index));
                }}>
                <XIcon size={14} />
              </button>
            </div>
          ))}
          <div className="vm-settings-row">
            <button className="btn btn-sm" type="button" onClick={() => {
                setEnvEdited(true);
                setEnvRows([...envRows, ["", ""]]);
              }}>
              <PlusIcon size={14} /> Add variable
            </button>
            <button className="btn btn-sm btn-primary" type="button" onClick={saveEnv}>
              Save variables
            </button>
          </div>
          <p className="vm-settings-note muted">For every shell in the VM. Terminals opened after saving see them; close and reopen ones that are already open.</p>
          <p className="vm-settings-note muted">For secrets only. The agent sees each name and whether it has a value, never the value itself. It can still use them in commands, add empty ones for you to fill in, and remove ones that are still empty.</p>
        </section>
      </div>
    );
  }
  if (props.panel === "settings") {
    return (
      <div className="vm-pane vm-settings">
        {settingsError && <p className="vm-card-status vm-card-status-bad">{settingsError}</p>}

        <section className="vm-settings-section">
          <h3 className="vm-settings-title">Power</h3>
          <div className="vm-settings-row">
            <span className={props.session.on ? "vm-state vm-state-on" : "vm-state"}>
              <span className="vm-state-dot" />
              {props.session.status === "starting" ? "Starting…" : props.session.status === "stopping" ? "Stopping…" : props.session.on ? "On" : "Off"}
            </span>
            {props.session.on ? (
              <button className="btn btn-sm" type="button" disabled={props.session.status !== "running" && props.session.status !== "failed"} onClick={() => vmSettingsCall("stop", "POST")}>
                Stop
              </button>
            ) : (
              <button className="btn btn-sm" type="button" disabled={props.session.status !== "stopped" && props.session.status !== "running"} onClick={() => vmSettingsCall("start", "POST")}>
                Start
              </button>
            )}
          </div>
          <p className="vm-settings-note muted">Stopping keeps the disk; starting brings everything back except what was only in memory.</p>
        </section>

        <section className="vm-settings-section">
          <h3 className="vm-settings-title">Network</h3>
          <label className="vm-settings-check">
            <input type="checkbox" checked={props.session.internet} onChange={(event) => vmSettingsCall("internet", "PUT", { enabled: event.target.checked })} />
            Internet
          </label>
          <p className="vm-settings-note muted">Off blocks everything the VM starts itself. The desktop and terminal keep working. This computer and your local network are never reachable from the VM.</p>
        </section>

        <section className="vm-settings-section">
          <h3 className="vm-settings-title">Resources</h3>
          {vmOptions && (
            <div className="vm-settings-row">
              <select className="form-select vm-settings-select" value={settingsCpus} disabled={props.session.on} onChange={(event) => setSettingsCpus(Number(event.target.value))}>
                {vmOptions.cpus.map((cpus) => (
                  <option key={cpus} value={cpus}>
                    {cpus} cores
                  </option>
                ))}
              </select>
              <select className="form-select vm-settings-select" value={settingsMemoryGb} disabled={props.session.on} onChange={(event) => setSettingsMemoryGb(Number(event.target.value))}>
                {vmOptions.memory_gb.map((gb) => (
                  <option key={gb} value={gb}>
                    {gb} GB memory
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                type="button"
                disabled={props.session.on || (settingsCpus === props.session.cpus && settingsMemoryGb === props.session.memory_gb)}
                onClick={() => vmSettingsCall("resources", "PUT", { cpus: settingsCpus, memory_gb: settingsMemoryGb })}
              >
                Apply
              </button>
            </div>
          )}
          <p className="vm-settings-note muted">{props.session.on ? "Stop the VM to change CPU and memory." : "Applies the next time the VM starts."} Disk: {props.session.disk_gb} GB (fixed).</p>
        </section>

        <section className="vm-settings-section">
          <h3 className="vm-settings-title">Startup</h3>
          <label className="vm-settings-check">
            <input type="checkbox" checked={props.session.autostart} onChange={(event) => vmSettingsCall("autostart", "PUT", { enabled: event.target.checked })} />
            Start this VM when the computer starts
          </label>
        </section>

        <section className="vm-settings-section">
          <h3 className="vm-settings-title">About</h3>
          <dl className="vm-settings-about">
            <dt>VM</dt>
            <dd>{props.session.vm}</dd>
            <dt>Repo</dt>
            <dd>{props.session.repo || "none"}</dd>
            <dt>Created</dt>
            <dd>{new Date(props.session.created_at).toLocaleString()}</dd>
          </dl>
        </section>
      </div>
    );
  }
  return null;
}
