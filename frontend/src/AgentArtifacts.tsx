/*
An agent's Artifacts tab: its own folder on this computer (github_searcher/artifacts.py), like a small file manager.
You put files and folders in for the agent: Upload, Upload folder, or drop them (folders too) on the list. The agent
keeps its screenshots and the files it copies out of its VM here, looks at any picture or text in it, and copies
files from here into its VM. It can't delete anything here; you can.

Left: the folder you are in, with the path on top (click a part to go there), Up, New folder, Upload and Upload
folder. Double-click a folder to open it; click a file to see it on the right: a picture, text, or a Download button
for anything else. Each row's ⋯ menu has Download (files), Rename and Delete (asks first; a folder goes with
everything in it). The list reads its folder again whenever the agent's artifacts change (artifacts_stamp in the live
agent list), so a screenshot the agent takes shows up by itself. Nothing is ever overwritten: a name that is taken
is refused.
*/

import { ArrowUp, Download, File, Folder, FolderPlus, ImageIcon, Loader2, MoreHorizontal, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { api } from "@/live";
import { cn } from "@/lib/utils";

type Listing = {
  path: string;
  parent: string | null;
  entries: { name: string; kind: "folder" | "file"; size: number; modified: number }[];
};

// What shows on the right: pictures as pictures, these as text (the same lists as backend/artifacts_api.py).
const PICTURES = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const TEXTS = [".txt", ".md", ".log", ".json", ".yaml", ".yml", ".toml", ".csv", ".py", ".js", ".ts", ".tsx", ".sh", ".diff", ".patch", ".html", ".xml", ".svg"];
// The most text shown on the right; the rest is in the download.
const TEXT_SHOWN = 200_000;

export default function AgentArtifacts(props: { agentId: string; stamp: number }) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  // The file shown on the right (its path in the artifacts), and its text when it is a text file.
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  // Files still to upload, for the button's spinner.
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // The small dialogs: a new folder's name, a new name for something, what to delete.
  const [making, setMaking] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const base = `/api/agents/${props.agentId}/artifacts`;

  // The folder, again whenever the artifacts change.
  useEffect(() => {
    let stopped = false;
    api<Listing>(`${base}?path=${encodeURIComponent(path)}`)
      .then((answer) => {
        if (!stopped) {
          setListing(answer);
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
  }, [base, path, props.stamp]);

  // A text file's text, for the right side.
  const selectedSuffix = selected === null ? "" : selected.slice(selected.lastIndexOf(".")).toLowerCase();
  useEffect(() => {
    setText(null);
    if (selected === null || !TEXTS.includes(selectedSuffix)) {
      return;
    }
    let stopped = false;
    fetch(`${base}/file?path=${encodeURIComponent(selected)}`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(response.statusText))))
      .then((body) => {
        if (!stopped) {
          setText(body.length > TEXT_SHOWN ? body.slice(0, TEXT_SHOWN) + "\n[cut: download it for the rest]" : body);
        }
      })
      .catch(() => {
        if (!stopped) {
          setText("Could not read this file.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [base, selected, selectedSuffix, props.stamp]);

  // Upload folder needs webkitdirectory, which React doesn't know as a prop.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  // Each file is its own PUT, streamed by the browser; a folder's files keep their paths in it.
  async function upload(files: { file: File; path: string }[]) {
    if (files.length === 0) {
      return;
    }
    setUploading(files.length);
    let failed = 0;
    for (const item of files) {
      const target = path === "" ? item.path : `${path}/${item.path}`;
      try {
        const response = await fetch(`${base}/file?path=${encodeURIComponent(target)}`, { method: "PUT", body: item.file });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body && typeof body.detail === "string" ? body.detail : response.statusText);
        }
      } catch (err) {
        failed += 1;
        toast.error(`Could not upload ${item.path}: ${err instanceof Error ? err.message : err}`);
      }
      setUploading((left) => left - 1);
    }
    if (failed === 0) {
      toast.success(files.length === 1 ? `Uploaded ${files[0].path}` : `Uploaded ${files.length} files`);
    }
  }

  // What was dropped, folders opened all the way down. The entries must be taken before the first await:
  // the browser empties the drop's list once the event is over.
  async function drop(entries: FileSystemEntry[]) {
    const found: { file: File; path: string }[] = [];
    async function walk(entry: FileSystemEntry, prefix: string) {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        found.push({ file: file, path: prefix + entry.name });
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries gives a hundred or so at a time: read until it gives none.
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) {
          break;
        }
        for (const child of batch) {
          await walk(child, `${prefix}${entry.name}/`);
        }
      }
    }
    for (const entry of entries) {
      await walk(entry, "");
    }
    await upload(found);
  }

  async function makeFolder() {
    const name = newName.trim();
    if (name === "") {
      return;
    }
    try {
      await api(`${base}/folder`, { method: "POST", body: { path: path === "" ? name : `${path}/${name}` } });
      setMaking(false);
    } catch (err) {
      toast.error(`Could not make ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function rename() {
    if (renaming === null || newName.trim() === "") {
      return;
    }
    try {
      await api(`${base}/rename`, { method: "POST", body: { path: renaming, name: newName.trim() } });
      if (selected === renaming) {
        setSelected(null);
      }
      setRenaming(null);
    } catch (err) {
      toast.error(`Could not rename: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(target: string) {
    try {
      await api(`${base}/delete`, { method: "POST", body: { path: target } });
      if (selected !== null && (selected === target || selected.startsWith(`${target}/`))) {
        setSelected(null);
      }
      toast.success(`Deleted ${target}`);
    } catch (err) {
      toast.error(`Could not delete ${target}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // The path on top, each part a way back up: Artifacts / screenshots / today.
  const parts = path === "" ? [] : path.split("/");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
        <Button variant="ghost" size="icon-sm" aria-label="Up" title="Up" disabled={listing === null || listing.parent === null} onClick={() => setPath(listing?.parent ?? "")}>
          <ArrowUp />
        </Button>
        <div className="flex min-w-0 items-center gap-1 truncate">
          <button type="button" className="hover:underline" onClick={() => setPath("")}>
            Artifacts
          </button>
          {parts.map((part, index) => (
            <span key={index} className="flex items-center gap-1">
              <span className="text-muted-foreground">/</span>
              <button type="button" className="hover:underline" onClick={() => setPath(parts.slice(0, index + 1).join("/"))}>
                {part}
              </button>
            </span>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNewName("");
              setMaking(true);
            }}
          >
            <FolderPlus /> New folder
          </Button>
          <Button variant="outline" size="sm" disabled={uploading > 0} onClick={() => folderInput.current?.click()}>
            <Folder /> Upload folder
          </Button>
          <Button size="sm" disabled={uploading > 0} onClick={() => fileInput.current?.click()}>
            {uploading > 0 ? <Loader2 className="animate-spin" /> : <Upload />} {uploading > 0 ? `${uploading} to go` : "Upload"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])].map((file) => ({ file: file, path: file.name }));
              event.target.value = "";
              upload(files);
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])].map((file) => ({ file: file, path: file.webkitRelativePath || file.name }));
              event.target.value = "";
              upload(files);
            }}
          />
        </div>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="55%" minSize="30%">
          <div
            className={cn("h-full overflow-y-auto", dragOver && "bg-accent/40 outline-2 -outline-offset-2 outline-primary outline-dashed")}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry()).filter((entry) => entry !== null);
              drop(entries);
            }}
          >
            {error !== "" && <div className="px-3 py-2 text-destructive">{error}</div>}
            {listing === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
            {listing !== null && listing.entries.length === 0 && (
              <div className="px-3 py-6 text-center text-muted-foreground">
                Nothing here yet. Drop files or folders here, or use Upload. The agent keeps its screenshots here too.
              </div>
            )}
            {listing !== null &&
              listing.entries.map((entry) => {
                const full = path === "" ? entry.name : `${path}/${entry.name}`;
                const suffix = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
                let size = `${Math.round(entry.size / 1e6)} MB`;
                if (entry.size < 1e3) {
                  size = `${entry.size} B`;
                } else if (entry.size < 1e6) {
                  size = `${Math.round(entry.size / 1e3)} KB`;
                }
                return (
                  <div
                    key={entry.name}
                    className={cn("flex h-7 cursor-default items-center gap-2 border-b px-3 select-none hover:bg-accent/50", selected === full && "bg-selected hover:bg-selected")}
                    onClick={() => entry.kind === "file" && setSelected(full)}
                    onDoubleClick={() => entry.kind === "folder" && setPath(full)}
                  >
                    {entry.kind === "folder" && <Folder className="size-4 shrink-0 text-muted-foreground" />}
                    {entry.kind === "file" && PICTURES.includes(suffix) && <ImageIcon className="size-4 shrink-0 text-muted-foreground" />}
                    {entry.kind === "file" && !PICTURES.includes(suffix) && <File className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.kind === "file" && <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{size}</span>}
                    <span className="w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                      {new Date(entry.modified * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                    </span>
                    <span onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${entry.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {entry.kind === "file" && (
                            <DropdownMenuItem asChild>
                              <a href={`${base}/file?path=${encodeURIComponent(full)}&download=1`} download={entry.name}>
                                <Download /> Download
                              </a>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onSelect={() => {
                              setNewName(entry.name);
                              setRenaming(full);
                            }}
                          >
                            <Pencil /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(full)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </div>
                );
              })}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize="45%" minSize="25%">
          <div className="flex h-full min-h-0 flex-col">
            {selected === null && <div className="flex h-full items-center justify-center text-muted-foreground">Click a file to see it here.</div>}
            {selected !== null && (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected}</span>
                  <Button variant="ghost" size="sm" asChild>
                    <a href={`${base}/file?path=${encodeURIComponent(selected)}&download=1`} download={selected.split("/").pop()}>
                      <Download /> Download
                    </a>
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
                  {PICTURES.includes(selectedSuffix) && (
                    <img
                      src={`${base}/file?path=${encodeURIComponent(selected)}&v=${props.stamp}`}
                      alt={selected}
                      className="mx-auto max-h-full max-w-full object-contain"
                    />
                  )}
                  {TEXTS.includes(selectedSuffix) && (
                    <pre className="p-3 font-mono text-xs break-words whitespace-pre-wrap">{text ?? "Loading…"}</pre>
                  )}
                  {!PICTURES.includes(selectedSuffix) && !TEXTS.includes(selectedSuffix) && (
                    <div className="flex h-full items-center justify-center text-muted-foreground">No preview for this kind of file. Download it to open it.</div>
                  )}
                </div>
              </>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog
        open={making || renaming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMaking(false);
            setRenaming(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{making ? "New folder" : `Rename ${renaming?.split("/").pop()}`}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            placeholder={making ? "Folder name" : "New name"}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (making) {
                  makeFolder();
                } else {
                  rename();
                }
              }
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setMaking(false);
                setRenaming(null);
              }}
            >
              Cancel
            </Button>
            <Button disabled={newName.trim() === ""} onClick={() => (making ? makeFolder() : rename())}>
              {making ? "Make" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.split("/").pop()}?</AlertDialogTitle>
            <AlertDialogDescription>It is deleted for good, and a folder with everything in it. The agent can't look at it anymore.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
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
