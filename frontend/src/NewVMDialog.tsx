/*
The New VM dialog: a name, the image it starts from, CPUs, memory, disk and desktops (1 by default). Each desktop has
its own screen, mouse, keyboard and home folder, so that many agents can work in the VM at the same time; each one
also takes some memory (about 1 GB with its browser).

The choices and defaults come from GET /api/vms/options (they live in .env), including the first free
name (vm1, vm2, ...). POST /api/vms answers at once with status "creating"; the VM shows up in the list
right away through the live feed, and becomes "running" after about a minute. A new VM is empty:
agents clone what they need. The image starts at the default one (set in the VMs page's Images tab).
onCreated, when given, hears the new VM's name (the phone's VM page takes its desktop 1 then).
*/

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, useLive, type VMOptions } from "@/live";

export default function NewVMDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: (name: string) => void }) {
  const [options, setOptions] = useState<VMOptions | null>(null);
  const [name, setName] = useState("");
  const imagesData = useLive("images");
  // "" = not picked, so it follows the default image.
  const [image, setImage] = useState("");
  const [cpus, setCpus] = useState("");
  const [memory, setMemory] = useState("");
  const [disk, setDisk] = useState("");
  const [desktops, setDesktops] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Every time the dialog opens: fresh defaults (the next free name changes as VMs are made).
  useEffect(() => {
    if (!props.open) {
      return;
    }
    let stopped = false;
    setOptions(null);
    setError("");
    setBusy(false);
    api<VMOptions>("/api/vms/options")
      .then((answer) => {
        if (stopped) {
          return;
        }
        setOptions(answer);
        setName(answer.next_name);
        setImage("");
        setCpus(String(answer.cpus_default));
        setMemory(String(answer.memory_gb_default));
        setDisk(String(answer.disk_gb_default));
        setDesktops("1");
      })
      .catch((err) => {
        if (!stopped) {
          setError(`Could not load the VM options: ${err instanceof Error ? err.message : err}`);
        }
      });
    return () => {
      stopped = true;
    };
  }, [props.open]);

  const diskNumber = Number(disk);
  const diskValid = options !== null && Number.isInteger(diskNumber) && diskNumber >= options.disk_gb_min && diskNumber <= options.disk_gb_max;
  const nameValid = /^[a-z][a-z0-9-]{0,30}$/.test(name);
  const shownImage = image === "" ? imagesData.default : image;
  const imageValid = imagesData.images.some((each) => each.name === shownImage);

  async function submit() {
    if (options === null || !nameValid || !diskValid || !imageValid || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/vms", {
        method: "POST",
        body: { name: name, image: shownImage, cpus: Number(cpus), memory_gb: Number(memory), disk_gb: diskNumber, desktops: Number(desktops) },
      });
      toast.success(`Creating ${name}. It takes about a minute.`);
      props.onOpenChange(false);
      if (props.onCreated !== undefined) {
        props.onCreated(name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New VM</DialogTitle>
          <DialogDescription>A desktop VM from an image. Agents clone what they need into it.</DialogDescription>
        </DialogHeader>

        {options === null && error === "" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}

        {options !== null && (
          <form
            className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 gap-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor="new-vm-name" className="text-muted-foreground">
              Name
            </label>
            <Input
              id="new-vm-name"
              value={name}
              spellCheck={false}
              autoFocus
              aria-invalid={!nameValid}
              onChange={(event) => setName(event.target.value.trim().toLowerCase())}
            />
            {!nameValid && (
              <p className="col-start-2 text-xs text-destructive">Lowercase letters, digits and dashes; starts with a letter.</p>
            )}

            <label className="text-muted-foreground">Image</label>
            <Select value={shownImage} onValueChange={setImage}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No images" />
              </SelectTrigger>
              <SelectContent position="popper">
                {imagesData.images.map((each) => (
                  <SelectItem key={each.fingerprint} value={each.name}>
                    {each.name}
                    <span className="text-muted-foreground">{each.default ? "default" : (each.inventory?.system.os ?? "")}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!imageValid && (
              <p className="col-start-2 text-xs text-destructive">No such image. Build one, or pick another, in the VMs page's Images tab.</p>
            )}

            <label className="text-muted-foreground">CPUs</label>
            <Select value={cpus} onValueChange={setCpus}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {options.cpus.map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count} {count === 1 ? "CPU" : "CPUs"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="text-muted-foreground">Memory</label>
            <Select value={memory} onValueChange={setMemory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {options.memory_gb.map((gb) => (
                  <SelectItem key={gb} value={String(gb)}>
                    {gb} GB
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label htmlFor="new-vm-disk" className="text-muted-foreground">
              Disk
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="new-vm-disk"
                type="number"
                className="w-28"
                min={options.disk_gb_min}
                max={options.disk_gb_max}
                value={disk}
                aria-invalid={!diskValid}
                onChange={(event) => setDisk(event.target.value)}
              />
              <span className="text-muted-foreground">
                GB ({options.disk_gb_min} to {options.disk_gb_max})
              </span>
            </div>

            <label className="text-muted-foreground">Desktops</label>
            <Select value={desktops} onValueChange={setDesktops}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {options.desktops.map((number) => (
                  <SelectItem key={number} value={String(number)}>
                    {number === 1 ? "1 desktop" : `${number} desktops (${number} agents at once)`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Lets Enter in a field submit the form. */}
            <button type="submit" className="hidden" />
          </form>
        )}

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={options === null || !nameValid || !diskValid || !imageValid || busy}>
            {busy && <Loader2 className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
