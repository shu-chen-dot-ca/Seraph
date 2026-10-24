/*
Edit Explore's profile: "About you", and the user's types of repo, one tab each (+ adds one, up to MAX_TYPES).
A type is a name and a few words on what it is, like Prestige or AI & harness. The types are the tags that
classify repos: Explore puts each repo it finds under one, and agents give one to the repos they add.
On Save, Claude plans each type's seed repos and GitHub searches (github_searcher/explore.py set_profile),
and the finds are split evenly between the types. A run in progress keeps the profile it started with.
*/

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, type ExploreProfile } from "@/live";

// Same as the backend's MAX_TYPES.
const MAX_TYPES = 6;

export default function ExploreProfileDialog(props: { profile: ExploreProfile; onClose: () => void }) {
  const [about, setAbout] = useState(props.profile.about);
  const [types, setTypes] = useState(props.profile.lanes.map((lane) => ({ label: lane.label, about: lane.about })));
  // The open tab: an index into types.
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const current = types[shown];
  const complete = about.trim() !== "" && types.length > 0 && types.every((each) => each.label.trim() !== "" && each.about.trim() !== "");

  function editType(field: "label" | "about", value: string) {
    setTypes(types.map((each, index) => (index === shown ? { ...each, [field]: value } : each)));
  }

  function addType() {
    setTypes([...types, { label: "", about: "" }]);
    setShown(types.length);
  }

  function removeType() {
    setTypes(types.filter((_, index) => index !== shown));
    setShown(Math.max(0, shown - 1));
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/explore/profile", { method: "PUT", body: { about: about, types: types } });
      toast.success("Profile saved. The next run uses it.");
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Explore profile</DialogTitle>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="explore-about" className="font-medium">
            About you
          </label>
          <Textarea id="explore-about" rows={4} value={about} disabled={busy} onChange={(event) => setAbout(event.target.value)} />
        </div>

        <div className="space-y-2">
          <div className="font-medium">Types of repo</div>
          <div className="flex items-center gap-1">
            <Tabs value={String(shown)} onValueChange={(value) => setShown(Number(value))}>
              <TabsList>
                {types.map((each, index) => (
                  <TabsTrigger key={index} value={String(index)} className="px-2.5">
                    {each.label.trim() || "New type"}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button variant="ghost" size="icon-sm" aria-label="Add a type" title="Add a type" disabled={busy || types.length >= MAX_TYPES} onClick={addType}>
              <Plus />
            </Button>
          </div>
          {current !== undefined && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input placeholder="Name" aria-label="Name" value={current.label} disabled={busy} onChange={(event) => editType("label", event.target.value)} />
                <Button variant="ghost" size="sm" disabled={busy || types.length === 1} onClick={removeType}>
                  <Trash2 /> Remove
                </Button>
              </div>
              <Textarea rows={4} aria-label="What it is" value={current.about} disabled={busy} onChange={(event) => editType("about", event.target.value)} />
            </div>
          )}
        </div>

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !complete}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Planning the searches…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
