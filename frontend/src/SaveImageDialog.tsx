/*
Save a VM as an image: everything on its disk (installed tools, clones, settings) becomes an image new VMs
can start from. Opened from the Images tab (pick the VM) and from a VM's Settings (that VM).

Only a stopped VM can be saved, and not while its files still hold env variable values (they would go into
every VM made from the image); the dialog says so and the backend refuses too. POST /api/images/save answers
at once; the save shows as a task in the Images tab until the image is listed (a few minutes).
*/

import { Loader2, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { api, useLive } from "@/live";

export default function SaveImageDialog(props: { vm: string | null; onClose: () => void }) {
  const vms = useLive("vms");
  const imagesData = useLive("images");
  const firstVM = props.vm ?? vms.find((each) => each.status === "stopped")?.name ?? vms[0]?.name ?? "";
  const [vmName, setVMName] = useState(firstVM);
  const [name, setName] = useState(firstVM === "" ? "" : `${firstVM}-image`);
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const vm = vms.find((each) => each.name === vmName);
  const stopped = vm !== undefined && vm.status === "stopped";
  const hasSecrets = vm !== undefined && vm.secrets_in_vm.length > 0;
  const nameTaken = imagesData.images.some((image) => image.aliases.includes(name.trim()));

  function pickVM(value: string) {
    setVMName(value);
    if (!nameTouched) {
      setName(`${value}-image`);
    }
  }

  async function stopVM() {
    setBusy("stop");
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/stop`, { method: "POST" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function submit() {
    setBusy("save");
    setError("");
    try {
      await api("/api/images/save", { method: "POST", body: { vm: vmName, name: name.trim() } });
      toast.success(`Saving ${vmName} as ${name.trim()}. It takes a few minutes.`);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy("");
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save a VM as an image</DialogTitle>
          <DialogDescription>New VMs made from it start with everything on this VM's disk.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground">VM</label>
          <Select value={vmName} onValueChange={pickVM} disabled={props.vm !== null}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No VMs" />
            </SelectTrigger>
            <SelectContent position="popper">
              {vms.map((each) => (
                <SelectItem key={each.name} value={each.name}>
                  <StatusDot tone={VM_TONE[each.status]} />
                  {each.name}
                  <span className="text-muted-foreground">{each.status}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {vm !== undefined && !stopped && (
            <div className="col-start-2 flex items-center gap-2 text-xs text-muted-foreground">
              Only a stopped VM can be saved.
              {vm.status === "running" && (
                <Button size="xs" variant="outline" disabled={busy !== ""} onClick={stopVM}>
                  {busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />} Stop {vm.name}
                </Button>
              )}
              {vm.status === "stopping" && <Loader2 className="size-3 animate-spin" />}
            </div>
          )}
          {hasSecrets && (
            <p className="col-start-2 text-xs text-destructive">
              Its files still hold values for {vm.secrets_in_vm.join(", ")}. They would go into every VM made from the image: remove them in
              its Settings while it runs, then stop it.
            </p>
          )}

          <label className="text-muted-foreground">Image name</label>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
            }}
          />
          {nameTaken && <p className="col-start-2 text-xs text-destructive">There is already an image with that name.</p>}
        </div>

        <p className="text-xs text-muted-foreground">
          Everything on the disk comes along, including logins saved in the VM (git credentials, browser sessions). The VM can't start
          until the image is made.
        </p>

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy !== "" || !stopped || hasSecrets || nameTaken || name.trim() === ""}>
            {busy === "save" && <Loader2 className="animate-spin" />} Save as image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
