/*
The Settings tab of a VM page: its name, CPU and memory, internet, autostart, env vars, its image, and Delete.

Most of it reads the live "vms" topic, so a change shows up as soon as the backend has made it.
The env values are the one thing the live feed leaves out (it only carries the names, so agents and
other views never see secrets): they come from GET /api/vms/{name}/settings, fetched again whenever
the names change (an agent can add or remove empty ones) unless you have unsaved edits.

CPU and memory only change while the VM is stopped; Incus applies them on the next start.
Rename works running or not; the page moves to the new name (#/vms/<new name>).
*/

import { Eye, EyeOff, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import SaveImageDialog from "@/SaveImageDialog";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, useLive, type VMOptions, type VMSettings as Settings } from "@/live";

type EnvRow = { name: string; value: string; shown: boolean };

export default function VMSettings(props: { name: string }) {
  const vms = useLive("vms");
  const vm = vms.find((each) => each.name === props.name);
  const [options, setOptions] = useState<VMOptions | null>(null);
  // "" = not touched, so the select follows the live value.
  const [cpus, setCpus] = useState("");
  const [memory, setMemory] = useState("");
  const [newName, setNewName] = useState(props.name);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);
  const [envEdited, setEnvEdited] = useState(false);
  // Which change is on its way: "rename", "resources", "internet", "autostart", "env" or "delete".
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savingImage, setSavingImage] = useState(false);
  const imagesData = useLive("images");

  const vmName = props.name;
  const envNames = vm === undefined ? "" : vm.env_names.join("\n");

  useEffect(() => {
    api<VMOptions>("/api/vms/options")
      .then(setOptions)
      .catch((err) => setError(`Could not load the CPU and memory choices: ${err instanceof Error ? err.message : err}`));
  }, []);

  // The env values: on open, after a save, and when the names change (unless you are editing them).
  useEffect(() => {
    if (envEdited) {
      return;
    }
    let stopped = false;
    api<Settings>(`/api/vms/${encodeURIComponent(vmName)}/settings`)
      .then((settings) => {
        if (stopped) {
          return;
        }
        setRows(Object.entries(settings.env).map(([name, value]) => ({ name: name, value: value, shown: false })));
        setEnvLoaded(true);
      })
      .catch((err) => {
        if (!stopped) {
          setError(`Could not load the env vars: ${err instanceof Error ? err.message : err}`);
        }
      });
    return () => {
      stopped = true;
    };
  }, [vmName, envNames, envEdited]);

  if (vm === undefined) {
    return <div className="p-3 text-muted-foreground">No VM named {props.name}.</div>;
  }

  const stopped = vm.status === "stopped";
  const shownCpus = cpus === "" ? String(vm.cpus) : cpus;
  const shownMemory = memory === "" ? String(vm.memory_gb) : memory;
  const resourcesChanged = shownCpus !== String(vm.cpus) || shownMemory !== String(vm.memory_gb);
  const cpuChoices = options === null ? [vm.cpus] : options.cpus;
  const memoryChoices = options === null ? [vm.memory_gb] : options.memory_gb;

  // Each change below: the live feed shows the result, so only errors need handling here.
  async function rename() {
    setBusy("rename");
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/rename`, { method: "POST", body: { name: newName.trim() } });
      toast.success(`Renamed ${vmName} to ${newName.trim()}`);
      window.location.hash = `#/vms/${encodeURIComponent(newName.trim())}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function applyResources() {
    setBusy("resources");
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/resources`, {
        method: "PUT",
        body: { cpus: Number(shownCpus), memory_gb: Number(shownMemory) },
      });
      setCpus("");
      setMemory("");
      toast.success(`${vmName} gets ${shownCpus} CPUs and ${shownMemory} GB on its next start.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function setInternet(enabled: boolean) {
    setBusy("internet");
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/internet`, { method: "PUT", body: { enabled: enabled } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function setAutostart(enabled: boolean) {
    setBusy("autostart");
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/autostart`, { method: "PUT", body: { enabled: enabled } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function saveEnv() {
    const env: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (name === "") {
        continue;
      }
      env[name] = row.value;
    }
    setBusy("env");
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}/env`, { method: "PUT", body: { env: env } });
      setEnvEdited(false);
      toast.success("Env vars saved. New shells in the VM see them.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  async function deleteVM() {
    setBusy("delete");
    try {
      await api(`/api/vms/${encodeURIComponent(vmName)}`, { method: "DELETE" });
      toast.success(`Deleted ${vmName}`);
      window.location.hash = "#/vms";
    } catch (err) {
      toast.error(`Could not delete ${vmName}: ${err instanceof Error ? err.message : err}`);
      setBusy("");
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-2xl space-y-5 p-4">
        {error !== "" && <p className="border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{error}</p>}

        <section>
          <h2 className="mb-1.5 border-b pb-1 font-semibold">Name</h2>
          <div className="flex items-center gap-2">
            <Input
              className="w-56"
              spellCheck={false}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newName.trim() !== "" && newName.trim() !== vmName && busy === "") {
                  rename();
                }
              }}
            />
            <Button size="sm" onClick={rename} disabled={newName.trim() === "" || newName.trim() === vmName || busy !== ""}>
              {busy === "rename" && <Loader2 className="animate-spin" />}
              Rename
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Works while it runs. Agents aimed at it and its jobs follow the new name. a-z, 0-9 and -, starting with a letter.
          </p>
        </section>

        <section>
          <h2 className="mb-1.5 border-b pb-1 font-semibold">Resources</h2>
          <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
            <label className="text-muted-foreground">CPUs</label>
            <Select value={shownCpus} onValueChange={setCpus} disabled={!stopped}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {cpuChoices.map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count} {count === 1 ? "CPU" : "CPUs"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="text-muted-foreground">Memory</label>
            <Select value={shownMemory} onValueChange={setMemory} disabled={!stopped}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {memoryChoices.map((gb) => (
                  <SelectItem key={gb} value={String(gb)}>
                    {gb} GB
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="text-muted-foreground">Disk</label>
            <span className="tabular-nums">{vm.disk_gb} GB</span>

            <span />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={applyResources} disabled={!stopped || !resourcesChanged || busy !== ""}>
                {busy === "resources" && <Loader2 className="animate-spin" />}
                Apply
              </Button>
              {!stopped && <span className="text-muted-foreground">Stop the VM to change CPU and memory.</span>}
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-1.5 border-b pb-1 font-semibold">Network and start</h2>
          <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
            <label htmlFor={`internet-${vmName}`} className="pt-0.5 text-muted-foreground">
              Internet
            </label>
            <div>
              <div className="flex h-5 items-center gap-2">
                <Switch
                  id={`internet-${vmName}`}
                  checked={vm.internet}
                  disabled={busy !== ""}
                  onCheckedChange={setInternet}
                />
                {busy === "internet" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Off blocks everything the VM starts itself. The desktop keeps working. This computer and your local network are never
                reachable from the VM.
              </p>
            </div>

            <label htmlFor={`autostart-${vmName}`} className="pt-0.5 text-muted-foreground">
              Autostart
            </label>
            <div>
              <div className="flex h-5 items-center gap-2">
                <Switch
                  id={`autostart-${vmName}`}
                  checked={vm.autostart}
                  disabled={busy !== ""}
                  onCheckedChange={setAutostart}
                />
                {busy === "autostart" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Start this VM when the computer starts.</p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-1.5 border-b pb-1 font-semibold">Env vars</h2>
          {!envLoaded && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          )}
          {envLoaded && rows.length === 0 && <p className="text-muted-foreground">No env vars.</p>}
          {envLoaded && (
            <div className="space-y-1">
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    className="w-56 font-mono text-xs"
                    placeholder="NAME"
                    spellCheck={false}
                    value={row.name}
                    onChange={(event) => {
                      setEnvEdited(true);
                      setRows(rows.map((other, i) => (i === index ? { ...other, name: event.target.value } : other)));
                    }}
                  />
                  <Input
                    className="min-w-0 flex-1 font-mono text-xs"
                    placeholder={row.value === "" ? "empty: an agent asked for it, fill it in" : "value"}
                    type={row.shown ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={row.value}
                    onChange={(event) => {
                      setEnvEdited(true);
                      setRows(rows.map((other, i) => (i === index ? { ...other, value: event.target.value } : other)));
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={row.shown ? "Hide the value" : "Show the value"}
                    title={row.shown ? "Hide the value" : "Show the value"}
                    onClick={() => setRows(rows.map((other, i) => (i === index ? { ...other, shown: !other.shown } : other)))}
                  >
                    {row.shown ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${row.name || "this variable"}`}
                    title="Remove"
                    onClick={() => {
                      setEnvEdited(true);
                      setRows(rows.filter((_, i) => i !== index));
                    }}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEnvEdited(true);
                    setRows([...rows, { name: "", value: "", shown: true }]);
                  }}
                >
                  <Plus /> Add
                </Button>
                <Button size="sm" onClick={saveEnv} disabled={!envEdited || busy !== ""}>
                  {busy === "env" && <Loader2 className="animate-spin" />}
                  Save
                </Button>
                {envEdited && (
                  <Button variant="ghost" size="sm" onClick={() => setEnvEdited(false)}>
                    Discard changes
                  </Button>
                )}
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            For secrets, in every shell in the VM (shells opened after saving). Agents see each name and whether it has a value, never the
            value: command output shows [hidden] instead. They can add empty ones for you to fill in.
          </p>
        </section>

        <section>
          <h2 className="mb-1.5 border-b pb-1 font-semibold">Image</h2>
          <div className="flex items-center gap-3">
            <span>
              Made from{" "}
              <a href="#/vms?tab=images" className="font-medium text-primary hover:underline">
                {imagesData.images.find((image) => image.fingerprint === vm.image_fingerprint)?.name ?? (vm.image || "an image that is gone now")}
              </a>
            </span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSavingImage(true)}>
              <Save /> Save as image
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Save as image makes a new image from this VM's disk as it is, for new VMs to start from. The VM must be stopped.</p>
        </section>

        <section>
          <h2 className="mb-1.5 border-b pb-1 font-semibold">Delete</h2>
          <div className="flex items-center gap-3">
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} disabled={busy !== ""}>
              {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete {vmName}
            </Button>
            <span className="text-muted-foreground">The VM and everything in it are removed. Agents waiting for it are taken out of its queue.</span>
          </div>
        </section>
      </div>

      {savingImage && <SaveImageDialog vm={vmName} onClose={() => setSavingImage(false)} />}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {vmName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The VM and everything inside it are removed for good. An agent holding it is interrupted, and agents aimed at it lose their
              target VM.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteVM}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
