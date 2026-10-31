/*
The whole app: a 36px header, a left list and one page on the right.
The header's left has three tabs, the open one in full color with the accent under it:
- Home: finding and doing the work, with the sidebar tree (Sidebar.tsx) on the left.
- GitHub: your work on GitHub, with its own left list (GitHubNav.tsx: Overview, Inbox, Notifications, Pull requests,
  Issues, Tasks, Your repositories, Starred, Account). The tab shows how many drafts wait in the Inbox for your decision.
- Workspace: the app's new layout, with its own left list (WorkspaceNav.tsx: Home; Explore, Repos, Issues, Tracked;
  VMs, Images, Resource; Settings). Same agents, jobs, VMs and Inbox; only the layout is new. Its own page is Home
  (Home.tsx: your repositories as cards, the open one like on GitHub); the others it shares with the Home tab
  (WORKSPACE_SHARED), and a shared page opened while it is open stays in it (also from
  a link or button inside a page). A page it doesn't have (the GitHub tab's Overview, Account, ...) goes to its own tab.
  Clicking Home or GitHub leaves it. Whether it is open is kept for this browser tab (sessionStorage), so a reload,
  which phones do often, stays in it.
Each tab goes back to the last page you had open under it (Home starts at Issues, GitHub at its Overview, Workspace at
its Home); a reload forgets that. On its right: Sign in while you aren't signed in to GitHub (straight to GitHub's sign-in page once sign in is
set up, else the GitHub tab's Account page, which walks you through setting it up), or, signed in, your GitHub picture
and @login, a link to Account (GitHub.tsx), where Sign out is. Then this repo on GitHub (a new tab, so the app stays open),
found from git's origin remote (vite.config.ts), so no account name is written here; none when it isn't on GitHub. Reset view is in Settings
(SettingsDialog), opened from the bottom of Home's sidebar.

The page lives in the URL hash, so refresh and back/forward work and switching pages never reloads:
  Home:  #/issues  #/issues?repo=owner/name  #/issues?open=<issue id>  #/jobs  #/jobs/<job id>  #/explore  #/repos  #/tracked
         #/agents  #/agents/<agent id>  #/vms  #/vms?tab=images  #/vms?tab=defaults  #/vms/<vm name>  #/vms/<vm name>?tab=notes  #/resource
  GitHub: #/github/overview (GitHubOverview.tsx)  #/inbox  #/inbox/<draft id>  #/github/notifications (Notifications.tsx)
         #/github (= #/github/pulls)  #/github/issues  #/github/tasks (Tasks.tsx)  #/github/account
         #/github/repo?repo=owner/name (Repository.tsx)
         Pull requests and Issues take ?repo=owner/name (only that repo), state=closed (the Closed tab) and
         open=owner/name%23n (that PR or issue in its pop-up), e.g. #/github/issues?repo=owner/name&open=owner/name%2312
         One of your repositories takes tab=issues|pulls|commits|actions (none: its Code), state=closed and open=... the same
         way; Notifications takes open=... too; Tasks takes state=done (its Done tab), view=recent (its Recent
         tab), task=owner/name%23n (that task in its pop-up) and open=....
  Workspace: #/home  #/home?repo=owner/name (Home.tsx; the open repo, which takes tab=issues|pulls|commits|actions,
         state=closed and open=owner/name%23n like a repository's page on the GitHub tab)
Anything else opens Issues. Links are plain <a href="#/..."> everywhere; App only reads the hash.

A VM page, once visited, stays mounted (hidden) while you are elsewhere, so its desktop iframe keeps its
connection and coming back is instant. It is dropped when that VM no longer exists.
*/

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import AgentChat from "@/AgentChat";
import Agents from "@/Agents";
import Explore from "@/Explore";
import GitHub from "@/GitHub";
import GitHubNav from "@/GitHubNav";
import GitHubOverview from "@/GitHubOverview";
import Home from "@/Home";
import Inbox from "@/Inbox";
import Issues from "@/Issues";
import Jobs from "@/Jobs";
import Notifications from "@/Notifications";
import Repos from "@/Repos";
import Resource from "@/Resource";
import SettingsDialog, { type ThemeMode } from "@/SettingsDialog";
import Sidebar from "@/Sidebar";
import Tasks from "@/Tasks";
import Tracked from "@/Tracked";
import VMPage from "@/VMPage";
import VMs from "@/VMs";
import Repository from "@/Repository";
import WorkspaceNav from "@/WorkspaceNav";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import TitleTooltips from "@/components/ui/title-tooltips";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, useConnected, useLiveValue, useLoaded, type GithubAccountStatus } from "@/live";
import { cn } from "@/lib/utils";

const PAGES = ["inbox", "github", "issues", "jobs", "explore", "repos", "tracked", "agents", "vms", "resource", "home"];
// The Home tab's pages the Workspace tab shows too: the ones in its left list.
const WORKSPACE_SHARED = ["issues", "explore", "repos", "tracked", "vms", "resource"];
// The GitHub tab's pages under #/github/; anything else there is Pull requests.
const GITHUB_SECTIONS = ["overview", "notifications", "issues", "tasks", "account", "repo"];
// This repo on GitHub, or "": vite.config.ts puts it in from git's origin remote.
declare const __REPO_URL__: string;

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
  // The last address open under each header tab, where its tab goes back to.
  const [lastHome, setLastHome] = useState("#/issues");
  const [lastGitHub, setLastGitHub] = useState("#/github/overview");
  const [lastWorkspace, setLastWorkspace] = useState("#/home");
  // Whether the Workspace tab is open, kept for this browser tab so a reload stays in it.
  const [workspace, setWorkspace] = useState(() => {
    try {
      return sessionStorage.getItem("workspace") === "open";
    } catch {
      // Storage blocked (private window): a reload goes back to Home or GitHub.
      return false;
    }
  });
  // Only the names: App re-renders every page under it, and the VM list changes every second.
  const vmNamesText = useLiveValue((topics) => topics.vms.map((vm) => vm.name).join(" "));
  // Only the count, for the GitHub tab.
  const pending = useLiveValue((topics) => topics.inbox.filter((draft) => draft.status === "pending").length);
  const vmsLoaded = useLoaded("vms");
  const connected = useConnected();
  // Who you are signed in to GitHub as, for the header's right. The Account page (GitHub.tsx) signs you in and out.
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);

  useEffect(() => {
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then(setAccount)
        .catch(() => {});
    }
    load();
    window.addEventListener("github-account", load);
    return () => window.removeEventListener("github-account", load);
  }, []);

  // The header's Sign in: straight to GitHub's sign-in page when sign in is set up, else the Account page to set it up.
  async function signIn() {
    if (account === null || !account.can_sign_in) {
      window.location.hash = "#/github/account";
      return;
    }
    try {
      const data = await api<{ url: string }>("/api/github_account/sign_in", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      toast.error(`Could not sign in: ${err instanceof Error ? err.message : err}`);
    }
  }

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
  // GitHub's section: "#/github/issues" → "issues", "#/github" → "pulls".
  const section = id !== null && GITHUB_SECTIONS.includes(id) ? id : "pulls";
  // The Workspace tab: its own page always, and the pages it shares while it is open (setting state while rendering,
  // like visitedVMs below). Then the GitHub tab's pages; everything else is on Home.
  const onWorkspace = page === "home" || (workspace && WORKSPACE_SHARED.includes(page));
  if (onWorkspace !== workspace) {
    setWorkspace(onWorkspace);
  }
  const onGitHub = !onWorkspace && (page === "inbox" || page === "github");
  const onHome = !onWorkspace && !onGitHub;

  // Keep the address for its tab. No hash at all is Issues.
  if (onWorkspace && hash !== "" && hash !== lastWorkspace) {
    setLastWorkspace(hash);
  }
  if (onGitHub && hash !== lastGitHub) {
    setLastGitHub(hash);
  }
  if (onHome && hash !== "" && hash !== lastHome) {
    setLastHome(hash);
  }

  useEffect(() => {
    try {
      sessionStorage.setItem("workspace", workspace ? "open" : "closed");
    } catch {
      // Storage blocked (private window): a reload goes back to Home or GitHub.
    }
  }, [workspace]);

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

  // The header's tabs, like line tabs (components/ui/tabs.tsx): quiet until hovered; the open one in full color with
  // the accent under it, over the header's border. Only the open one has aria-current.
  const tab = "relative flex h-full items-center gap-1.5 px-2 font-medium text-muted-foreground hover:text-foreground";
  const currentTab = "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary";

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b bg-sidebar px-3">
          <div className="flex h-full items-center">
            {/* A tab's click sets its tab and hash at once, so the page under the click (a Workspace one) can't keep
                the Workspace tab open before the hashchange comes. */}
            <a
              href={lastHome}
              onClick={() => {
                setWorkspace(false);
                setHash(lastHome);
              }}
              aria-current={onHome ? "page" : undefined}
              className={cn(tab, onHome && currentTab)}
            >
              Home
            </a>
            <a
              href={lastGitHub}
              onClick={() => {
                setWorkspace(false);
                setHash(lastGitHub);
              }}
              aria-current={onGitHub ? "page" : undefined}
              className={cn(tab, onGitHub && currentTab)}
              title={pending > 0 ? `${pending} ${pending === 1 ? "draft waits" : "drafts wait"} in the Inbox for your decision` : undefined}
            >
              GitHub
              {/* Like the Inbox's own count: a filled pill, like unread mail. */}
              {pending > 0 && (
                <span className="min-w-4.5 rounded-full bg-primary px-1.5 text-center text-xs leading-4.5 font-medium text-primary-foreground tabular-nums">
                  {pending}
                </span>
              )}
            </a>
            <a
              href={lastWorkspace}
              onClick={() => {
                setWorkspace(true);
                setHash(lastWorkspace);
              }}
              aria-current={onWorkspace ? "page" : undefined}
              className={cn(tab, onWorkspace && currentTab)}
            >
              Workspace
            </a>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {!connected && (
              <span className="mr-2 flex items-center gap-1.5 text-destructive">
                <WifiOff className="size-3.5" /> Offline, reconnecting
              </span>
            )}
            {account !== null && !account.connected && (
              <Button size="xs" variant="outline" className="mr-1" onClick={signIn}>
                Sign in
              </Button>
            )}
            {account !== null && account.connected && (
              <a
                href="#/github/account"
                className="mr-1 flex h-7 items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Your GitHub account"
              >
                <img src={`https://github.com/${account.login}.png?size=40`} alt="" className="size-5 rounded-full" />@{account.login}
              </a>
            )}
            {__REPO_URL__ !== "" && (
              <a
                href={__REPO_URL__}
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
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {onGitHub && <GitHubNav page={page} section={section} repo={query.get("repo")} />}
          {onHome && <Sidebar page={page} id={id} onOpenSettings={() => setSettingsOpen(true)} />}
          {onWorkspace && <WorkspaceNav page={page} vmTab={query.get("tab")} onOpenSettings={() => setSettingsOpen(true)} />}
          <main className="relative min-w-0 flex-1 overflow-hidden">
            {page === "inbox" && <Inbox selected={id} />}
            {page === "github" && section === "overview" && <GitHubOverview />}
            {page === "github" && section === "notifications" && <Notifications open={query.get("open")} />}
            {page === "github" && section === "tasks" && <Tasks state={query.get("state") ?? ""} view={query.get("view") ?? ""} task={query.get("task")} open={query.get("open")} />}
            {page === "github" && section === "repo" && (
              <Repository
                key={query.get("repo") ?? ""}
                repo={query.get("repo") ?? ""}
                tab={query.get("tab") ?? "overview"}
                state={query.get("state") === "closed" ? "closed" : "open"}
                open={query.get("open")}
              />
            )}
            {page === "github" && (section === "pulls" || section === "issues" || section === "account") && (
              <GitHub
                key={section}
                section={section}
                repo={query.get("repo")}
                state={query.get("state") === "closed" ? "closed" : "open"}
                open={query.get("open")}
              />
            )}
            {page === "issues" && <Issues repo={query.get("repo")} open={query.get("open")} />}
            {page === "jobs" && <Jobs selected={id} />}
            {page === "explore" && <Explore />}
            {page === "repos" && <Repos />}
            {page === "tracked" && <Tracked />}
            {page === "agents" && id === null && <Agents />}
            {page === "agents" && id !== null && <AgentChat key={id} agentId={id} />}
            {page === "home" && (
              <Home
                repo={query.get("repo")}
                tab={query.get("tab") ?? "code"}
                state={query.get("state") === "closed" ? "closed" : "open"}
                open={query.get("open")}
              />
            )}
            {page === "vms" && id === null && (
              <VMs tab={query.get("tab") === "images" ? "images" : query.get("tab") === "defaults" ? "defaults" : "vms"} />
            )}
            {page === "resource" && <Resource />}
            {mountedVMs.map((name) => (
              <div key={name} className={name === openVM ? "h-full" : "hidden"}>
                <VMPage name={name} active={name === openVM} tab={name === openVM ? query.get("tab") : null} />
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
        onResetView={resetView}
      />
      <Toaster theme={theme} position="bottom-right" />
      <TitleTooltips />
    </TooltipProvider>
  );
}
