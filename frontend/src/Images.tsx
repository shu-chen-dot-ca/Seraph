/*
The Images tab of the VMs page: the images new VMs start from.

One row per image (an Incus image with a name): its system version, size, when it was made, and how many VMs
were made from that exact image (stopped ones too). The default image is what New VM picks first. Each row's
menu: make it the default, rename it, rebuild it, delete it (only once no VM was made from it).
Details opens what the image has (ImageInventory) in a dialog, with Inspect again and the image's agent, which
keeps its description; an image that wasn't listed yet has Inspect instead (about two minutes, in a throwaway VM).
An amber dot after the name: its description changed since it was built, so a rebuild would give a different image.

New images come from New image (NewImageDialog: the image's agent makes it from an official system image) or
Save a VM (that VM's disk as it is, a few minutes). Rebuild has the agent make it again from its description.
They run in the background as tasks, shown above the list with their last log lines until the image is listed;
the whole log opens in a dialog. Everything comes from the live "images" topic.
*/

import { Hammer, Loader2, MoreHorizontal, Pencil, Plus, Save, ScanSearch, ScrollText, Square, Star, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import ImageInventory from "@/ImageInventory";
import NewImageDialog from "@/NewImageDialog";
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
import { StatusDot } from "@/components/ui/status-dot";
import { api, useLive, useLoaded, type Image, type ImageTask } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_80px_150px_56px_96px_32px] items-center gap-3";

const TASK_TITLE: Record<string, string> = { agent: "Making", save: "Saving", inspect: "Listing what it has:" };

// tabs: the VMs page's tabs, which share the header row with the buttons here.
export default function Images(props: { tabs: ReactNode }) {
  const data = useLive("images");
  const loaded = useLoaded("images");
  // Which dialog is open, and for which image or task.
  const [creating, setCreating] = useState(false);
  const [rebuilding, setRebuilding] = useState<Image | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<Image | null>(null);
  const [deleting, setDeleting] = useState<Image | null>(null);
  const [logOf, setLogOf] = useState<ImageTask | null>(null);
  // The fingerprint of the image whose Details are open. Read from the live list, so Inspect again shows up in it.
  const [showing, setShowing] = useState("");
  const shown = data.images.find((image) => image.fingerprint === showing);

  // The agent makes one image at a time.
  const buildRunning = data.tasks.some((task) => task.kind === "agent" && task.status === "running");

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

  async function rebuild(image: Image) {
    try {
      await api(`/api/images/${encodeURIComponent(image.name)}/rebuild`, { method: "POST" });
      toast.success(`The agent is making ${image.name} again. Follow it above the image list.`);
    } catch (err) {
      toast.error(`Could not rebuild ${image.name}: ${err instanceof Error ? err.message : err}`);
    }
    setRebuilding(null);
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
        {props.tabs}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setSaving(true)}>
            <Save /> Save a VM as image
          </Button>
          <Button
            size="sm"
            disabled={buildRunning}
            title={buildRunning ? "The agent makes one image at a time" : undefined}
            onClick={() => setCreating(true)}
          >
            <Plus /> New image
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
                    <span className="text-xs text-muted-foreground">{task.kind === "agent" ? "the agent is on it" : "a few minutes"}</span>
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
        <span>Name</span>
        <span>System</span>
        <span className="text-right">Size</span>
        <span>Made</span>
        <span className="text-right">VMs</span>
        <span />
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
          <div key={image.fingerprint} className={cn(COLUMNS, "min-h-8 border-b px-3 py-0.5 hover:bg-accent/50")}>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{image.name}</span>
              {image.spec_changed && (
                <span title="Its description changed since this build. Rebuild to apply it.">
                  <StatusDot tone="amber" />
                </span>
              )}
              {image.default && <Badge>default</Badge>}
            </span>
            <span className="truncate text-muted-foreground">{image.inventory === null ? "–" : image.inventory.system.os}</span>
            <span className="text-right tabular-nums">{image.size_gb.toFixed(1)} GB</span>
            <span className="text-muted-foreground tabular-nums">
              {new Date(image.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span className={cn("text-right tabular-nums", image.used_by.length === 0 && "text-muted-foreground")} title={image.used_by.join(", ")}>
              {image.used_by.length}
            </span>
            <span className="flex justify-end">
              {image.inventory !== null && (
                <Button size="xs" variant="ghost" onClick={() => setShowing(image.fingerprint)}>
                  Details
                </Button>
              )}
              {image.inventory === null && (
                <Button size="xs" variant="ghost" disabled={image.inspecting} onClick={() => inspect(image)}>
                  {image.inspecting && <Loader2 className="animate-spin" />} {image.inspecting ? "Inspecting" : "Inspect"}
                </Button>
              )}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${image.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={image.default} onSelect={() => makeDefault(image)}>
                  <Star /> Make default
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRenaming(image)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={buildRunning} onSelect={() => setRebuilding(image)}>
                  <Hammer /> Rebuild
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={image.default || image.used_by.length > 0} onSelect={() => setDeleting(image)}>
                  <Trash2 /> Delete
                  {image.used_by.length > 0 && <span className="ml-auto text-xs">VMs use it</span>}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      {creating && <NewImageDialog onClose={() => setCreating(false)} />}
      {saving && <SaveImageDialog vm={null} onClose={() => setSaving(false)} />}
      {renaming !== null && <RenameDialog key={renaming.fingerprint} image={renaming} onClose={() => setRenaming(null)} />}
      {logOf !== null && <LogDialog task={logOf} onClose={() => setLogOf(null)} />}

      <Dialog
        open={shown !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setShowing("");
          }
        }}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>What {shown?.name} has</DialogTitle>
            <DialogDescription>Listed in a throwaway VM made from it. Inspect again lists it anew (about two minutes).</DialogDescription>
          </DialogHeader>
          {shown !== undefined && (
            <ImageInventory
              key={shown.fingerprint}
              image={shown}
              onRebuild={() => {
                setShowing("");
                setRebuilding(shown);
              }}
            />
          )}
          <DialogFooter>
            <Button variant="outline" disabled={shown === undefined || shown.inspecting} onClick={() => shown !== undefined && inspect(shown)}>
              {shown?.inspecting ? <Loader2 className="animate-spin" /> : <ScanSearch />} {shown?.inspecting ? "Inspecting" : "Inspect again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <AlertDialogDescription>New VMs can't start from it anymore.</AlertDialogDescription>
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

      <AlertDialog
        open={rebuilding !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRebuilding(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild {rebuilding?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its agent makes it again from its description, starting from a fresh download of the system. The new build replaces it
              when it is done; VMs made from it keep their own disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rebuilding !== null) {
                  rebuild(rebuilding);
                }
              }}
            >
              Rebuild
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RenameDialog(props: { image: Image; onClose: () => void }) {
  const [name, setName] = useState(props.image.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/images/${encodeURIComponent(props.image.name)}`, { method: "PUT", body: { name: name.trim() } });
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
          <DialogTitle>Rename {props.image.name}</DialogTitle>
          <DialogDescription>VMs made from it keep pointing at it after a rename.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground">Name</label>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        {error !== "" && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || name.trim() === "" || name.trim() === props.image.name}>
            {busy && <Loader2 className="animate-spin" />} Rename
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
          <DialogTitle>
            {props.task.kind === "save" ? `Saving ${props.task.vm} as ${props.task.name}` : `${TASK_TITLE[props.task.kind] ?? props.task.kind} ${props.task.name}`}
          </DialogTitle>
          <DialogDescription>{running ? "Still running; this follows along." : "Failed. The last lines say why."}</DialogDescription>
        </DialogHeader>
        <pre ref={scrollRef} className="h-[60vh] overflow-auto border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
          {text || "Nothing yet."}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
