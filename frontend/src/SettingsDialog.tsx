/*
The Settings dialog, opened from the bottom of the Home tab's sidebar: the theme (Light, Dark or System), the accent
color, Reset view, the env vars for all VMs, and Remote access (RemoteAccess.tsx: the address for your phone and any
device, and the devices that may sign in there), then About (About.tsx: the version that runs, Check for updates and
Previous version). Your GitHub account is on the GitHub tab (Account, GitHub.tsx).

Reset view puts every panel, fold, sort and column back to its default: it forgets the Repos page's sort and columns
and reloads the page (App's resetView). Theme, accent and the env vars stay.

App owns the theme and accent: it applies them to <html> (class "dark" and data-accent) and keeps them in localStorage,
so a pick shows on the whole app at once, behind the dialog. index.html applies the saved ones before the first paint.

Each theme card has a tiny drawing of the app in that theme; System's is split corner to corner, light and dark.
The accent colors live in index.css (Coral is OpenClaw's own red). A swatch carries data-accent itself, so it shows that color as it looks in
the current theme (orange, green and teal get dark text in dark mode, which the check mark follows).

The env vars for all VMs are kept by the backend (sandbox/vms.py), not the browser: GET /api/vms/global_env each
time the dialog opens (unless you have unsaved edits), PUT to save. Agents can add empty ones (for you to fill in),
so one may show up here with no value; once you save a value for it, the agent that added it is told and carries on.
Running VMs get them at once, stopped ones when
they start. A VM's own env var with the same name (its Settings tab) wins, unless it is empty.
*/

import { Check, Eye, EyeOff, Loader2, Moon, Plus, RotateCcw, Sun, SunMoon, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import About from "@/About";
import RemoteAccess from "@/RemoteAccess";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/live";
import { cn } from "@/lib/utils";

export type ThemeMode = "light" | "dark" | "system";

type EnvRow = { name: string; value: string; shown: boolean };

const MODES: { id: ThemeMode; label: string; icon: LucideIcon }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: SunMoon },
];

const ACCENTS = [
  { id: "blue", name: "Blue" },
  { id: "indigo", name: "Indigo" },
  { id: "violet", name: "Violet" },
  { id: "pink", name: "Pink" },
  { id: "orange", name: "Orange" },
  { id: "green", name: "Green" },
  { id: "teal", name: "Teal" },
  { id: "coral", name: "Coral" },
  { id: "graphite", name: "Graphite" },
];

export default function SettingsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: ThemeMode;
  onTheme: (theme: ThemeMode) => void;
  accent: string;
  onAccent: (accent: string) => void;
  onResetView: () => void;
}) {
  const accentName = ACCENTS.find((each) => each.id === props.accent)?.name ?? "";
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);
  const [envEdited, setEnvEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The env vars for all VMs: each time the dialog opens, and after a save or a discard (unless you are editing them).
  useEffect(() => {
    if (!props.open || envEdited) {
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
  }, [props.open, envEdited]);

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
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Theme and accent color show right away and are kept in this browser.</DialogDescription>
        </DialogHeader>

        <section>
          <div className="mb-2 font-medium">Theme</div>
          <div className="grid grid-cols-3 gap-2.5">
            {MODES.map((mode) => {
              const selected = props.theme === mode.id;
              // System draws both: the light app, and the dark one over its lower-right half.
              const layers = mode.id === "system" ? ["light", "dark"] : [mode.id];
              return (
                <button
                  key={mode.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => props.onTheme(mode.id)}
                  className={cn(
                    "rounded-lg border bg-card p-1.5 text-left transition-colors hover:border-ring/60",
                    selected && "border-primary ring-1 ring-primary hover:border-primary",
                  )}
                >
                  <div className="relative h-16 overflow-hidden rounded-md border">
                    {layers.map((layer) => {
                      const dark = layer === "dark";
                      return (
                        <div
                          key={layer}
                          className={cn(
                            "absolute inset-0 flex",
                            dark ? "bg-[#0e1015]" : "bg-[#faf9f7]",
                            mode.id === "system" && dark && "[clip-path:polygon(100%_0,100%_100%,0_100%)]",
                          )}
                        >
                          <div className={cn("w-1/3 space-y-1 border-r p-1.5", dark ? "border-[#20232c] bg-[#111319]" : "border-[#e8e4dc] bg-[#f4f1ec]")}>
                            <div className="h-1.5 rounded-full bg-primary/70" />
                            <div className={cn("h-1.5 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                            <div className={cn("h-1.5 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                            <div className={cn("h-1.5 w-2/3 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                          </div>
                          <div className="flex-1 space-y-1.5 p-2">
                            <div className={cn("h-1.5 w-3/4 rounded-full", dark ? "bg-[#55586a]" : "bg-[#d6d0c5]")} />
                            <div className={cn("h-1.5 w-full rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                            <div className={cn("h-1.5 w-1/2 rounded-full", dark ? "bg-[#2e3040]" : "bg-[#e8e4dc]")} />
                            <div className="h-2.5 w-7 rounded-sm bg-primary" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 px-0.5">
                    <mode.icon className="size-3.5 text-muted-foreground" />
                    {mode.label}
                    {selected && <Check className="ml-auto size-3.5 text-primary" />}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-medium">Accent color</span>
            <span className="text-muted-foreground">{accentName}</span>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((each) => {
              const selected = props.accent === each.id;
              return (
                <button
                  key={each.id}
                  type="button"
                  data-accent={each.id}
                  title={each.name}
                  aria-label={each.name}
                  aria-pressed={selected}
                  onClick={() => props.onAccent(each.id)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground ring-offset-2 ring-offset-popover transition-shadow hover:ring-2 hover:ring-primary/40",
                    selected && "ring-2 ring-primary hover:ring-primary",
                  )}
                >
                  {selected && <Check className="size-3.5" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={props.onResetView}>
            <RotateCcw /> Reset view
          </Button>
          <span className="text-xs text-muted-foreground">Puts every panel, fold, sort and column back to its default. The page reloads.</span>
        </section>

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

        <RemoteAccess open={props.open} />
        <About />
      </DialogContent>
    </Dialog>
  );
}
