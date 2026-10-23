/*
The Repos list: repos the agents picked (the user never searches by hand; agents add them with a note).

Each row opens in place (RepoTree) to browse files and the README. Only the rows on screen are drawn
(react-virtual measures each row, so open rows of any height work), plus every open row wherever it is:
its RepoTree keeps what it loaded and what is unfolded while you scroll away and back. Undo / redo go through the backend,
so they also undo what an agent changed; Ctrl+Z / Ctrl+Y work when the cursor is not in a text field.
*/

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Redo2, Star, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import RepoTree from "@/RepoTree";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useLive, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const COLUMNS = "grid grid-cols-[16px_minmax(0,1fr)_72px_80px_28px] items-center gap-2";

export default function Repos() {
  const repos = useLive("repos");
  const issues = useLive("issues");
  const loaded = useLoaded("repos");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // How many listed issues each repo has.
  const issueCounts: Record<string, number> = {};
  for (const issue of issues.items) {
    issueCounts[issue.repo] = (issueCounts[issue.repo] ?? 0) + 1;
  }

  const needle = filter.trim().toLowerCase();
  const rows = repos.items.filter((repo) => {
    if (needle === "") {
      return true;
    }
    const text = `${repo.full_name} ${repo.description} ${repo.note}`.toLowerCase();
    return text.includes(needle);
  });

  const openIndexes: number[] = [];
  rows.forEach((repo, index) => {
    if (open.includes(repo.full_name)) {
      openIndexes.push(index);
    }
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 10,
    getItemKey: (index) => rows[index].full_name,
    // The rows on screen, and every open row even far off screen, so it is never unmounted.
    rangeExtractor: (range) => {
      const indexes = new Set([...defaultRangeExtractor(range), ...openIndexes]);
      return [...indexes].sort((a, b) => a - b);
    },
  });

  async function undo() {
    try {
      await api("/api/repos/undo", { method: "POST" });
    } catch (err) {
      toast.error(`Undo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function redo() {
    try {
      await api("/api/repos/redo", { method: "POST" });
    } catch (err) {
      toast.error(`Redo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(name: string) {
    try {
      await api(`/api/repos?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch (err) {
      toast.error(`Could not remove ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  function toggle(name: string) {
    setOpen((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));
  }

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z), unless typing in a field. Re-registered every render, so it sees fresh state.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey && repos.can_undo) {
        event.preventDefault();
        undo();
      } else if ((key === "y" || (key === "z" && event.shiftKey)) && repos.can_redo) {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <h1 className="font-semibold">Repos</h1>
        <span className="text-muted-foreground tabular-nums">{repos.items.length}</span>
        <Input className="ml-auto w-60" placeholder="Filter repos" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" disabled={!repos.can_undo} onClick={undo} aria-label="Undo">
              <Undo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" disabled={!repos.can_redo} onClick={redo} aria-label="Redo">
              <Redo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
        </Tooltip>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>Name</span>
        <span className="text-right">Stars</span>
        <span className="text-right">Issues</span>
        <span />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && repos.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No repos yet. Agents add repos here while they search.</div>
        )}
        {loaded && repos.items.length > 0 && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">No repo matches the filter.</div>}

        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const repo = rows[item.index];
            const isOpen = open.includes(repo.full_name);
            const count = issueCounts[repo.full_name] ?? 0;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 w-full border-b"
                style={{ top: item.start }}
              >
                <div className={cn("cursor-pointer px-3 hover:bg-accent/50", isOpen && "bg-accent/40")} onClick={() => toggle(repo.full_name)}>
                  <div className={cn(COLUMNS, "h-7")}>
                    <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                    <span className="truncate font-medium">{repo.full_name}</span>
                    <span className="flex items-center justify-end gap-1 text-muted-foreground tabular-nums">
                      <Star className="size-3.5" />
                      {STARS.format(repo.stars)}
                    </span>
                    <a
                      href={`#/issues?repo=${encodeURIComponent(repo.full_name)}`}
                      className={cn("text-right tabular-nums hover:underline", count > 0 ? "text-primary" : "text-muted-foreground")}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {count} {count === 1 ? "issue" : "issues"}
                    </a>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${repo.full_name}`}
                      title="Remove from the list"
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(repo.full_name);
                      }}
                    >
                      <X />
                    </Button>
                  </div>
                  {repo.note !== "" && <div className="-mt-1 truncate pb-1.5 pl-6 text-muted-foreground">{repo.note}</div>}
                </div>
                {isOpen && (
                  <div className="border-t bg-muted/30">
                    <RepoTree repo={repo} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
