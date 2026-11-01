/*
The whole app: a 36px header, a left list and one page on the right.
The header's left has three tabs, the open one in full color with the accent under it:
- Home: finding and doing the work, with the sidebar tree (Sidebar.tsx) on the left.
- GitHub: your work on GitHub, with its own left list (GitHubNav.tsx: Overview, Inbox, Notifications, Pull requests,
  Issues, Tasks, Your repositories, Starred, Account). The tab shows how many drafts wait in the Inbox for your decision.
- Workspace: the app's new layout, with its own left list (WorkspaceNav.tsx: Home, Pull requests; Settings). Same
  agents, jobs, VMs and Inbox; only the layout is new. Its pages are Home (Home.tsx: your repositories as cards, the
  open one like on GitHub) and Pull requests (PullRequests.tsx: your pull requests anywhere on GitHub, like
  github.com/pulls). A page it doesn't have (Issues, the GitHub tab's Overview, ...) goes to its own tab.
Each tab goes back to the last page you had open under it (Home starts at Issues, GitHub at its Overview, Workspace at
its Home); a reload forgets that. On its right: Sign in while you aren't signed in to GitHub (straight to GitHub's sign-in page once sign in is
set up, else the GitHub tab's Account page, which walks you through setting it up), or, signed in, your GitHub picture
and @login, a link to Account (GitHub.tsx), where Sign out is. Before those, in the live copy: Update once a newer
release is ready (UpdateDialog.tsx), and Restarting… while the app restarts on it. Then this repo on GitHub (a new tab, so the app stays open),
found from git's origin remote (vite.config.ts), so no account name is written here; none when it isn't on GitHub. Reset view is in Settings
(SettingsDialog), opened from the bottom of Home's sidebar.

Phone mode, on a narrow screen (under 768px, a phone): no tabs and no left list. The header's left has Menu instead
(with how many drafts wait in the Inbox) and the open page's name. Menu slides in one list with every page of all three
tabs: Home's sidebar tree, then the GitHub tab's list, then the Workspace tab's list, one under another, so a few pages
show twice. Picking a page closes it, and so does a tap beside it. The pages are the same as on a computer.

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
  Workspace: #/home  #/home?repo=owner/name (Home.tsx; the open repo, which takes tab=code|issues|pulls|commits|actions
         (none: Agents), state=closed and open=owner/name%23n like a repository's page on the GitHub tab)
         #/pulls (PullRequests.tsx; takes state=closed, view=assigned|mentioned|review-requested,
         visibility=public|private, repo=owner/name, sort=created-asc|comments-desc|comments-asc|updated-desc|updated-asc
         and open=owner/name%23n)
Anything else opens Issues. Links are plain <a href="#/..."> everywhere; App only reads the hash.

A VM page, once visited, stays mounted (hidden) while you are elsewhere, so its desktop iframe keeps its
connection and coming back is instant. It is dropped when that VM no longer exists.
*/

import { Loader2, Menu, WifiOff, X } from "lucide-react";
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
import PullRequests from "@/PullRequests";
import Repos from "@/Repos";
import Resource from "@/Resource";
import SettingsDialog, { type ThemeMode } from "@/SettingsDialog";
import Sidebar from "@/Sidebar";
import Tasks from "@/Tasks";
import Tracked from "@/Tracked";
import UpdateDialog from "@/UpdateDialog";
import VMPage from "@/VMPage";
import VMs from "@/VMs";
import Repository from "@/Repository";
import WorkspaceNav from "@/WorkspaceNav";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import TitleTooltips from "@/components/ui/title-tooltips";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, useConnected, useLive, useLiveValue, useLoaded, type GithubAccountStatus } from "@/live";
import { cn } from "@/lib/utils";

const PAGES = ["inbox", "github", "issues", "jobs", "explore", "repos", "tracked", "agents", "vms", "resource", "home", "pulls"];
// The GitHub tab's pages under #/github/; anything else there is Pull requests.
const GITHUB_SECTIONS = ["overview", "notifications", "issues", "tasks", "account", "repo"];
// The open page's name in phone mode's header, where there are no tabs and no left list to show it.
const PAGE_NAMES: Record<string, string> = {
  inbox: "Inbox",
  issues: "Issues",
  jobs: "Jobs",
  explore: "Explore",
  repos: "Repos",
  tracked: "Tracked",
  agents: "Agents",
  vms: "VMs",
  resource: "Resource",
  home: "Home",
  pulls: "Pull requests",
};
const GITHUB_NAMES: Record<string, string> = {
  overview: "Overview",
  notifications: "Notifications",
  pulls: "Pull requests",
  issues: "Issues",
  tasks: "Tasks",
  account: "Account",
  repo: "Repository",
};
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
  const [updateOpen, setUpdateOpen] = useState(false);
  // Phone mode's Menu: the list of every page, slid in from the left.
  const [menuOpen, setMenuOpen] = useState(false);
  // The last address open under each header tab, where its tab goes back to.
  const [lastHome, setLastHome] = useState("#/issues");
  const [lastGitHub, setLastGitHub] = useState("#/github/overview");
  const [lastWorkspace, setLastWorkspace] = useState("#/home");
  // Only the names: App re-renders every page under it, and the VM list changes every second.
  const vmNamesText = useLiveValue((topics) => topics.vms.map((vm) => vm.name).join(" "));
  // Only the count, for the GitHub tab.
  const pending = useLiveValue((topics) => topics.inbox.filter((draft) => draft.status === "pending").length);
  const vmsLoaded = useLoaded("vms");
  const connected = useConnected();
  // Changes only on a check or an update, so App re-renders seldom for it.
  const updates = useLive("updates");
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
      // A page was picked (also from a button, like the sidebar's + on Agents): phone mode's Menu is done.
      setMenuOpen(false);
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
  // The Workspace tab's pages, then the GitHub tab's pages; everything else is on Home.
  const onWorkspace = page === "home" || page === "pulls";
  const onGitHub = !onWorkspace && (page === "inbox" || page === "github");
  const onHome = !onWorkspace && !onGitHub;
  // Phone mode's header: the open page's name, a VM's own name on its page.
  let pageName = page === "github" ? GITHUB_NAMES[section] : PAGE_NAMES[page];
  if (page === "vms" && id !== null) {
    pageName = id;
  }

  // Keep the address for its tab (setting state while rendering, like visitedVMs below). No hash at all is Issues.
  if (onWorkspace && hash !== "" && hash !== lastWorkspace) {
    setLastWorkspace(hash);
  }
  if (onGitHub && hash !== lastGitHub) {
    setLastGitHub(hash);
  }
  if (onHome && hash !== "" && hash !== lastHome) {
    setLastHome(hash);
  }

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
          {/* Phone mode: Menu and the open page's name instead of the tabs. */}
          <button
            type="button"
            className="-ml-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            aria-label="Menu"
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="size-4" />
            {pending > 0 && (
              <span className="min-w-4.5 rounded-full bg-primary px-1.5 text-center text-xs leading-4.5 font-medium text-primary-foreground tabular-nums">
                {pending}
              </span>
            )}
          </button>
          <span className="-ml-1.5 min-w-0 truncate font-medium md:hidden">{pageName}</span>
          <div className="flex h-full items-center max-md:hidden">
            <a href={lastHome} aria-current={onHome ? "page" : undefined} className={cn(tab, onHome && currentTab)}>
              Home
            </a>
            <a
              href={lastGitHub}
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
            <a href={lastWorkspace} aria-current={onWorkspace ? "page" : undefined} className={cn(tab, onWorkspace && currentTab)}>
              Workspace
            </a>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {updates.restarting && (
              <span className="mr-2 flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Restarting…
              </span>
            )}
            {updates.ready !== null && !updates.restarting && (
              <Button size="xs" className="mr-1" onClick={() => setUpdateOpen(true)} title={`${updates.ready} is ready`}>
                Update
              </Button>
            )}
            {!connected && !updates.restarting && (
              <span className="mr-2 flex shrink-0 items-center gap-1.5 text-destructive">
                <WifiOff className="size-3.5" /> Offline<span className="max-md:hidden">, reconnecting</span>
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
                <img src={`https://github.com/${account.login}.png?size=40`} alt="" className="size-5 rounded-full" />
                {/* Phone mode: only the picture, to leave room for the page's name. */}
                <span className="max-md:hidden">@{account.login}</span>
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
          {/* The open tab's left list; phone mode has Menu instead. */}
          <div className="flex shrink-0 max-md:hidden">
            {onGitHub && <GitHubNav page={page} section={section} repo={query.get("repo")} />}
            {onHome && <Sidebar page={page} id={id} onOpenSettings={() => setSettingsOpen(true)} />}
            {onWorkspace && <WorkspaceNav page={page} onOpenSettings={() => setSettingsOpen(true)} />}
          </div>
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
                tab={query.get("tab") ?? ""}
                state={query.get("state") === "closed" ? "closed" : "open"}
                open={query.get("open")}
              />
            )}
            {page === "pulls" && (
              <PullRequests
                key={query.get("view") ?? "created"}
                state={query.get("state") === "closed" ? "closed" : "open"}
                view={query.get("view") ?? "created"}
                visibility={query.get("visibility") ?? "all"}
                repo={query.get("repo")}
                sort={query.get("sort") ?? "created-desc"}
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
      {/* Phone mode's Menu: the three tabs' left lists one under another, so every page is in it. The lists keep their
          look; here each is as wide as the menu and as tall as what it holds, and the menu scrolls as a whole. */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 animate-in bg-black/40 duration-200 ease-out fade-in-0 dark:bg-black/60" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-in overflow-y-auto overscroll-contain border-r bg-sidebar text-sidebar-foreground shadow-overlay duration-200 ease-out slide-in-from-left [&>nav]:w-full [&>nav]:border-r-0 [&>nav>div]:flex-none"
            onClick={(event) => {
              // A link closes it at once, also one to the page already open (no hashchange then).
              if ((event.target as Element).closest("a") !== null) {
                setMenuOpen(false);
              }
            }}
          >
            <div className="flex h-9 items-center gap-1.5 border-b px-3">
              <button
                type="button"
                className="-ml-1.5 flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
              >
                <X className="size-4" />
              </button>
              <span className="font-medium text-foreground">Menu</span>
            </div>
            <div className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">Home</div>
            <Sidebar
              page={page}
              id={id}
              onOpenSettings={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            />
            <div className="border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">GitHub</div>
            <GitHubNav page={page} section={section} repo={query.get("repo")} />
            <div className="border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">Workspace</div>
            <WorkspaceNav
              page={page}
              onOpenSettings={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            />
          </div>
        </div>
      )}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={theme}
        onTheme={changeTheme}
        accent={accent}
        onAccent={changeAccent}
        onResetView={resetView}
      />
      <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />
      <Toaster theme={theme} position="bottom-right" />
      <TitleTooltips />
    </TooltipProvider>
  );
}
