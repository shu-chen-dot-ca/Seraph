/*
One repo, shown in place under its row on the Repos and Explore pages: its README first, rendered, then at the bottom
its files, folded until clicked, like the VS Code explorer.

The README loads as soon as the row opens. The file list loads the first time the files are unfolded; the backend
sends it all at once (GitHub's recursive tree), so folders open without another request. Clicking a file opens it
inline below its line: code with line numbers, or rendered markdown for .md files.
*/

import { BookOpen, ChevronRight, ExternalLink, File, FileText, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/ui/markdown";
import { api, type Readme, type RepoFile, type RepoTree as Tree, type TreeFile } from "@/live";
import { cn } from "@/lib/utils";

const SIZE = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// repo is a listed repo (RepoItem) or one Explore found: only its name, description and GitHub link are used.
export default function RepoTree(props: { repo: { full_name: string; description: string; html_url: string } }) {
  const name = props.repo.full_name;
  const [readme, setReadme] = useState<Readme | null>(null);
  const [readmeError, setReadmeError] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [tree, setTree] = useState<Tree | null>(null);
  const [treeError, setTreeError] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [fileData, setFileData] = useState<Record<string, RepoFile>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});

  // Load the README once when the row opens.
  useEffect(() => {
    let cancelled = false;
    api<Readme>(`/api/repos/readme?name=${encodeURIComponent(name)}`)
      .then((data) => {
        if (!cancelled) {
          setReadme(data);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setReadmeError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  // Folder path → its entries, folders first, then by name. "" is the root.
  const children = useMemo(() => {
    const map = new Map<string, TreeFile[]>();
    for (const file of tree?.files ?? []) {
      const slash = file.path.lastIndexOf("/");
      const parent = slash === -1 ? "" : file.path.slice(0, slash);
      const list = map.get(parent) ?? [];
      list.push(file);
      map.set(parent, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "tree" ? -1 : 1));
    }
    return map;
  }, [tree]);

  // The visible lines: walk the tree depth first, going into expanded folders only.
  const lines: { file: TreeFile; depth: number }[] = [];
  const stack = (children.get("") ?? []).map((file) => ({ file: file, depth: 0 })).reverse();
  while (stack.length > 0) {
    const line = stack.pop()!;
    lines.push(line);
    if (line.file.type !== "tree" || !expanded.includes(line.file.path)) {
      continue;
    }
    const inside = children.get(line.file.path) ?? [];
    for (let i = inside.length - 1; i >= 0; i--) {
      stack.push({ file: inside[i], depth: line.depth + 1 });
    }
  }

  function toggleFolder(path: string) {
    setExpanded((current) => (current.includes(path) ? current.filter((p) => p !== path) : [...current, path]));
  }

  async function toggleFile(path: string) {
    if (openFiles.includes(path)) {
      setOpenFiles((current) => current.filter((p) => p !== path));
      return;
    }
    setOpenFiles((current) => [...current, path]);
    if (fileData[path] !== undefined) {
      return;
    }
    setFileErrors((current) => ({ ...current, [path]: "" }));
    try {
      const data = await api<RepoFile>(`/api/repos/file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
      setFileData((current) => ({ ...current, [path]: data }));
    } catch (err) {
      setFileErrors((current) => ({ ...current, [path]: err instanceof Error ? err.message : String(err) }));
    }
  }

  // The file list loads the first time the files are unfolded (again after a failure).
  async function toggleFiles() {
    setFilesOpen(!filesOpen);
    if (filesOpen || tree !== null) {
      return;
    }
    setTreeError("");
    try {
      setTree(await api<Tree>(`/api/repos/tree?name=${encodeURIComponent(name)}`));
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="flex h-7 items-center gap-3 px-3 text-muted-foreground">
        <span className="min-w-0 truncate">{props.repo.description || "No description."}</span>
        {readme?.ref && <span className="ml-auto shrink-0 font-mono text-xs">{readme.ref}</span>}
        <a
          href={props.repo.html_url}
          target="_blank"
          rel="noreferrer"
          className={cn("flex shrink-0 items-center gap-1 hover:text-foreground", !readme?.ref && "ml-auto")}
        >
          GitHub <ExternalLink className="size-3" />
        </a>
      </div>

      {/* Like GitHub: the README in a box of reading width, centered, however wide the screen. */}
      <div className="border-t px-6 py-4">
        <div className="mx-auto max-w-[900px] rounded-md border bg-background">
          <div className="flex h-9 items-center gap-1.5 border-b px-4 font-medium">
            <BookOpen className="size-4 text-muted-foreground" /> README
          </div>
          <div className="px-8 py-6">
            {readme === null && readmeError === "" && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading README…
              </div>
            )}
            {readmeError !== "" && <div className="text-destructive">Could not load the README: {readmeError}</div>}
            {readme !== null && readme.markdown === null && <div className="text-muted-foreground">This repo has no README.</div>}
            {readme !== null && readme.markdown !== null && <Markdown text={readme.markdown} repo={name} gitRef={readme.ref} />}
          </div>
        </div>
      </div>

      <button type="button" className="flex h-7 w-full items-center gap-1.5 border-t px-3 text-left hover:bg-accent/60" onClick={toggleFiles}>
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", filesOpen && "rotate-90")} />
        {filesOpen ? <FolderOpen className="size-4 text-primary" /> : <Folder className="size-4 text-primary" />}
        <span className="font-medium">Files</span>
      </button>

      {filesOpen && tree === null && treeError === "" && (
        <div className="flex h-7 items-center gap-2 px-3 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading files…
        </div>
      )}
      {filesOpen && treeError !== "" && <div className="px-3 py-1.5 text-destructive">Could not load the files: {treeError}</div>}
      {filesOpen && tree !== null && tree.truncated && (
        <div className="px-3 py-1 text-xs text-warn">GitHub cut this tree short: some files are not listed.</div>
      )}
      {filesOpen && tree !== null && tree.files.length === 0 && <div className="px-3 py-1.5 text-muted-foreground">This repo is empty.</div>}

      {filesOpen && (
        <div className="pb-1">
          {lines.map((line) => {
            const indent = 12 + line.depth * 14;
            const path = line.file.path;
            const fileName = path.slice(path.lastIndexOf("/") + 1);

            if (line.file.type === "tree") {
              const isOpen = expanded.includes(path);
              return (
                <button
                  key={path}
                  type="button"
                  className="flex h-6 w-full items-center gap-1.5 pr-3 text-left hover:bg-accent/60"
                  style={{ paddingLeft: indent }}
                  onClick={() => toggleFolder(path)}
                >
                  <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  {isOpen ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{fileName}</span>
                </button>
              );
            }

            const isOpen = openFiles.includes(path);
            const data = fileData[path];
            const error = fileErrors[path] ?? "";
            const isMarkdown = /\.(md|markdown|mdx)$/i.test(path);
            let numbers = "";
            if (data !== undefined && data.text !== null && !isMarkdown) {
              const count = data.text.split("\n").length - (data.text.endsWith("\n") ? 1 : 0);
              numbers = Array.from({ length: count }, (_, i) => i + 1).join("\n");
            }

            return (
              <div key={path}>
                <button
                  type="button"
                  className={cn("flex h-6 w-full items-center gap-1.5 pr-3 text-left hover:bg-accent/60", isOpen && "bg-selected")}
                  style={{ paddingLeft: indent + 18 }}
                  onClick={() => toggleFile(path)}
                >
                  {isMarkdown ? <FileText className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{fileName}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{SIZE.format(line.file.size)}B</span>
                </button>

                {isOpen && (
                  <div className="my-1 mr-3 border bg-background" style={{ marginLeft: indent + 18 }}>
                    <div className="flex h-7 items-center gap-2 border-b px-2 text-muted-foreground">
                      <span className="truncate font-mono text-xs">{path}</span>
                      <a
                        href={`https://github.com/${name}/blob/${tree?.ref ?? "HEAD"}/${path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto flex shrink-0 items-center gap-1 hover:text-foreground"
                      >
                        GitHub <ExternalLink className="size-3" />
                      </a>
                    </div>
                    {data === undefined && error === "" && (
                      <div className="flex h-7 items-center gap-2 px-2 text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> Loading…
                      </div>
                    )}
                    {error !== "" && <div className="px-2 py-1.5 text-destructive">{error}</div>}
                    {data !== undefined && data.binary && <div className="px-2 py-1.5 text-muted-foreground">Binary file, {SIZE.format(data.size)}B.</div>}
                    {data !== undefined && !data.binary && data.too_big && (
                      <div className="px-2 py-1.5 text-muted-foreground">Too big to show here ({SIZE.format(data.size)}B). Open it on GitHub.</div>
                    )}
                    {data !== undefined && data.text !== null && isMarkdown && (
                      <div className="max-h-[480px] overflow-auto px-4 py-3">
                        <Markdown text={data.text} repo={name} gitRef={tree?.ref} base={path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""} />
                      </div>
                    )}
                    {data !== undefined && data.text !== null && !isMarkdown && (
                      <div className="flex max-h-[480px] overflow-auto font-mono text-xs leading-[18px]">
                        <pre className="sticky left-0 shrink-0 border-r bg-muted px-2 py-1 text-right text-muted-foreground select-none">{numbers}</pre>
                        <pre className="px-3 py-1">{data.text}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
