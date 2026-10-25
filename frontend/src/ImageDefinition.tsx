/*
An image's image.yaml: the one place it is defined (sandbox/images.py): the system, the desktop, package lists and
steps. The app builds the image from it, mechanically, from official sources (Rebuild, no agent); what the app needs
in every image comes from its own base layer, never from here. The agent writes it; you can read and change it here
too, and a change that isn't right is refused with the reason. "With defaults" shows what a build makes of it, with
the defaults (the VMs page's Defaults tab) under it. Nothing changes in the image until it is rebuilt, so when
image.yaml differs from what the image was built from, an amber dot shows, its changes can be shown, and the top
offers Discard (back to what it was built from) and Rebuild. When only the defaults changed since, the dot and
Rebuild show too.

Shown in the Definition tab of an image's Details (editable), and next to the log of a build (follow: read-only,
fetched again every 2 s as the agent writes). Comes from GET /api/images/<name>/definition, again whenever
updatedAt (the live feed's definition_updated_at) moves. Saving is PUT /api/images/<name>/definition.
*/

import { Hammer, Loader2, Pencil, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { api, type ImageDefinition as Definition } from "@/live";
import { cn } from "@/lib/utils";

export default function ImageDefinition(props: { name: string; updatedAt: number; editable: boolean; follow: boolean; onRebuild?: () => void }) {
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [error, setError] = useState("");
  // What the box shows: image.yaml, its changes since the build, or what a build makes of it with the defaults.
  const [view, setView] = useState<"definition" | "diff" | "combined">("definition");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Bumped after a save or discard, so image.yaml is fetched again.
  const [reload, setReload] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // image.yaml: now, when it changed, and every 2 s while following a build.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const answer = await api<Definition>(`/api/images/${encodeURIComponent(props.name)}/definition`);
        if (!stopped) {
          setDefinition(answer);
          setError("");
        }
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (props.follow && !stopped) {
        timer = window.setTimeout(load, 2000);
      }
    }
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [props.name, props.updatedAt, props.follow, reload]);

  const text = definition === null ? "" : definition.definition;
  const diff = definition === null ? "" : definition.diff;
  const defaultsChanged = definition !== null && definition.defaults_changed;
  const combined = definition === null ? "" : definition.combined;
  // Changes or the combined view that went away (saved, or image.yaml isn't right now) show image.yaml.
  let shown = view;
  if ((view === "diff" && diff === "") || (view === "combined" && combined === "")) {
    shown = "definition";
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/api/images/${encodeURIComponent(props.name)}/definition`, { method: "PUT", body: { text: draft } });
      setEditing(false);
      setReload(reload + 1);
    } catch (err) {
      toast.error(`Could not save image.yaml: ${err instanceof Error ? err.message : err}`);
    }
    setSaving(false);
  }

  async function discard() {
    try {
      await api(`/api/images/${encodeURIComponent(props.name)}/definition/discard`, { method: "POST" });
      setView("definition");
      setReload(reload + 1);
      toast.success(`${props.name}'s image.yaml is back to what it was built from.`);
    } catch (err) {
      toast.error(`Could not discard the changes: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-9 items-center gap-2 border px-2.5 py-1">
        {(diff !== "" || defaultsChanged) && <StatusDot tone="amber" />}
        <span className={cn("min-w-0 flex-1", diff === "" && !defaultsChanged && "text-muted-foreground")}>
          {diff !== "" && "image.yaml changed since this build. The image has none of it until you rebuild."}
          {diff === "" && defaultsChanged && "The defaults changed since this build. The image has none of it until you rebuild."}
          {diff === "" && !defaultsChanged && props.follow && "What defines the image, as its agent writes it, with the defaults under it."}
          {diff === "" && !defaultsChanged && !props.follow && "What defines this image, with the defaults under it. A Rebuild only runs what changed."}
        </span>
        {!editing && (
          <Button size="xs" variant={shown === "definition" ? "secondary" : "ghost"} onClick={() => setView("definition")}>
            image.yaml
          </Button>
        )}
        {!editing && diff !== "" && (
          <Button size="xs" variant={shown === "diff" ? "secondary" : "ghost"} onClick={() => setView("diff")}>
            Changes
          </Button>
        )}
        {!editing && combined !== "" && (
          <Button size="xs" variant={shown === "combined" ? "secondary" : "ghost"} onClick={() => setView("combined")}>
            With defaults
          </Button>
        )}
        {diff !== "" && props.onRebuild !== undefined && (
          <Button size="xs" variant="ghost" onClick={() => setConfirmDiscard(true)}>
            <Undo2 /> Discard
          </Button>
        )}
        {(diff !== "" || defaultsChanged) && props.onRebuild !== undefined && (
          <Button size="xs" variant="outline" onClick={props.onRebuild}>
            <Hammer /> Rebuild
          </Button>
        )}
        {props.editable && !editing && definition !== null && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setDraft(text);
              setEditing(true);
              setView("definition");
            }}
          >
            <Pencil /> Edit
          </Button>
        )}
      </div>

      {definition === null && error === "" && (
        <div className="flex h-96 items-center justify-center gap-2 border text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      )}

      {definition !== null && editing && (
        <>
          <Textarea className="h-96 resize-none font-mono text-xs" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={saving || draft === text} onClick={save}>
              {saving && <Loader2 className="animate-spin" />} Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">A saved image.yaml changes the image at its next Rebuild.</span>
          </div>
        </>
      )}

      {definition !== null && !editing && (
        <pre className="h-96 overflow-auto border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
          {shown === "definition" && (text || "Not written yet.")}
          {shown === "combined" && combined}
          {shown === "diff" &&
            diff.split("\n").map((line, index) => (
              <div
                key={index}
                className={cn(
                  line.startsWith("+") && !line.startsWith("+++") && "text-ok",
                  line.startsWith("-") && !line.startsWith("---") && "text-destructive",
                  (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) && "text-muted-foreground",
                )}
              >
                {line || " "}
              </div>
            ))}
        </pre>
      )}

      {error !== "" && <p className="text-destructive">{error}</p>}

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard the changes to {props.name}'s image.yaml?</AlertDialogTitle>
            <AlertDialogDescription>It goes back to what the image was built from.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
