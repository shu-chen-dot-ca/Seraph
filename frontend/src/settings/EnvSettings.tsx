import { Eye, EyeOff, Loader2, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/live";

/*
The env vars for all VMs, kept by the backend (sandbox/vms.py), not the browser: GET /api/vms/global_env when the page
opens (unless you have unsaved edits), PUT to save. Agents can add empty ones (for you to fill in), so one may show up
here with no value; once you save a value for it, the agent that added it is told and carries on. Running VMs get
them at once, stopped ones when they start. A VM's own env var with the same name (its Settings tab) wins, unless it
is empty.
*/

type EnvRow = { name: string; value: string; shown: boolean };

export default function EnvSettings() {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);
  const [envEdited, setEnvEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The env vars for all VMs: when the page opens, and after a save or a discard (unless you are editing them).
  useEffect(() => {
    if (envEdited) {
      return;
    }
    let stopped = false;
    api<{ env: Record<string, string> }>("/api/vms/global_env")
      .then((data) => {
        if (stopped) {
          return;
        }
        setRows(Object.entries(data.env).map(([name, value]) => ({ name: name, value: value, shown: false })));
        setEnvLoaded(true);
      })
      .catch((err) => {
        if (!stopped) {
          setError(`Could not load the env vars: ${err instanceof Error ? err.message : err}`);
        }
      });
    return () => {
      stopped = true;
    };
  }, [envEdited]);

  async function saveEnv() {
    const env: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (name === "") {
        continue;
      }
      env[name] = row.value;
    }
    setSaving(true);
    setError("");
    try {
      const result = await api<{ failed: string[] }>("/api/vms/global_env", { method: "PUT", body: { env: env } });
      setEnvEdited(false);
      if (result.failed.length > 0) {
        toast.warning(`Saved, but could not write them to ${result.failed.join("; ")}. Those get them on their next start.`);
      } else {
        toast.success("Env vars saved for all VMs. New shells in the VMs see them.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  return (
    <section>
      <div className="mb-2 font-medium">Env vars for all VMs</div>
      {error !== "" && <p className="mb-2 border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{error}</p>}
      {!envLoaded && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      )}
      {envLoaded && rows.length === 0 && <p className="text-muted-foreground">No env vars.</p>}
      {envLoaded && (
        <div className="space-y-1">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                className="w-40 font-mono text-xs"
                placeholder="NAME"
                spellCheck={false}
                value={row.name}
                onChange={(event) => {
                  setEnvEdited(true);
                  setRows(rows.map((other, i) => (i === index ? { ...other, name: event.target.value } : other)));
                }}
              />
              <Input
                className="min-w-0 flex-1 font-mono text-xs"
                placeholder={row.value === "" ? "empty: an agent asked for it, fill it in" : "value"}
                type={row.shown ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={row.value}
                onChange={(event) => {
                  setEnvEdited(true);
                  setRows(rows.map((other, i) => (i === index ? { ...other, value: event.target.value } : other)));
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={row.shown ? "Hide the value" : "Show the value"}
                title={row.shown ? "Hide the value" : "Show the value"}
                onClick={() => setRows(rows.map((other, i) => (i === index ? { ...other, shown: !other.shown } : other)))}
              >
                {row.shown ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${row.name || "this variable"}`}
                title="Remove"
                onClick={() => {
                  setEnvEdited(true);
                  setRows(rows.filter((_, i) => i !== index));
                }}
              >
                <X />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEnvEdited(true);
                setRows([...rows, { name: "", value: "", shown: true }]);
              }}
            >
              <Plus /> Add
            </Button>
            <Button size="sm" onClick={saveEnv} disabled={!envEdited || saving}>
              {saving && <Loader2 className="animate-spin" />}
              Save
            </Button>
            {envEdited && (
              <Button variant="ghost" size="sm" onClick={() => setEnvEdited(false)}>
                Discard changes
              </Button>
            )}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Every VM gets these in every shell (shells opened after saving; stopped VMs when they start). A VM's own env var with the same
        name, in its Settings tab, wins. Agents see each name and whether it has a value, never the value. They can add empty ones
        for you to fill in.
      </p>
    </section>
  );
}
