/*
New image: the image's agent makes it (sandbox/image_agent.py). It writes the image's image.yaml: the system, the
desktop (GNOME by default, KDE Plasma, or none: terminal only; Firefox and what the app needs come with every
desktop), whether the defaults (the VMs page's Defaults tab) go under it, and what the comments ask for beyond
them, and builds it from official sources. What you pick here goes to the agent (its chat starts with it); the
image itself is only image.yaml, with the defaults under it.

The name starts as the system and the first free number (ubuntu-1), like vm1 and agent-1, until you type one.
The choices come from GET /api/images/new/options. POST /api/images/new starts the agent, which shows as a task
above the image list.
*/

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type NewImageOptions } from "@/live";

export default function NewImageDialog(props: { onClose: () => void }) {
  const data = useLive("images");
  const [options, setOptions] = useState<NewImageOptions | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [system, setSystem] = useState("");
  const [desktop, setDesktop] = useState("");
  const [useDefaults, setUseDefaults] = useState(true);
  const [comments, setComments] = useState("");
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

  // The first free <system>-<n> (ubuntu-1), counting images and the ones being made.
  const base = system.split("-")[0];
  const taken = [...data.images.flatMap((image) => image.aliases), ...data.tasks.map((task) => task.name)];
  let number = 1;
  while (taken.includes(`${base}-${number}`)) {
    number += 1;
  }
  const shownName = nameTouched ? name : `${base}-${number}`;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api("/api/images/new", {
        method: "POST",
        body: { name: shownName.trim(), system: system, desktop: desktop, defaults: useDefaults, comments: comments },
      });
      toast.success(`The agent is making ${shownName.trim()}. Follow it above the image list.`);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
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
            An agent writes image.yaml, what defines the image, from what you pick here, and builds it from official sources. It
            picks sensible defaults for the rest. Rebuild later builds the same image.yaml.
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
                : "With Firefox. Agents use the mouse and keyboard through X11; if this desktop has no X11 session on that system, the agent picks the other one and says so."}
            </p>

            <label htmlFor="new-image-defaults" className="text-muted-foreground">
              Defaults
            </label>
            <div className="flex h-5 items-center gap-2">
              <Switch id="new-image-defaults" checked={useDefaults} onCheckedChange={setUseDefaults} />
              <span className="text-xs text-muted-foreground">
                {useDefaults ? "Everything in the Defaults tab, under this image's own image.yaml." : "Left out: only what the comments ask for."}
              </span>
            </div>

            <label className="self-start pt-1 text-muted-foreground">Comments</label>
            <Textarea
              rows={2}
              placeholder="Optional, what it needs beyond the defaults, e.g. Rust and Go, Postgres 16 and Redis"
              value={comments}
              onChange={(event) => setComments(event.target.value)}
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
          <Button onClick={submit} disabled={busy || options === null || shownName.trim() === ""}>
            {busy && <Loader2 className="animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
