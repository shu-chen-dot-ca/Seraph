/*
Automation for the Dashboard's Issues board, opened by the robot button over it (IssueBoard.tsx), laid out like a repo's
Automation (AutomationDialog.tsx). Kept by the backend (backend/issues_api.py, GET and PUT /api/issues/auto_remove).

Left, Remove automatically: which issues leave the Issues list by themselves. Claimed, Out of scope and Scope not clear,
then Complexity (Easy, Medium, Hard) in a row, then Opened more than N days ago (30 at first). Only issues no agent has
started and that aren't in Catalog go. The backend applies them again as issues get read, so one that matches later
goes then; each time anything goes it is one undo step on the Issues page.
Right, Refresh every (minutes): how often the board's issues are read again, by column: Open (30 at first), Catalog
(15) and In progress, Review and Open PR (5). Finished ones are read again only when they change on GitHub. Under it Max agents
at once: how many agents work on the board's issues at the same time (3 at first); while there is room, the backend
gives Catalog's cards to new agents from the top, first come first served, the cards of repos with Take issues on
(keep_catalog_agents in backend/issues_api.py).
The number boxes take digits only. Save checks them, keeps it all and applies the removal at once (a toast says how many
went); Cancel, Esc or the X drop the changes.
*/

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectBox } from "@/components/ui/row-selection";
import { api } from "@/live";

type Rules = {
  claimed: boolean;
  out_of_scope: boolean;
  levels: string[]; // "easy", "medium", "hard"
  scope_not_clear: boolean;
  older_than_days: number | null; // null: off
  refresh_open_minutes: number;
  refresh_catalog_minutes: number;
  refresh_ongoing_minutes: number;
  max_agents: number;
};

const LEVELS: Record<string, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export default function BoardAutomationDialog(props: { onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [outOfScope, setOutOfScope] = useState(false);
  const [levels, setLevels] = useState<string[]>([]);
  const [scopeNotClear, setScopeNotClear] = useState(false);
  const [older, setOlder] = useState(false);
  // The numbers as typed (digits only); Save checks them.
  const [days, setDays] = useState("30");
  const [openMinutes, setOpenMinutes] = useState("30");
  const [catalogMinutes, setCatalogMinutes] = useState("15");
  const [ongoingMinutes, setOngoingMinutes] = useState("5");
  const [maxAgents, setMaxAgents] = useState("3");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Rules>("/api/issues/auto_remove")
      .then((rules) => {
        setClaimed(rules.claimed);
        setOutOfScope(rules.out_of_scope);
        setLevels(rules.levels);
        setScopeNotClear(rules.scope_not_clear);
        setOlder(rules.older_than_days !== null);
        if (rules.older_than_days !== null) {
          setDays(String(rules.older_than_days));
        }
        setOpenMinutes(String(rules.refresh_open_minutes));
        setCatalogMinutes(String(rules.refresh_catalog_minutes));
        setOngoingMinutes(String(rules.refresh_ongoing_minutes));
        setMaxAgents(String(rules.max_agents));
        setLoaded(true);
      })
      .catch((err) => setError(`Could not read them: ${err instanceof Error ? err.message : err}`));
  }, []);

  function toggleLevel(level: string) {
    if (levels.includes(level)) {
      setLevels(levels.filter((each) => each !== level));
    } else {
      setLevels([...levels, level]);
    }
  }

  async function save() {
    if (older && (days === "" || Number(days) < 1)) {
      setError("The days must be 1 or more.");
      return;
    }
    for (const minutes of [openMinutes, catalogMinutes, ongoingMinutes]) {
      if (minutes === "" || Number(minutes) < 1 || Number(minutes) > 1440) {
        setError("Refresh every 1 to 1440 minutes.");
        return;
      }
    }
    if (maxAgents === "" || Number(maxAgents) < 1 || Number(maxAgents) > 100) {
      setError("Max agents must be 1 to 100.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body: Rules = {
        claimed: claimed,
        out_of_scope: outOfScope,
        levels: levels,
        scope_not_clear: scopeNotClear,
        older_than_days: older ? Number(days) : null,
        refresh_open_minutes: Number(openMinutes),
        refresh_catalog_minutes: Number(catalogMinutes),
        refresh_ongoing_minutes: Number(ongoingMinutes),
        max_agents: Number(maxAgents),
      };
      const result = await api<Rules & { removed: string[] }>("/api/issues/auto_remove", { method: "PUT", body: body });
      const count = result.removed.length;
      toast.success(count > 0 ? `Saved. Removed ${count} ${count === 1 ? "issue" : "issues"}.` : "Saved");
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  const heading = "px-2 pb-1 text-xs font-medium text-muted-foreground";
  const option = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent";
  // Digits only: anything else typed or pasted is dropped.
  const number = "h-7 w-20";

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Automation</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div>
              <div className={heading}>Remove automatically</div>
              <button type="button" className={option} onClick={() => setClaimed(!claimed)}>
                <SelectBox checked={claimed} />
                Claimed
              </button>
              <button type="button" className={option} onClick={() => setOutOfScope(!outOfScope)}>
                <SelectBox checked={outOfScope} />
                Out of scope
              </button>
              <button type="button" className={option} onClick={() => setScopeNotClear(!scopeNotClear)}>
                <SelectBox checked={scopeNotClear} />
                Scope not clear
              </button>
            </div>

            <div>
              <div className={heading}>Complexity</div>
              <div className="flex gap-1">
                {Object.keys(LEVELS).map((level) => (
                  <button
                    key={level}
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                    onClick={() => toggleLevel(level)}
                  >
                    <SelectBox checked={levels.includes(level)} />
                    {LEVELS[level]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 px-2">
              <button type="button" className="flex items-center gap-2" onClick={() => setOlder(!older)}>
                <SelectBox checked={older} />
                Opened more than
              </button>
              <Input className={number} inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value.replace(/\D/g, ""))} />
              days ago
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className={heading}>Refresh every (minutes)</div>
            <label className="flex items-center justify-between gap-2 px-2">
              Open
              <Input className={number} inputMode="numeric" value={openMinutes} onChange={(event) => setOpenMinutes(event.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="flex items-center justify-between gap-2 px-2">
              Catalog
              <Input
                className={number}
                inputMode="numeric"
                value={catalogMinutes}
                onChange={(event) => setCatalogMinutes(event.target.value.replace(/\D/g, ""))}
              />
            </label>
            <label className="flex items-center justify-between gap-2 px-2">
              In progress, Review and Open PR
              <Input
                className={number}
                inputMode="numeric"
                value={ongoingMinutes}
                onChange={(event) => setOngoingMinutes(event.target.value.replace(/\D/g, ""))}
              />
            </label>
            <label className="mt-2 flex items-center justify-between gap-2 px-2">
              Max agents
              <Input className={number} inputMode="numeric" value={maxAgents} onChange={(event) => setMaxAgents(event.target.value.replace(/\D/g, ""))} />
            </label>
          </div>
        </div>

        {error !== "" && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!loaded || busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
