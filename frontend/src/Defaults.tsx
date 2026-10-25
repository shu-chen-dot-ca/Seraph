/*
The Defaults tab of the VMs page: the defaults, the YAML every new image's image.yaml starts as, with the system
and desktop picked in New image. They are the user's, built here: the app has none of its own (empty until written). The image's agent adds and takes out from there; images already made keep their
own image.yaml, so a change here only reaches images made after it.

The same keys as image.yaml, without system and desktop: packages (one list, or split into apt: and dnf: where the
names differ), python, node, docker and steps. The defaults are built mechanically, so they are checked mechanically:
Check (while editing) runs the same check as Save without saving: the YAML's keys and values, and every step's bash
(bash -n: read, never run). It lists what is wrong, or says there are no problems; a change that doesn't pass isn't
saved. Its answer shows in the row of the buttons, where the hint is otherwise. Sherpa presses Check after it fills
the YAML in, and fixes what it reports.

Comes from GET /api/image-defaults; Save is PUT /api/image-defaults.
*/

import { ListChecks, Loader2, Pencil } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type ImageCheck, type ImageDefaults } from "@/live";

// tabs: the VMs page's tabs, which share the header row.
export default function Defaults(props: { tabs: ReactNode }) {
  const [defaults, setDefaults] = useState<ImageDefaults | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The last Check: what was checked and what is wrong with it. Shown while the draft is still that text.
  const [checked, setChecked] = useState<{ text: string; problems: string[] } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api<ImageDefaults>("/api/image-defaults")
      .then(setDefaults)
      .catch((err) => setError(`Could not load the defaults: ${err instanceof Error ? err.message : err}`));
  }, []);

  async function save() {
    if (defaults === null) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/api/image-defaults", { method: "PUT", body: { text: draft } });
      setDefaults({ ...defaults, defaults: draft });
      setEditing(false);
      toast.success("Saved. New images start from these.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  // A Check answer counts while the draft is still what was checked.
  const fresh = checked !== null && checked.text === draft;

  async function check() {
    const text = draft;
    setChecking(true);
    try {
      const answer = await api<ImageCheck>("/api/image-check", { method: "POST", body: { text: text, defaults: true } });
      setChecked({ text: text, problems: answer.problems });
    } catch (err) {
      toast.error(`Could not check it: ${err instanceof Error ? err.message : err}`);
    }
    setChecking(false);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {props.tabs}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Every new image's image.yaml starts as this. The desktop, Firefox and what the app needs are always in.
        </span>
        {defaults !== null && !editing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(defaults.defaults);
              setEditing(true);
              setError("");
            }}
          >
            <Pencil /> Edit
          </Button>
        )}
      </div>

      {defaults === null && error === "" && (
        <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      )}

      {defaults !== null && (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
          The keys of image.yaml without system and desktop: packages (one list, or apt: and dnf: lists where the names differ),
          python, node, docker and steps. Explain a step in its description field, not in # comments.
        </p>
      )}

      {defaults !== null && !editing && (
        <pre className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{defaults.defaults || "No defaults yet: new images start with only their system and desktop. Edit to write them."}</pre>
      )}

      {defaults !== null && editing && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <Textarea
            className="min-h-0 flex-1 resize-none font-mono text-xs"
            spellCheck={false}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={saving || draft === defaults.defaults} onClick={save}>
              {saving && <Loader2 className="animate-spin" />} Save
            </Button>
            <Button size="sm" variant="outline" disabled={checking} onClick={check}>
              {checking ? <Loader2 className="animate-spin" /> : <ListChecks />} Check
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {!fresh && <span className="text-xs text-muted-foreground">Only new images start from a change; images already made keep theirs.</span>}
            {fresh && checked.problems.length === 0 && (
              <span className="text-xs text-ok">No problems: the keys and values are right, and every step's bash parses.</span>
            )}
            {fresh && checked.problems.length > 0 && (
              <span className="min-w-0 flex-1 text-xs whitespace-pre-wrap text-destructive">{checked.problems.join("\n")}</span>
            )}
          </div>
        </div>
      )}

      {error !== "" && <p className="shrink-0 border-t px-3 py-2 whitespace-pre-wrap text-destructive">{error}</p>}
    </div>
  );
}
