import { ArrowLeftIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, DownloadIcon, FileDirectoryFillIcon, FileIcon, HomeIcon, PencilIcon, SyncIcon, TrashIcon, UploadIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

// Directory tab: one entry of a folder in the VM, and a file opened from it.
interface VmFileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  modified: number;
}

interface VmFile {
  path: string;
  kind: "text" | "image" | "binary" | "too_big";
  size: number;
  text?: string;
  mime?: string;
  data?: string;
}

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

// Tree or list, so a refresh keeps it.
let savedMode = "tree";
try {
  savedMode = localStorage.getItem("directory") ?? "tree";
} catch {
  savedMode = "tree";
}

// Directory panel of one VM: browse its folders, open, edit, download, upload and delete files.
export default function Directory(props: { sessionId: string; ready: boolean; shown: boolean }) {
  // The folder shown (null: not loaded yet), its entries, and the file open in it.
  const [dirPath, setDirPath] = useState<string | null>(null);
  const [dirHome, setDirHome] = useState("");
  const [dirEntries, setDirEntries] = useState<VmFileEntry[]>([]);
  const [dirHidden, setDirHidden] = useState(false);
  // Tree: folders open in place as drop-downs. List: clicking a folder goes into it.
  const [dirMode, setDirMode] = useState<"tree" | "list">(savedMode === "list" ? "list" : "tree");
  // Tree mode: the entries of every folder opened so far (by path), and which are open now.
  const [dirTree, setDirTree] = useState<Record<string, VmFileEntry[]>>({});
  const [dirOpen, setDirOpen] = useState<string[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirFile, setDirFile] = useState<VmFile | null>(null);
  const [dirEditing, setDirEditing] = useState(false);
  const [dirEditText, setDirEditText] = useState("");
  const dirUpload = useRef<HTMLInputElement>(null);

  // Remember tree or list for the next refresh. Storage can be blocked (private window): then it just isn't kept.
  useEffect(() => {
    try {
      localStorage.setItem("directory", dirMode);
    } catch {
      return;
    }
  }, [dirMode]);

  // Open the home folder the first time the panel is shown.
  useEffect(() => {
    if (props.shown && props.ready && dirPath === null && !dirLoading && dirError === null) {
      openFolder("");
    }
  });

  async function openFolder(path: string) {
    const sessionId = props.sessionId;
    setDirLoading(true);
    setDirError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setDirPath(body.path);
      setDirHome(body.home);
      setDirEntries(body.entries);
      setDirTree((old) => ({ ...old, [body.path]: body.entries }));
      setDirFile(null);
      setDirEditing(false);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : String(err));
    }
    setDirLoading(false);
  }

  // Tree mode: load a folder's entries (if not yet) and open or close it in place.
  async function toggleTreeFolder(path: string) {
    if (dirOpen.includes(path)) {
      setDirOpen(dirOpen.filter((item) => item !== path));
      return;
    }
    if (dirTree[path] === undefined) {
      const loaded = await loadTreeFolder(path);
      if (!loaded) {
        return;
      }
    }
    setDirOpen((old) => [...old, path]);
  }

  async function loadTreeFolder(path: string): Promise<boolean> {
    const sessionId = props.sessionId;
    setDirError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setDirTree((old) => ({ ...old, [path]: body.entries }));
      return true;
    } catch (err) {
      setDirError(`${path}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async function openFile(path: string) {
    const sessionId = props.sessionId;
    setDirLoading(true);
    setDirError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setDirFile({ path: path, ...body });
      setDirEditing(false);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : String(err));
    }
    setDirLoading(false);
  }

  async function saveFile() {
    if (dirFile === null) {
      return;
    }
    setDirError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${props.sessionId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dirFile.path, text: dirEditText }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setDirFile({ ...dirFile, kind: "text", text: dirEditText, size: new TextEncoder().encode(dirEditText).length });
      setDirEditing(false);
    } catch (err) {
      setDirError(`Could not save: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function deletePath(path: string, isFolder: boolean) {
    const question = isFolder ? `Delete the folder ${path} and everything in it?` : `Delete ${path}?`;
    if (!window.confirm(question)) {
      return;
    }
    setDirError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${props.sessionId}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
    } catch (err) {
      setDirError(`Could not delete: ${err instanceof Error ? err.message : err}`);
      return;
    }
    // Load the folder it was in again. A folder deeper in the tree reloads in place.
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    setDirFile(null);
    setDirOpen((old) => old.filter((item) => item !== path && !item.startsWith(path + "/")));
    if (parent === dirPath) {
      openFolder(parent);
    } else {
      loadTreeFolder(parent);
    }
  }

  async function uploadFiles(fileList: FileList) {
    if (dirPath === null) {
      return;
    }
    setDirError(null);
    for (const file of Array.from(fileList)) {
      const exists = dirEntries.some((entry) => entry.name === file.name);
      if (exists && !window.confirm(`${file.name} is already in this folder. Replace it?`)) {
        continue;
      }
      // The file as base64: a data URL is "data:<type>;base64,<data>".
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      try {
        const response = await fetch(`/api/vm/sessions/${props.sessionId}/files/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder: dirPath, name: file.name, data: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.detail);
        }
      } catch (err) {
        setDirError(`Could not upload ${file.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    openFolder(dirPath);
  }

  // Tree mode: the rows of one folder, with the rows of its open folders under each.
  function treeRows(folder: string, depth: number): ReactNode[] {
    const rows: ReactNode[] = [];
    const entries = (dirTree[folder] ?? []).filter((entry) => dirHidden || !entry.name.startsWith("."));
    for (const entry of entries) {
      const path = `${folder === "/" ? "" : folder}/${entry.name}`;
      const open = dirOpen.includes(path);
      rows.push(
        <div key={path} className="file-row dir-row">
          <button className="dir-row-name" type="button" style={{ paddingLeft: depth * 20 }} onClick={() => (entry.type === "dir" ? toggleTreeFolder(path) : openFile(path))}>
            <span className="dir-chevron">{entry.type === "dir" && (open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />)}</span>
            {entry.type === "dir" ? <FileDirectoryFillIcon size={16} className="file-icon-dir" /> : <FileIcon size={16} className="file-icon" />}
            {entry.name}
          </button>
          <span className="dir-row-size muted">{entry.type === "file" ? `${COUNT.format(entry.size)}B` : ""}</span>
          <span className="dir-row-time muted">{DATE.format(new Date(entry.modified * 1000))}</span>
          <button className="terminal-tab-close dir-row-delete" type="button" aria-label={`Delete ${entry.name}`} title="Delete" onClick={() => deletePath(path, entry.type === "dir")}>
            <TrashIcon size={14} />
          </button>
        </div>,
      );
      if (entry.type === "dir" && open) {
        rows.push(...treeRows(path, depth + 1));
      }
    }
    return rows;
  }

  if (!props.shown) {
    return null;
  }
  if (!props.ready) {
    return <p className="vm-viewer-empty muted">The VM is off. Start it in Settings to look at its files.</p>;
  }
  return (
    <div className="vm-pane vm-directory">
      <div className="dir-toolbar">
        <div className="breadcrumb dir-breadcrumb">
          {dirFile !== null && (
            <button className="btn btn-sm" type="button" aria-label="Back to the folder" title="Back to the folder" onClick={() => setDirFile(null)}>
              <ArrowLeftIcon size={14} />
            </button>
          )}
          <button className="btn-link" type="button" onClick={() => openFolder("/")}>
            /
          </button>
          {(dirFile !== null ? dirFile.path : dirPath ?? "")
            .split("/")
            .filter(Boolean)
            .map((part, i, parts) => (
              <span key={i}>
                {i > 0 && " / "}
                {dirFile !== null && i === parts.length - 1 ? (
                  <strong>{part}</strong>
                ) : (
                  <button className="btn-link" type="button" onClick={() => openFolder("/" + parts.slice(0, i + 1).join("/"))}>
                    {part}
                  </button>
                )}
              </span>
            ))}
        </div>
        {dirFile === null && (
          <div className="dir-actions">
            <button className="btn btn-sm" type="button" title="Up one folder" disabled={dirPath === null || dirPath === "/"} onClick={() => dirPath !== null && openFolder(dirPath.slice(0, dirPath.lastIndexOf("/")) || "/")}>
              <ArrowUpIcon size={14} />
            </button>
            <button className="btn btn-sm" type="button" title="Home folder" onClick={() => openFolder(dirHome)}>
              <HomeIcon size={14} />
            </button>
            <div className="view-toggle">
              <button className={dirMode === "tree" ? "view-toggle-on" : ""} type="button" aria-pressed={dirMode === "tree"} title="Folders open as drop-downs" onClick={() => setDirMode("tree")}>
                Tree
              </button>
              <button className={dirMode === "list" ? "view-toggle-on" : ""} type="button" aria-pressed={dirMode === "list"} title="Click a folder to go into it" onClick={() => setDirMode("list")}>
                List
              </button>
            </div>
            <label className="vm-settings-check dir-hidden-toggle">
              <input type="checkbox" checked={dirHidden} onChange={(event) => setDirHidden(event.target.checked)} />
              Hidden files
            </label>
            <button
              className="btn btn-sm"
              type="button"
              title="Refresh"
              disabled={dirPath === null}
              onClick={() => {
                if (dirPath === null) {
                  return;
                }
                openFolder(dirPath);
                for (const path of dirOpen) {
                  loadTreeFolder(path);
                }
              }}
            >
              <SyncIcon size={14} />
            </button>
            <button className="btn btn-sm" type="button" disabled={dirPath === null} onClick={() => dirUpload.current?.click()}>
              <UploadIcon size={14} /> Upload
            </button>
            <input
              ref={dirUpload}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) {
                  uploadFiles(event.target.files);
                }
                event.target.value = "";
              }}
            />
          </div>
        )}
        {dirFile !== null && (
          <div className="dir-actions">
            <span className="muted">{COUNT.format(dirFile.size)}B</span>
            {dirFile.kind === "text" && !dirEditing && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => {
                  setDirEditText(dirFile.text ?? "");
                  setDirEditing(true);
                }}
              >
                <PencilIcon size={14} /> Edit
              </button>
            )}
            {dirEditing && (
              <button className="btn btn-sm" type="button" onClick={() => setDirEditing(false)}>
                Cancel
              </button>
            )}
            {dirEditing && (
              <button className="btn btn-sm btn-primary" type="button" onClick={saveFile}>
                Save
              </button>
            )}
            <a className="btn btn-sm" href={`/api/vm/sessions/${props.sessionId}/files/download?path=${encodeURIComponent(dirFile.path)}`} download>
              <DownloadIcon size={14} /> Download
            </a>
            <button className="btn btn-sm" type="button" onClick={() => deletePath(dirFile.path, false)}>
              <TrashIcon size={14} /> Delete
            </button>
          </div>
        )}
      </div>

      {dirError && <p className="vm-card-status vm-card-status-bad dir-error">{dirError}</p>}
      {dirLoading && (
        <p className="status-line">
          <span className="spinner" /> Loading…
        </p>
      )}

      {dirFile === null && dirPath !== null && dirMode === "tree" && (
        <div className="file-list dir-list">
          {dirEntries.filter((entry) => dirHidden || !entry.name.startsWith(".")).length === 0 && <p className="side-empty muted">This folder is empty.</p>}
          {treeRows(dirPath, 0)}
        </div>
      )}

      {dirFile === null && dirPath !== null && dirMode === "list" && (
        <div className="file-list dir-list">
          {dirEntries.filter((entry) => dirHidden || !entry.name.startsWith(".")).length === 0 && <p className="side-empty muted">This folder is empty.</p>}
          {dirEntries
            .filter((entry) => dirHidden || !entry.name.startsWith("."))
            .map((entry) => (
              <div key={entry.name} className="file-row dir-row">
                <button
                  className="dir-row-name"
                  type="button"
                  onClick={() => (entry.type === "dir" ? openFolder(`${dirPath === "/" ? "" : dirPath}/${entry.name}`) : openFile(`${dirPath === "/" ? "" : dirPath}/${entry.name}`))}
                >
                  {entry.type === "dir" ? <FileDirectoryFillIcon size={16} className="file-icon-dir" /> : <FileIcon size={16} className="file-icon" />}
                  {entry.name}
                </button>
                <span className="dir-row-size muted">{entry.type === "file" ? `${COUNT.format(entry.size)}B` : ""}</span>
                <span className="dir-row-time muted">{DATE.format(new Date(entry.modified * 1000))}</span>
                <button
                  className="terminal-tab-close dir-row-delete"
                  type="button"
                  aria-label={`Delete ${entry.name}`}
                  title="Delete"
                  onClick={() => deletePath(`${dirPath === "/" ? "" : dirPath}/${entry.name}`, entry.type === "dir")}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
        </div>
      )}

      {dirFile !== null && (
        <div className="file-view dir-file">
          {dirFile.kind === "text" && !dirEditing && (
            <pre className="file-code dir-code">
              <code>
                {(dirFile.text ?? "").split("\n").map((line, i) => (
                  <span key={i} className="dir-code-line">
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          )}
          {dirFile.kind === "text" && dirEditing && <textarea className="form-control dir-editor" spellCheck={false} value={dirEditText} onChange={(event) => setDirEditText(event.target.value)} />}
          {dirFile.kind === "image" && <img className="file-image" src={`data:${dirFile.mime};base64,${dirFile.data}`} alt={dirFile.path} />}
          {dirFile.kind === "binary" && <p className="side-empty muted">This file isn't text, so it can't be shown here. Download it instead.</p>}
          {dirFile.kind === "too_big" && <p className="side-empty muted">This file is too big to show here. Download it instead.</p>}
        </div>
      )}
    </div>
  );
}
