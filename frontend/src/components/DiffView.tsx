import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

/*
A change as files: each file's name, how many lines it adds and removes, and its lines with their numbers, added in
green and removed in red. New, deleted, renamed and binary files say so. A file that changes more than 400 lines
starts folded. Parsed once per diff (git's unified format, as drafts and Workflow PRs carry it).
*/

type DiffLine = { kind: "hunk" | "add" | "del" | "context" | "note"; text: string; oldNo: number | null; newNo: number | null };
type DiffFile = { path: string; oldPath: string; status: "modified" | "added" | "deleted" | "renamed" | "binary"; added: number; removed: number; lines: DiffLine[] };

function parseDiff(diff: string): DiffFile[] {
  const result: DiffFile[] = [];
  let file: DiffFile | null = null;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    // "diff --git a/x b/y" starts a file. Its name may be corrected below by "+++ b/..." or "rename to".
    if (line.startsWith("diff --git ")) {
      const names = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { path: names !== null ? names[2] : line.slice(11), oldPath: names !== null ? names[1] : "", status: "modified", added: 0, removed: 0, lines: [] };
      result.push(file);
      inHunk = false;
      continue;
    }
    if (file === null) {
      continue;
    }
    if (line.startsWith("@@")) {
      const numbers = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = numbers !== null ? Number(numbers[1]) : 0;
      newNo = numbers !== null ? Number(numbers[2]) : 0;
      inHunk = true;
      file.lines.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    // The file's header lines, before its first hunk.
    if (!inHunk) {
      if (line.startsWith("new file mode")) {
        file.status = "added";
      } else if (line.startsWith("deleted file mode")) {
        file.status = "deleted";
      } else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = line.slice(12);
      } else if (line.startsWith("rename to ")) {
        file.path = line.slice(10);
      } else if (line.startsWith("Binary files ")) {
        file.status = "binary";
      } else if (line.startsWith("+++ b/")) {
        file.path = line.slice(6);
      } else if (line.startsWith("--- a/")) {
        file.oldPath = line.slice(6);
      }
      continue;
    }
    if (line.startsWith("+")) {
      file.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo });
      newNo += 1;
      file.added += 1;
    } else if (line.startsWith("-")) {
      file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo, newNo: null });
      oldNo += 1;
      file.removed += 1;
    } else if (line.startsWith("\\")) {
      file.lines.push({ kind: "note", text: line, oldNo: null, newNo: null });
    } else {
      file.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo, newNo: newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  return result;
}

const STATUS_TEXT: Record<DiffFile["status"], string> = { modified: "", added: "new", deleted: "deleted", renamed: "renamed", binary: "binary" };

function FileDiff(props: { file: DiffFile }) {
  const [open, setOpen] = useState(props.file.added + props.file.removed <= 400);
  const file = props.file;
  return (
    <div className="overflow-hidden rounded-md border">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-muted px-3 py-1.5 text-left font-mono text-xs hover:bg-accent">
        <span className="min-w-0 flex-1 truncate">
          {file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path}
          {STATUS_TEXT[file.status] !== "" && <span className="ml-2 text-muted-foreground">{STATUS_TEXT[file.status]}</span>}
        </span>
        <span className="text-ok">+{file.added}</span>
        <span className="text-destructive">−{file.removed}</span>
      </button>
      {open && file.lines.length > 0 && (
        <div className="overflow-x-auto font-mono text-[11.5px] leading-5">
          {file.lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                "grid min-w-max grid-cols-[40px_40px_minmax(0,1fr)]",
                line.kind === "add" && "bg-ok/10",
                line.kind === "del" && "bg-destructive/10",
                line.kind === "hunk" && "bg-muted text-muted-foreground",
                line.kind === "note" && "text-muted-foreground",
              )}
            >
              <span className="pr-2 text-right text-muted-foreground select-none">{line.oldNo ?? ""}</span>
              <span className="pr-2 text-right text-muted-foreground select-none">{line.newNo ?? ""}</span>
              <span className="pr-3 whitespace-pre">
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                {line.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DiffView(props: { diff: string }) {
  const files = useMemo(() => parseDiff(props.diff), [props.diff]);
  if (files.length === 0) {
    return <p className="text-muted-foreground">No changes.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {files.map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}
    </div>
  );
}
