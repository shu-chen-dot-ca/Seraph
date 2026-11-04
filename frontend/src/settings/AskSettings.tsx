import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { api } from "@/live";

/*
When agents ask you (GET and PUT /api/ask_settings). Agents only ask when it matters:
- some questions always wait for you, however long it takes: the kinds switched on here;
- the others have a timer: if you don't answer in time, the agent goes ahead with the choice it recommends (long runs,
  using a machine others wait for, a kind switched off here);
- small choices are never asked: the agent decides and writes why on the issue's timeline.
When someone else takes an issue an agent works on, the agent checks who it is and decides itself.
*/

type AskSettingsData = { timer_minutes: number; must_wait: string[] };

const KINDS = [
  { key: "money", label: "Anything that costs money" },
  { key: "sensitive", label: "Politics and other sensitive subjects" },
  { key: "github", label: "What gets sent to GitHub, and how" },
  { key: "delete", label: "Deleting things that can't come back" },
];

const TIMERS = [5, 10, 30, 60];

export default function AskSettings() {
  const [settings, setSettings] = useState<AskSettingsData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<AskSettingsData>("/api/ask_settings")
      .then(setSettings)
      .catch((err) => setError(`Could not load them: ${err instanceof Error ? err.message : err}`));
  }, []);

  async function save(next: AskSettingsData) {
    setSettings(next);
    try {
      setSettings(await api<AskSettingsData>("/api/ask_settings", { method: "PUT", body: next }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="font-medium">When agents ask you</div>
        <p className="text-muted-foreground">Agents only ask when it matters. Small choices they make themselves, and write why on the issue's timeline.</p>
      </div>
      {error !== "" && <p className="text-destructive">{error}</p>}
      {settings !== null && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="warn">Waits for you</Badge> however long it takes
            </div>
            {KINDS.map((kind) => (
              <label key={kind.key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                {kind.label}
                <Switch
                  checked={settings.must_wait.includes(kind.key)}
                  aria-label={kind.label}
                  onCheckedChange={(on) =>
                    save({ ...settings, must_wait: on ? [...settings.must_wait, kind.key] : settings.must_wait.filter((key) => key !== kind.key) })
                  }
                />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Goes ahead</Badge> with the agent's recommended choice if you don't answer in
            <select
              value={settings.timer_minutes}
              onChange={(event) => save({ ...settings, timer_minutes: Number(event.target.value) })}
              className="h-7 rounded-md border bg-background px-1.5"
            >
              {[...new Set([...TIMERS, settings.timer_minutes])].sort((a, b) => a - b).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`}
                </option>
              ))}
            </select>
          </div>
          <p className="text-muted-foreground">
            Long runs (a full test run, a build), using a machine another agent waits for, and the kinds switched off above. When someone else takes an issue an
            agent is on, the agent checks who it is: a maintainer or someone who often contributes, it stops; a new or bot-like account, it keeps going. You
            aren't asked; it's on the timeline.
          </p>
        </>
      )}
    </section>
  );
}
