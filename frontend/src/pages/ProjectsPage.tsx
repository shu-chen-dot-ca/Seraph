import { ChevronRight, MoreHorizontal, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import AddProjectDialog from "@/dialogs/AddProjectDialog";
import { api, useLive, type RepoGroups } from "@/live";
import { cn } from "@/lib/utils";
import { groupProjects, projectItems, useProjects } from "@/model/projects";
import { DONE_STAGES, useWorkItems } from "@/model/work";
import { href } from "@/routes";

/*
Repositories: every repository you work on, in one place. Private ones first, then Open source; in each, your groups
in their order, then the ones in no group under Ungrouped (model/projects.ts groupProjects). Each row says how many of
its issues are open and how many wait for you.
- Put one in a group: drag it onto the group, or Move to in its ⋯ menu. New group makes one (also from Move to). A
  group's ⋯ renames or deletes it; a deleted group's repositories go to Ungrouped. A group can hold both kinds: it
  shows under each.
- While you drag, the page scrolls by itself when the pointer is near its top or bottom (a fifth of the page at each
  end, faster closer to the edge, and full speed past it), so any group can be reached without letting go.
- Pin to sidebar (the pin that shows on hover, or the ⋯ menu) puts it in the left list, under Repositories. A pinned
  one shows its pin all the time.
- A click on Private, Open source or a group's name folds it away or opens it again, remembered in this browser.
Groups and pins are kept by the app (PUT /api/repo_groups), so they are the same on every device.
*/

const FOLDED_STORAGE = "repo-groups-folded";
// Scrolling while dragging: the share of the page at each end that scrolls, and the slowest and fastest step a frame.
const SCROLL_ZONE = 0.2;
const SCROLL_MIN = 3;
const SCROLL_MAX = 24;

export default function ProjectsPage() {
  const items = useWorkItems();
  const projects = useProjects(items);
  const layout = useLive("repo_groups");
  const [adding, setAdding] = useState(false);
  // The name dialog: a new group (and the repository Move to was for, if any), or the group to rename.
  const [naming, setNaming] = useState<{ rename: string | null; repo: string | null } | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  // Whether a repository is being dragged, and the group it is over.
  const [dragging, setDragging] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The groups folded in this browser. Storage can be blocked: then all start open.
  const [folded, setFolded] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FOLDED_STORAGE) ?? "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });

  function fold(key: string) {
    const next = folded.includes(key) ? folded.filter((each) => each !== key) : [...folded, key];
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_STORAGE, JSON.stringify(next));
    } catch {
      // Storage blocked: the fold just isn't kept.
    }
  }

  // While dragging: follow the pointer and scroll the page (App's <main>) each frame it is near the top or bottom.
  useEffect(() => {
    if (!dragging) {
      return;
    }
    const page = rootRef.current?.closest("main");
    let y: number | null = null;
    let frame = 0;
    function track(event: DragEvent) {
      y = event.clientY;
    }
    function step() {
      if (page && y !== null) {
        const box = page.getBoundingClientRect();
        const zone = box.height * SCROLL_ZONE;
        let depth = 0;
        if (y < box.top + zone) {
          depth = -Math.min(1, (box.top + zone - y) / zone);
        }
        if (y > box.bottom - zone) {
          depth = Math.min(1, (y - (box.bottom - zone)) / zone);
        }
        if (depth !== 0) {
          page.scrollTop += Math.sign(depth) * (SCROLL_MIN + depth * depth * (SCROLL_MAX - SCROLL_MIN));
        }
      }
      frame = requestAnimationFrame(step);
    }
    document.addEventListener("dragover", track);
    frame = requestAnimationFrame(step);
    return () => {
      document.removeEventListener("dragover", track);
      cancelAnimationFrame(frame);
    };
  }, [dragging]);

  function save(next: RepoGroups) {
    return api("/api/repo_groups", { method: "PUT", body: next });
  }

  // Into a group, or out of every group (null: Ungrouped).
  function moveTo(repo: string, group: string | null) {
    const groups = [];
    for (const each of layout.groups) {
      const repos = each.repos.filter((key) => key !== repo);
      if (each.name === group) {
        repos.push(repo);
      }
      groups.push({ name: each.name, repos: repos });
    }
    save({ groups: groups, pinned: layout.pinned }).catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }

  function togglePin(repo: string) {
    const pinned = layout.pinned.includes(repo) ? layout.pinned.filter((key) => key !== repo) : [...layout.pinned, repo];
    save({ groups: layout.groups, pinned: pinned }).catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }

  async function saveName() {
    if (naming === null) {
      return;
    }
    const groups = [];
    for (const each of layout.groups) {
      if (each.name === naming.rename) {
        groups.push({ name: name, repos: each.repos });
      } else {
        groups.push({ name: each.name, repos: each.repos.filter((key) => key !== naming.repo) });
      }
    }
    if (naming.rename === null) {
      groups.push({ name: name, repos: naming.repo !== null ? [naming.repo] : [] });
    }
    await save({ groups: groups, pinned: layout.pinned });
  }

  async function deleteGroup() {
    await save({ groups: layout.groups.filter((each) => each.name !== deleting), pinned: layout.pinned });
  }

  const sections = groupProjects(projects, layout);

  return (
    <div ref={rootRef}>
      <PageHeader
        title="Repositories"
        meta="Every repository you work on"
        right={
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setName("");
                setNaming({ rename: null, repo: null });
              }}
            >
              New group
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              Add or find projects
            </Button>
          </div>
        }
      />
      {sections.map((section) => {
        const kindOpen = !folded.includes(section.kind);
        // Group headers only when this kind has a group: else it is just its repositories.
        const headers = section.groups.some((group) => group.name !== null);
        let count = 0;
        for (const group of section.groups) {
          count += group.projects.length;
        }
        return (
          <div key={section.kind}>
            <button
              type="button"
              onClick={() => fold(section.kind)}
              className="flex w-full items-center gap-1.5 px-4 pt-4 pb-1.5 text-left text-[13px] font-semibold hover:text-primary"
            >
              {section.title}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
              <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", kindOpen && "rotate-90")} />
            </button>
            {kindOpen &&
              section.groups.map((group) => {
                const key = `${section.kind}/${group.name ?? ""}`;
                const open = !headers || !folded.includes(key);
                return (
                  <div
                    key={key}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDropOn(key);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropOn(null);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDropOn(null);
                      const repo = event.dataTransfer.getData("text/plain");
                      // Only a repository, and only into another group.
                      if (projects.some((project) => project.key === repo) && !group.projects.some((project) => project.key === repo)) {
                        moveTo(repo, group.name);
                      }
                    }}
                    className={cn(dropOn === key && "bg-accent/60")}
                  >
                    {headers && (
                      <div className="group/header flex items-center gap-1 py-1 pr-4 pl-6">
                        <button
                          type="button"
                          onClick={() => fold(key)}
                          className="flex items-center gap-1 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
                        >
                          {group.name ?? "Ungrouped"}
                          <span className="font-normal tabular-nums normal-case">{group.projects.length}</span>
                          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
                        </button>
                        {group.name !== null && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Group actions"
                                className="opacity-0 group-hover/header:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem
                                onSelect={() => {
                                  setName(group.name ?? "");
                                  setNaming({ rename: group.name, repo: null });
                                }}
                              >
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(group.name)}>
                                Delete group
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )}
                    {open &&
                      group.projects.map((project) => {
                        const work = projectItems(project, items);
                        const openIssues = work.filter((item) => !DONE_STAGES.includes(item.stage)).length;
                        const waiting = work.filter((item) => item.waiting !== null || item.waitingPR !== null).length;
                        const pinned = layout.pinned.includes(project.key);
                        return (
                          <div key={project.key} className="group/row flex items-center gap-1 border-b pr-2 hover:bg-accent">
                            <a
                              href={href.project(project.repo)}
                              draggable
                              onDragStart={(event) => {
                                event.dataTransfer.setData("text/plain", project.key);
                                event.dataTransfer.effectAllowed = "move";
                                setDragging(true);
                              }}
                              onDragEnd={() => {
                                setDragging(false);
                                setDropOn(null);
                              }}
                              className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-6"
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">{project.repo}</span>
                              {waiting > 0 && <Badge>{waiting} waiting for you</Badge>}
                              <span className="w-16 text-right text-xs text-muted-foreground">{openIssues} open</span>
                            </a>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                              onClick={() => togglePin(project.key)}
                              className={cn(!pinned && "opacity-0 group-hover/row:opacity-100 max-md:hidden")}
                            >
                              <Pin className={cn(pinned && "fill-current")} />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="Repository actions"
                                  className="opacity-0 group-hover/row:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => togglePin(project.key)}>{pinned ? "Unpin from sidebar" : "Pin to sidebar"}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>Move to</DropdownMenuLabel>
                                {layout.groups.map((each) => (
                                  <DropdownMenuItem key={each.name} disabled={each.name === group.name} onSelect={() => moveTo(project.key, each.name)}>
                                    {each.name}
                                  </DropdownMenuItem>
                                ))}
                                {group.name !== null && <DropdownMenuItem onSelect={() => moveTo(project.key, null)}>Ungrouped</DropdownMenuItem>}
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setName("");
                                    setNaming({ rename: null, repo: project.key });
                                  }}
                                >
                                  New group…
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
          </div>
        );
      })}

      {naming !== null && (
        <ConfirmDialog
          title={naming.rename !== null ? `Rename ${naming.rename}` : "New group"}
          confirm={naming.rename !== null ? "Rename" : "Create"}
          disabled={name.trim() === ""}
          onClose={() => setNaming(null)}
          onConfirm={saveName}
        >
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" maxLength={60} />
        </ConfirmDialog>
      )}
      {deleting !== null && (
        <ConfirmDialog title={`Delete ${deleting}?`} confirm="Delete group" danger onClose={() => setDeleting(null)} onConfirm={deleteGroup}>
          <p className="text-muted-foreground">Its repositories go to Ungrouped. Nothing else changes.</p>
        </ConfirmDialog>
      )}
      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
