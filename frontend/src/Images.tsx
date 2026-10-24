/*
The Images tab of the VMs page: the images new VMs start from.

One row per image (an Incus image with a name): its description, size, when it was made, and the VMs made
from that exact image. The default image is what New VM picks first. Each row's menu: make it the default,
edit its name and description, rebuild it, list what it has again, delete it (VMs made from it keep working:
each has its own disk). A row opens in place to show what the image has (ImageInventory); an image that wasn't
listed yet offers Inspect there (about two minutes, in a throwaway VM).

New images come from Build (sandbox/image/build.sh: a fresh Ubuntu desktop plus provision.sh, about an
hour) or Save a VM (that VM's disk as it is, a few minutes). Both run in the background as tasks, shown
above the list with their last log lines until the image is listed; the whole log opens in a dialog.
Everything comes from the live "images" topic.
*/

import { ChevronRight, Hammer, Loader2, MoreHorizontal, Pencil, Plus, Save, ScanSearch, ScrollText, Square, Star, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import ImageInventory from "@/ImageInventory";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api, useLive, useLoaded, type Image, type ImageTask } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[16px_minmax(0,220px)_minmax(0,1fr)_80px_150px_minmax(0,200px)_32px] items-center gap-3";

const TASK_TITLE: Record<string, string> = { build: "Building", save: "Saving", inspect: "Listing what it has:" };

export default function Images() {
  const data = useLive("images");
  const loaded = useLoaded("images");
  // Which dialog is open, and for which image or task.
  const [building, setBuilding] = useState<{ name: string; rebuild: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Image | null>(null);
  const [deleting, setDeleting] = useState<Image | null>(null);
  const [logOf, setLogOf] = useState<ImageTask | null>(null);
  // The fingerprints of the open rows.
  const [open, setOpen] = useState<string[]>([]);

  const buildRunning = data.tasks.some((task) => task.kind === "build" && task.status === "running");

  async function makeDefault(image: Image) {
    try {
      await api(`/api/images/${encodeURIComponent(image.name)}/default`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not make ${image.name} the default: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(image: Image) {
    try {
      await api(`/api/images/${encodeURIComponent(image.name)}`, { method: "DELETE" });
      toast.success(`Deleted ${image.name}`);
    } catch (err) {
      toast.error(`Could not delete ${image.name}: ${err instanceof Error ? err.message : err}`);
    }
    setDeleting(null);
  }

  function toggle(fingerprint: string) {
    if (open.includes(fingerprint)) {
      setOpen(open.filter((other) => other !== fingerprint));
      return;
    }
    setOpen([...open, fingerprint]);
  }

  async function inspect(image: Image) {
    try {
      await api(`/api/images/${encodeURIComponent(image.name)}/inspect`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not inspect ${image.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function stopTask(task: ImageTask) {
    try {
      await api(`/api/images/tasks/${task.id}/stop`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not stop it: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function dismiss(task: ImageTask) {
    try {
      await api(`/api/images/tasks/${task.id}`, { method: "DELETE" });
    } catch (err) {
      toast.error(`Could not dismiss it: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground">New VMs start from the default image.</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setSaving(true)}>
            <Save /> Save a VM as image
          </Button>
          <Button
            size="sm"
            disabled={buildRunning}
            title={buildRunning ? "One build runs at a time" : undefined}
            onClick={() => setBuilding({ name: "", rebuild: false })}
          >
            <Plus /> Build image
          </Button>
        </div>
      </div>

      {data.tasks.length > 0 && (
        <div className="shrink-0 border-b">
          {data.tasks.map((task) => (
            <div key={task.id} className="flex min-h-9 items-center gap-3 border-b px-3 py-1 last:border-b-0">
              {task.status === "running" ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-warn" />
              ) : (
                <X className="size-4 shrink-0 text-destructive" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {task.kind === "save" ? `Saving ${task.vm} as ${task.name}` : `${TASK_TITLE[task.kind] ?? task.kind} ${task.name}`}
                    {task.status === "failed" && " failed"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    started {new Date(task.started_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                  </span>
                  {task.status === "running" && (
                    <span className="text-xs text-muted-foreground">{task.kind === "build" ? "about an hour" : "a few minutes"}</span>
                  )}
                </div>
                <div className={cn("truncate font-mono text-xs", task.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                  {task.status === "failed" ? task.error : (task.log_tail[task.log_tail.length - 1] ?? "Starting…")}
                </div>
              </div>
              <Button size="xs" variant="ghost" onClick={() => setLogOf(task)}>
                <ScrollText /> Log
              </Button>
              {task.status === "running" && (
                <Button size="xs" variant="ghost" onClick={() => stopTask(task)}>
                  <Square /> Stop
                </Button>
              )}
              {task.status === "failed" && (
                <Button size="xs" variant="ghost" onClick={() => dismiss(task)}>
                  <X /> Dismiss
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>Name</span>
        <span>Description</span>
        <span className="text-right">Size</span>
        <span>Made</span>
        <span>VMs made from it</span>
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && data.images.length === 0 && <div className="px-3 py-2 text-muted-foreground">No images yet. Build one to make VMs.</div>}
        {loaded && data.default !== "" && data.images.length > 0 && !data.images.some((image) => image.default) && (
          <div className="border-b px-3 py-1.5 text-destructive">
            The default image {data.default} is gone. Make another one the default, or New VM can't work.
          </div>
        )}
        {data.images.map((image) => (
          <div key={image.fingerprint} className="border-b">
            <div
              className={cn(COLUMNS, "h-8 cursor-pointer px-3 hover:bg-accent/50", open.includes(image.fingerprint) && "bg-accent/40")}
              onClick={() => toggle(image.fingerprint)}
            >
              <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open.includes(image.fingerprint) && "rotate-90")} />
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{image.name}</span>
                {image.default && <Badge variant="secondary">default</Badge>}
              </span>
              <span className="truncate text-muted-foreground" title={image.description}>
                {image.description || "–"}
              </span>
              <span className="text-right tabular-nums">{image.size_gb.toFixed(1)} GB</span>
              <span className="text-muted-foreground tabular-nums">
                {new Date(image.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </span>
              <span className="truncate">
                {image.used_by.length === 0 && <span className="text-muted-foreground">–</span>}
                {image.used_by.map((name, index) => (
                  <span key={name}>
                    {index > 0 && ", "}
                    <a
                      href={`#/vms/${encodeURIComponent(name)}`}
                      className="text-primary hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {name}
                    </a>
                  </span>
                ))}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${image.name}`} onClick={(event) => event.stopPropagation()}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={image.default} onSelect={() => makeDefault(image)}>
                    <Star /> Make default
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setEditing(image)}>
                    <Pencil /> Edit name and description
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={buildRunning} onSelect={() => setBuilding({ name: image.name, rebuild: true })}>
                    <Hammer /> Rebuild
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={image.inspecting} onSelect={() => inspect(image)}>
                    <ScanSearch /> {image.inventory === null ? "Inspect" : "Inspect again"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" disabled={image.default} onSelect={() => setDeleting(image)}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {open.includes(image.fingerprint) && (
              <div className="border-t bg-muted/30 px-9 py-3">
                {image.inventory !== null && <ImageInventory image={image} />}
                {image.inventory === null && image.inspecting && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Listing what {image.name} has. It takes a few minutes.
                  </div>
                )}
                {image.inventory === null && !image.inspecting && (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    What {image.name} has isn't listed yet.
                    <Button size="xs" variant="outline" onClick={() => inspect(image)}>
                      <ScanSearch /> Inspect
                    </Button>
                    <span className="text-xs">About two minutes, in a throwaway VM with 4 GB of memory.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {building !== null && <BuildDialog name={building.name} rebuild={building.rebuild} onClose={() => setBuilding(null)} />}
      {saving && <SaveImageDialog vm={null} onClose={() => setSaving(false)} />}
      {editing !== null && <EditDialog key={editing.fingerprint} image={editing} onClose={() => setEditing(null)} />}
      {logOf !== null && <LogDialog task={logOf} onClose={() => setLogOf(null)} />}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              New VMs can't start from it anymore.
              {deleting !== null && deleting.used_by.length > 0 && ` ${deleting.used_by.join(", ")} keep working: each VM has its own disk.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleting !== null) {
                  remove(deleting);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Build a new image, or rebuild one (same name: it is replaced once the build is done).
function BuildDialog(props: { name: string; rebuild: boolean; onClose: () => void }) {
  const [name, setName] = useState(props.name);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api("/api/images/build", { method: "POST", body: { name: name.trim(), description: description.trim() } });
      toast.success(`Building ${name.trim()}. It takes about an hour.`);
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.rebuild ? `Rebuild ${props.name}` : "Build an image"}</DialogTitle>
          <DialogDescription>
            A fresh Ubuntu desktop with everything in sandbox/image/provision.sh. Takes about an hour.
            {props.rebuild && " The new build replaces the old one when it is done; VMs made from the old one keep their own disk."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground">Name</label>
          <Input
            autoFocus={!props.rebuild}
            disabled={props.rebuild}
            placeholder="e.g. desktop-2"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <label className="text-muted-foreground">Description</label>
          <Input placeholder="Optional" value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        {error !== "" && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || name.trim() === ""}>
            {busy && <Loader2 className="animate-spin" />} {props.rebuild ? "Rebuild" : "Build"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog(props: { image: Image; onClose: () => void }) {
  const [name, setName] = useState(props.image.name);
  const [description, setDescription] = useState(props.image.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/images/${encodeURIComponent(props.image.name)}`, {
        method: "PUT",
        body: { name: name.trim(), description: description.trim() },
      });
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {props.image.name}</DialogTitle>
          <DialogDescription>VMs made from it keep pointing at it after a rename.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground">Name</label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
          <label className="text-muted-foreground">Description</label>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        {error !== "" && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || name.trim() === ""}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The whole log of a build or save, fetched again every 2 s while the task runs. Stays at the bottom unless scrolled up.
function LogDialog(props: { task: ImageTask; onClose: () => void }) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLPreElement>(null);
  const running = props.task.status === "running";

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    async function load() {
      try {
        const response = await fetch(`/api/images/tasks/${props.task.id}/log`);
        const body = await response.text();
        if (stopped) {
          return;
        }
        const element = scrollRef.current;
        const atBottom = element === null || element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        setText(body);
        if (atBottom) {
          requestAnimationFrame(() => {
            if (scrollRef.current !== null) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          });
        }
      } catch {
        // The backend is restarting: try again next round.
      }
      if (running && !stopped) {
        timer = window.setTimeout(load, 2000);
      }
    }
    load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [props.task.id, running]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{props.task.kind === "build" ? `Building ${props.task.name}` : `Saving ${props.task.vm} as ${props.task.name}`}</DialogTitle>
          <DialogDescription>{running ? "Still running; this follows along." : "Failed. The last lines say why."}</DialogDescription>
        </DialogHeader>
        <pre ref={scrollRef} className="h-[60vh] overflow-auto border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
          {text || "Nothing yet."}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
