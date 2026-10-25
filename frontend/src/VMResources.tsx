/*
The Resources tab of a VM page: this computer on the left, the VM on the right, like a two-pane file manager
(FileZilla, WinSCP). Each pane starts in its user's home. Double-click a folder to open it; Home, Up and the path
above the list move around. Hidden files (names starting with a dot) show only after the eye button.

Drag a file or folder onto the other pane to copy it into the folder that pane shows. A copy never moves and
never overwrites: a name that is already there is refused. It waits until the copy is done (a toast says so),
then both panes read their folder again. The VM's pane needs the VM running.

Only you can do this, here: agents have no tool that moves anything between the VM and this computer
(sandbox/file_transfer.py). The panes come from GET /api/computer/files and GET /api/vms/{name}/files,
a copy is POST /api/vms/{name}/files/copy.
*/

import { ArrowUp, Eye, EyeOff, File, Folder, Home, Loader2, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, useLive } from "@/live";
import { cn } from "@/lib/utils";

type Side = "computer" | "vm";

type Listing = {
  path: string;
  parent: string | null;
  entries: { name: string; kind: "folder" | "file"; size: number; modified: number }[];
};

export default function VMResources(props: { name: string }) {
  const vms = useLive("vms");
  const vm = vms.find((each) => each.name === props.name);
  // Goes up after each copy, so both panes read their folder again.
  const [copied, setCopied] = useState(0);

  async function copy(to: Side, source: string, targetDir: string) {
    const name = source.split("/").pop() ?? source;
    const where = to === "vm" ? props.name : "this computer";
    const toastId = toast.loading(`Copying ${name} to ${where}…`);
    try {
      await api(`/api/vms/${encodeURIComponent(props.name)}/files/copy`, {
        method: "POST",
        body: { to: to, source: source, target_dir: targetDir },
      });
      toast.success(`Copied ${name} to ${where}`, { id: toastId });
      setCopied((count) => count + 1);
    } catch (err) {
      toast.error(`Could not copy ${name}: ${err instanceof Error ? err.message : err}`, { id: toastId });
    }
  }

  if (vm === undefined) {
    return <div className="p-3 text-muted-foreground">No VM named {props.name}.</div>;
  }

  return (
    <div className="grid h-full grid-cols-2 divide-x">
      <FilePane side="computer" title="This computer" vmName={props.name} off={false} copied={copied} onCopy={copy} />
      <FilePane side="vm" title={props.name} vmName={props.name} off={vm.status !== "running"} copied={copied} onCopy={copy} />
    </div>
  );
}

// One pane: a folder on this computer or in the VM. Rows drag out with their side in the drag's type, so a pane can
// tell while you drag (before the drop, only the types can be read) whether it comes from the other side.
function FilePane(props: {
  side: Side;
  title: string;
  vmName: string;
  off: boolean;
  copied: number;
  onCopy: (to: Side, source: string, targetDir: string) => void;
}) {
  const other: Side = props.side === "vm" ? "computer" : "vm";
  const accepted = `application/x-seraph-${other}`;
  // "" is the home folder; the listing says which folder that is.
  const [path, setPath] = useState("");
  const [reload, setReload] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    if (props.off) {
      return;
    }
    let stopped = false;
    let url = `/api/computer/files?path=${encodeURIComponent(path)}`;
    if (props.side === "vm") {
      url = `/api/vms/${encodeURIComponent(props.vmName)}/files?path=${encodeURIComponent(path)}`;
    }
    api<Listing>(url)
      .then((data) => {
        if (!stopped) {
          setListing(data);
          setError("");
        }
      })
      .catch((err) => {
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      stopped = true;
    };
  }, [props.side, props.vmName, props.off, props.copied, path, reload]);

  const entries = listing === null ? [] : listing.entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  const parts = listing === null ? [] : listing.path.split("/").filter((part) => part !== "");

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-2">
        <span className="mr-1.5 shrink-0 font-medium">{props.title}</span>
        <Button variant="ghost" size="icon-xs" title="Home folder" aria-label="Home folder" disabled={props.off} onClick={() => setPath("")}>
          <Home />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Up one folder"
          aria-label="Up one folder"
          disabled={props.off || listing === null || listing.parent === null}
          onClick={() => {
            if (listing !== null && listing.parent !== null) {
              setPath(listing.parent);
            }
          }}
        >
          <ArrowUp />
        </Button>
        <div className="flex min-w-0 flex-1 items-center overflow-hidden px-1 text-muted-foreground">
          {!props.off && listing !== null && (
            <button type="button" className="shrink-0 rounded-sm px-0.5 hover:bg-accent hover:text-foreground" onClick={() => setPath("/")}>
              /
            </button>
          )}
          {!props.off &&
            parts.map((part, index) => (
              <span key={index} className="flex shrink-0 items-center">
                <button
                  type="button"
                  className="rounded-sm px-0.5 hover:bg-accent hover:text-foreground"
                  onClick={() => setPath("/" + parts.slice(0, index + 1).join("/"))}
                >
                  {part}
                </button>
                {index < parts.length - 1 && <span>/</span>}
              </span>
            ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => setShowHidden(!showHidden)}
        >
          {showHidden ? <EyeOff /> : <Eye />}
        </Button>
        <Button variant="ghost" size="icon-xs" title="Read the folder again" aria-label="Refresh" disabled={props.off} onClick={() => setReload(reload + 1)}>
          <RotateCw />
        </Button>
      </div>

      {props.off && <p className="p-3 text-muted-foreground">Start {props.vmName} to see its files.</p>}
      {!props.off && (
        <div
          className={cn("min-h-0 flex-1 overflow-auto select-none", dropping && "bg-primary/5 ring-2 ring-primary ring-inset")}
          onDragOver={(event) => {
            if (listing === null || !event.dataTransfer.types.includes(accepted)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropping(true);
          }}
          onDragLeave={(event) => {
            // Moving onto a row inside the list is not leaving it.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropping(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDropping(false);
            const source = event.dataTransfer.getData(accepted);
            if (listing !== null && source !== "") {
              props.onCopy(props.side, source, listing.path);
            }
          }}
        >
          {error !== "" && <p className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{error}</p>}
          {listing === null && error === "" && (
            <div className="flex items-center gap-2 p-3 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          )}
          {listing !== null && entries.length === 0 && <p className="p-3 text-muted-foreground">Nothing in this folder.</p>}
          {listing !== null &&
            entries.map((entry) => {
              const full = listing.path === "/" ? `/${entry.name}` : `${listing.path}/${entry.name}`;
              const folder = entry.kind === "folder";
              // In the units file managers use: 1 KB = 1024 bytes.
              let size = "";
              if (!folder && entry.size >= 1024 ** 3) {
                size = `${(entry.size / 1024 ** 3).toFixed(1)} GB`;
              } else if (!folder && entry.size >= 1024 ** 2) {
                size = `${(entry.size / 1024 ** 2).toFixed(1)} MB`;
              } else if (!folder && entry.size >= 1024) {
                size = `${Math.round(entry.size / 1024)} KB`;
              } else if (!folder) {
                size = `${entry.size} B`;
              }
              return (
                <div
                  key={entry.name}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(`application/x-seraph-${props.side}`, full);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onDoubleClick={() => {
                    if (folder) {
                      setPath(full);
                    }
                  }}
                  className="flex h-7 cursor-default items-center gap-2 px-3 hover:bg-accent/50"
                  title={folder ? `${entry.name}: double-click to open, drag to the other side to copy` : `${entry.name}: drag to the other side to copy`}
                >
                  {folder ? <Folder className="size-4 shrink-0 text-primary" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{size}</span>
                  <span className="w-36 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {entry.modified > 0 && new Date(entry.modified * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
