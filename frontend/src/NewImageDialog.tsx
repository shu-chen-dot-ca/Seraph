/*
New image: the image's agent makes it (sandbox/image_agent.py). It writes the image's image.yaml: the system, the
desktop (GNOME by default, KDE Plasma, or none: terminal only; Firefox and what the app needs come with every
desktop), the dependencies and what the comments ask for, and builds it from official sources. What you pick here
goes to the agent (its chat starts with it); the image itself is only image.yaml.

The dialog only says what the image should have; the agent picks sensible defaults for the rest. The name starts
as the system and the first free number (ubuntu-1), like vm1 and agent-1, until you type one. The dependencies
start as the list for every new image (GET /api/images/new/options); changed here, they are only for this image,
unless "Use for every new image" saves them (PUT /api/images/new/packages). POST /api/images/new writes the
image's description and starts the build, which shows as a task above the image list.
*/

import { Loader2, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
  const [packages, setPackages] = useState<string[]>([]);
  const [newItem, setNewItem] = useState("");
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<NewImageOptions>("/api/images/new/options")
      .then((answer) => {
        setOptions(answer);
        setSystem(answer.system);
        setDesktop(answer.desktops[0]);
        setPackages(answer.packages);
      })
      .catch((err) => setError(`Could not load the choices: ${err instanceof Error ? err.message : err}`));
  }, []);

  const listChanged = options !== null && packages.join("\n") !== options.packages.join("\n");
  const terminalOnly = options !== null && desktop === options.desktops[options.desktops.length - 1];

  // The first free <system>-<n> (ubuntu-1), counting images and the ones being made.
  const base = system.split("-")[0];
  const taken = [...data.images.flatMap((image) => image.aliases), ...data.tasks.map((task) => task.name)];
  let number = 1;
  while (taken.includes(`${base}-${number}`)) {
    number += 1;
  }
  const shownName = nameTouched ? name : `${base}-${number}`;

  function addItem() {
    const item = newItem.trim();
    if (item === "" || packages.includes(item)) {
      return;
    }
    setPackages([...packages, item]);
    setNewItem("");
  }

  async function saveList() {
    try {
      await api("/api/images/new/packages", { method: "PUT", body: { packages: packages } });
      if (options !== null) {
        setOptions({ ...options, packages: packages });
      }
      toast.success("New images get this list from now on.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api("/api/images/new", {
        method: "POST",
        body: { name: shownName.trim(), system: system, desktop: desktop, packages: packages, comments: comments },
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
                : "With Firefox. Agents use the mouse and keyboard through X11; if this desktop has no X11 session on that system, the agent uses the other one and says so."}
            </p>

            <label className="self-start pt-1 text-muted-foreground">Dependencies</label>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {packages.map((item) => (
                  <Badge key={item} variant="secondary" className="pr-1">
                    {item}
                    <button
                      type="button"
                      className="rounded-sm hover:text-foreground"
                      aria-label={`Take out ${item}`}
                      onClick={() => setPackages(packages.filter((other) => other !== item))}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                {packages.length === 0 && <span className="text-xs text-muted-foreground">Nothing beyond the system and desktop.</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-7 flex-1"
                  placeholder="Add, e.g. Rust, Go, Java 21"
                  value={newItem}
                  onChange={(event) => setNewItem(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addItem();
                    }
                  }}
                />
                <Button size="xs" variant="outline" disabled={newItem.trim() === ""} onClick={addItem}>
                  <Plus /> Add
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {listChanged ? "Only for this image." : "The list for every new image."}
                {listChanged && (
                  <Button size="xs" variant="ghost" onClick={saveList}>
                    Use for every new image
                  </Button>
                )}
              </div>
            </div>

            <label className="self-start pt-1 text-muted-foreground">Comments</label>
            <Textarea
              rows={2}
              placeholder="Optional, e.g. Postgres 16 and Redis running, a dark theme"
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
