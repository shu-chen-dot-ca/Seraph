/*
The whole app: a 36px header, the sidebar tree on the left, and one page on the right.
The header starts with a View menu; Reset view puts every panel, fold, sort and column back to its default.

The page lives in the URL hash, so refresh and back/forward work and switching pages never reloads:
  #/inbox  #/inbox/<draft id>  #/issues  #/issues?repo=owner/name  #/jobs  #/jobs/<job id>  #/explore  #/repos  #/tracked
  #/agents  #/agents/<agent id>  #/vms  #/vms?tab=images  #/vms/<vm name>
Links are plain <a href="#/..."> everywhere; App only reads the hash.

A VM page, once visited, stays mounted (hidden) while you are elsewhere, so its desktop iframe keeps its
connection and coming back is instant. It is dropped when that VM no longer exists.
*/

import { RotateCcw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import AgentChat from "@/AgentChat";
import Agents from "@/Agents";
import Explore from "@/Explore";
import Inbox from "@/Inbox";
import Issues from "@/Issues";
import Jobs from "@/Jobs";
import Repos from "@/Repos";
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

const PAGES = ["inbox", "issues", "jobs", "explore", "repos", "tracked", "agents", "vms"];

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
            {page === "vms" && id === null && <VMs tab={query.get("tab") === "images" ? "images" : "vms"} />}
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
      <Toaster theme={theme} position="bottom-right" />
      <TitleTooltips />
    </TooltipProvider>
  );
}
