/*
The whole app: a 36px header, the sidebar tree on the left, and one page on the right.

The page lives in the URL hash, so refresh and back/forward work and switching pages never reloads:
  #/inbox  #/inbox/<draft id>  #/issues  #/issues?repo=owner/name  #/jobs  #/jobs/<job id>  #/repos  #/tracked
  #/agents  #/agents/<agent id>  #/vms  #/vms?tab=images  #/vms/<vm name>
Links are plain <a href="#/..."> everywhere; App only reads the hash.

A VM page, once visited, stays mounted (hidden) while you are elsewhere, so its desktop iframe keeps its
connection and coming back is instant. It is dropped when that VM no longer exists.
*/

import { Inbox as InboxIcon, Monitor, Moon, Sun, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import AgentChat from "@/AgentChat";
import Agents from "@/Agents";
import Inbox from "@/Inbox";
import Issues from "@/Issues";
import Jobs from "@/Jobs";
import Repos from "@/Repos";
import Sidebar from "@/Sidebar";
import Tracked from "@/Tracked";
import VMPage from "@/VMPage";
import VMs from "@/VMs";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnected, useLiveValue, useLoaded } from "@/live";

const PAGES = ["inbox", "issues", "jobs", "repos", "tracked", "agents", "vms"];

export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const [visitedVMs, setVisitedVMs] = useState<string[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(document.documentElement.classList.contains("dark") ? "dark" : "light");
  // Only counts and names: App re-renders every page under it, and the VM list changes every second.
  const pending = useLiveValue((topics) => topics.inbox.filter((draft) => draft.status === "pending").length);
  const running = useLiveValue((topics) => topics.vms.filter((vm) => vm.status === "running").length);
  const vmCount = useLiveValue((topics) => topics.vms.length);
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

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage blocked (private window): the choice just isn't kept.
    }
    setTheme(next);
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b bg-sidebar px-3">
          <a href="#/issues" className="font-semibold tracking-tight">
            Searcher
          </a>
          <div className="ml-auto flex items-center gap-1">
            {!connected && (
              <span className="mr-2 flex items-center gap-1.5 text-destructive">
                <WifiOff className="size-3.5" /> Offline, reconnecting
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <a href="#/inbox" className="flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-accent">
                  <InboxIcon className="size-4 text-muted-foreground" />
                  <span className={pending > 0 ? "font-medium text-foreground" : "text-muted-foreground"}>{pending}</span>
                </a>
              </TooltipTrigger>
              <TooltipContent>Inbox: {pending} waiting for you</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <a href="#/vms" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-accent">
                  <Monitor className="size-4" />
                  <span className="tabular-nums">
                    {running}/{vmCount}
                  </span>
                </a>
              </TooltipTrigger>
              <TooltipContent>VMs running / total</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
                  {theme === "dark" ? <Sun /> : <Moon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{theme === "dark" ? "Light mode" : "Dark mode"}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <Sidebar page={page} id={id} />
          <main className="relative min-w-0 flex-1 overflow-hidden">
            {page === "inbox" && <Inbox selected={id} />}
            {page === "issues" && <Issues key={query.get("open") ?? ""} repo={query.get("repo")} open={query.get("open")} />}
            {page === "jobs" && <Jobs key={id ?? ""} selected={id} />}
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
      <Toaster theme={theme} position="bottom-right" />
    </TooltipProvider>
  );
}
