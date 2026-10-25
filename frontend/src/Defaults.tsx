/*
The Defaults tab of the VMs page: the defaults, a YAML file that goes under every image's own image.yaml, unless
that says defaults: false (sandbox/image_build.py combines them).

The same keys as image.yaml, without system and desktop: packages (one list, or split into apt: and dnf: where the
names differ), python, node, docker and steps. Lists get the defaults' items first, then the image's; default steps
run first, and an image step with a default step's name takes its place. A change is checked before it is saved
(a wrong one is refused with the reason), and images get it at their next Rebuild: until then they show a dot.

Comes from GET /api/image-defaults (with the app's own first defaults, to go back to); Save is PUT /api/image-defaults.
*/

import { Loader2, Pencil, Undo2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type ImageDefaults } from "@/live";

// tabs: the VMs page's tabs, which share the header row.
export default function Defaults(props: { tabs: ReactNode }) {
  const [defaults, setDefaults] = useState<ImageDefaults | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
      toast.success("Saved. Images get the new defaults at their next Rebuild.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {props.tabs}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Under every image's image.yaml, unless it says defaults: false. The desktop, Firefox and what the app needs are always in.
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

      {defaults !== null && !editing && (
        <pre className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{defaults.defaults || "No defaults."}</pre>
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
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="ghost" disabled={draft === defaults.original} onClick={() => setDraft(defaults.original)}>
              <Undo2 /> The app's own defaults
            </Button>
            <span className="text-xs text-muted-foreground">Images get a change at their next Rebuild.</span>
          </div>
        </div>
      )}

      {error !== "" && <p className="shrink-0 border-t px-3 py-2 text-destructive">{error}</p>}
    </div>
  );
}
