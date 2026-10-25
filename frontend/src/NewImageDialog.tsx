/*
New image: saves a new image's image.yaml, nothing more. It is the defaults (the VMs page's Defaults tab) with the
system and desktop picked here (GNOME by default, KDE Plasma, or none: terminal only; Firefox and what the app needs
come with every desktop), and the description, if one is written here, as its description field. No agent runs:
Sherpa helps fill this in and change image.yaml afterwards.

Save only saves it: the image is listed as "not built", with Build and Edit image.yaml, until its first build. Save
and build also starts that build (minutes).

The name starts as the system and the first free number (ubuntu-1), like vm1 and agent-1, until you type one. It may
have capitals (Ubuntu-Web); two names that differ only in capitals count as the same.
The choices come from GET /api/images/new/options. Saving is POST /api/images/new, building POST
/api/images/<name>/rebuild.
*/

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type NewImageOptions } from "@/live";

export default function NewImageDialog(props: { onClose: () => void }) {
  const data = useLive("images");
  const [options, setOptions] = useState<NewImageOptions | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [system, setSystem] = useState("");
  const [desktop, setDesktop] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<NewImageOptions>("/api/images/new/options")
      .then((answer) => {
        setOptions(answer);
        setSystem(answer.system);
        setDesktop(answer.desktops[0]);
      })
      .catch((err) => setError(`Could not load the choices: ${err instanceof Error ? err.message : err}`));
  }, []);

  const terminalOnly = options !== null && desktop === options.desktops[options.desktops.length - 1];

  // The first free <system>-<n> (ubuntu-1), counting images, the ones never built and the ones being made.
  const base = system.split("-")[0];
  // Names are the same whatever their capitals (Ubuntu-1 is ubuntu-1).
  const taken = [...data.images.flatMap((image) => image.aliases), ...data.unbuilt.map((image) => image.name), ...data.tasks.map((task) => task.name)].map(
    (each) => each.toLowerCase(),
  );
  let number = 1;
  while (taken.includes(`${base}-${number}`)) {
    number += 1;
  }
  const shownName = nameTouched ? name : `${base}-${number}`;

  // build: also start its first build once it is saved.
  async function submit(build: boolean) {
    const imageName = shownName.trim();
    setBusy(true);
    setError("");
    try {
      await api("/api/images/new", {
        method: "POST",
        body: { name: imageName, system: system, desktop: desktop, description: description },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    if (!build) {
      toast.success(`Saved ${imageName}. Change its image.yaml from its row, or Build it when it is ready.`);
      props.onClose();
      return;
    }
    try {
      await api(`/api/images/${encodeURIComponent(imageName)}/rebuild`, { method: "POST" });
      toast.success(`Saved ${imageName} and building it. Follow it above the image list.`);
    } catch (err) {
      toast.error(`Saved ${imageName}, but could not build it: ${err instanceof Error ? err.message : err}`);
    }
    props.onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New image</DialogTitle>
          <DialogDescription>
            Saves an image.yaml: the defaults (the Defaults tab) on this system and desktop. Change it from the image's row (Sherpa
            can help), then build it from official sources.
          </DialogDescription>
        </DialogHeader>

        {options === null && error === "" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}

        {options !== null && (
          <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <label className="text-muted-foreground">Name</label>
            <Input
              value={shownName}
              onChange={(event) => {
                setName(event.target.value);
                setNameTouched(true);
              }}
            />

            <label className="text-muted-foreground">System</label>
            <Select value={system} onValueChange={setSystem}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {options.systems.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {each.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="text-muted-foreground">Desktop</label>
            <Select value={desktop} onValueChange={setDesktop}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {options.desktops.map((each) => (
                  <SelectItem key={each} value={each}>
                    {each}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="col-start-2 text-xs text-muted-foreground">
              {terminalOnly
                ? "No desktop or browser: the VM page shows its terminal."
                : "With Firefox. Agents use the mouse and keyboard through X11, which GNOME no longer has on Fedora and Ubuntu 26.04: pick KDE Plasma there."}
            </p>

            <label className="self-start pt-1 text-muted-foreground">Description</label>
            <Textarea
              rows={2}
              placeholder="Optional, what it is for, e.g. Rust and Go for the backend repos"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />

            <p className="col-start-2 text-xs text-muted-foreground">
              {terminalOnly
                ? "Always in, since the app needs them: the terminal in the browser and the demo service."
                : "Always in, since the app needs them: the desktop and terminals in the browser, mouse and keyboard control for agents, and the demo service."}
            </p>
          </div>
        )}

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => submit(true)} disabled={busy || options === null || shownName.trim() === ""}>
            Save and build
          </Button>
          <Button onClick={() => submit(false)} disabled={busy || options === null || shownName.trim() === ""}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
