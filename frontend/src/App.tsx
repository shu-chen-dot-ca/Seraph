/*
The whole app: a 36px header, the sidebar tree on the left, and one page on the right.
The header starts with a View menu; Reset view puts every panel, fold, sort and column back to its default.
On its right: this repo on GitHub (a new tab, so the app stays open). Sherpa's round button sits at the bottom
right of every page (Sherpa.tsx).

The page lives in the URL hash, so refresh and back/forward work and switching pages never reloads:
  #/inbox  #/inbox/<draft id>  #/issues  #/issues?repo=owner/name  #/jobs  #/jobs/<job id>  #/explore  #/repos  #/tracked
  #/agents  #/agents/<agent id>  #/vms  #/vms?tab=images  #/vms?tab=defaults  #/vms/<vm name>  #/resource  #/resource/gpu
Links are plain <a href="#/..."> everywhere; App only reads the hash.

A VM page, once visited, stays mounted (hidden) while you are elsewhere, so its desktop iframe keeps its
connection and coming back is instant. It is dropped when that VM no longer exists.
*/

import { RotateCcw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import AgentChat from "@/AgentChat";
import Agents from "@/Agents";
import Explore from "@/Explore";
import Sherpa from "@/Sherpa";
import Inbox from "@/Inbox";
import Issues from "@/Issues";
import Jobs from "@/Jobs";
import Repos from "@/Repos";
import Resource from "@/Resource";
import SettingsDialog, { type ThemeMode } from "@/SettingsDialog";
import Sidebar from "@/Sidebar";
import Tracked from "@/Tracked";
import VMPage from "@/VMPage";
import VMs from "@/VMs";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import TitleTooltips from "@/components/ui/title-tooltips";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useConnected, useLiveValue, useLoaded } from "@/live";

const PAGES = ["inbox", "issues", "jobs", "explore", "repos", "tracked", "agents", "vms", "resource"];
const GITHUB_URL = "https://github.com/shu-chen-dot-ca/seraph";

export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const [visitedVMs, setVisitedVMs] = useState<string[]>([]);
  // Theme and accent color, picked in Settings. index.html already put the saved ones on <html> before the first paint.
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem("theme");
      if (saved === "light" || saved === "system") {
        return saved;
      }
    } catch {
      // Storage blocked (private window): the default.
    }
    return "dark";
  });
  const [accent, setAccent] = useState(document.documentElement.dataset.accent ?? "blue");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Only the names: App re-renders every page under it, and the VM list changes every second.
  const vmNamesText = useLiveValue((topics) => topics.vms.map((vm) => vm.name).join(" "));
  const vmsLoaded = useLoaded("vms");
  const connected = useConnected();

  useEffect(() => {
    function onHashChange() {
      setHash(window.location.hash);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // "#/vms/vm1?x=y" → page "vms", id "vm1", query "x=y". Anything unknown opens Issues.
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const parts = pathPart.split("/");
  const page = PAGES.includes(parts[0]) ? parts[0] : "issues";
  const id = parts.length > 1 && parts[1] !== "" ? decodeURIComponent(parts.slice(1).join("/")) : null;
  const query = new URLSearchParams(queryPart ?? "");

  // Remember every VM page opened, so it stays mounted. (Setting state while rendering is React's
  // pattern for state derived from props; it re-renders at once, before anything is shown.)
  const openVM = page === "vms" && id !== null ? id : null;
  if (openVM !== null && !visitedVMs.includes(openVM)) {
    setVisitedVMs([...visitedVMs, openVM]);
  }
  const vmNames = vmNamesText.split(" ");
  const mountedVMs = visitedVMs.filter((name) => name === openVM || !vmsLoaded || vmNames.includes(name));

  // Put the theme on <html>. System follows the OS, also when the OS switches while the app is open.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    }
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  function changeTheme(next: ThemeMode) {
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage blocked (private window): the choice just isn't kept.
    }
  }

  function changeAccent(next: string) {
    document.documentElement.dataset.accent = next;
    setAccent(next);
    try {
      localStorage.setItem("accent", next);
    } catch {
      // Storage blocked (private window): the choice just isn't kept.
    }
  }

  // Panel sizes and sidebar folds only live in memory, so a reload resets them. The Repos sort and columns are
  // kept in localStorage (the keys in Repos.tsx), so forget those first. Theme and accent are settings: they stay.
  function resetView() {
    try {
      localStorage.removeItem("repos-sort");
      localStorage.removeItem("repos-columns-2");
    } catch {
      // Storage blocked (private window): nothing was kept, the reload alone resets.
    }
    window.location.reload();
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b bg-sidebar px-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                View
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={resetView}>
                <RotateCcw /> Reset view
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="ml-auto flex items-center gap-1">
            {!connected && (
              <span className="mr-2 flex items-center gap-1.5 text-destructive">
                <WifiOff className="size-3.5" /> Offline, reconnecting
              </span>
            )}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              title="This repo on GitHub"
              aria-label="This repo on GitHub"
            >
              {/* GitHub's mark (lucide has no brand icons). */}
              <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </a>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <Sidebar page={page} id={id} onOpenSettings={() => setSettingsOpen(true)} />
          <main className="relative min-w-0 flex-1 overflow-hidden">
            {page === "inbox" && <Inbox selected={id} />}
            {page === "issues" && <Issues key={query.get("open") ?? ""} repo={query.get("repo")} open={query.get("open")} />}
            {page === "jobs" && <Jobs key={id ?? ""} selected={id} />}
            {page === "explore" && <Explore />}
            {page === "repos" && <Repos />}
            {page === "tracked" && <Tracked />}
            {page === "agents" && id === null && <Agents />}
            {page === "agents" && id !== null && <AgentChat key={id} agentId={id} />}
            {page === "vms" && id === null && (
              <VMs tab={query.get("tab") === "images" ? "images" : query.get("tab") === "defaults" ? "defaults" : "vms"} />
            )}
            {page === "resource" && <Resource selected={id} />}
            {mountedVMs.map((name) => (
              <div key={name} className={name === openVM ? "h-full" : "hidden"}>
                <VMPage name={name} active={name === openVM} />
              </div>
            ))}
          </main>
        </div>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={theme}
        onTheme={changeTheme}
        accent={accent}
        onAccent={changeAccent}
      />
      {/* Toasts sit above Sherpa's round button. */}
      <Toaster theme={theme} position="bottom-right" offset={{ bottom: 72 }} />
      <Sherpa />
      <TitleTooltips />
    </TooltipProvider>
  );
}
