/*
The whole app: the 36px header (shell/Header.tsx), the left list (shell/LeftList.tsx; a row of tabs at the bottom on
a phone) and one page. The page lives in the URL hash (routes.ts), so refresh and back/forward work and switching
pages never reloads. Older addresses are sent to their new place first (legacyAddress).

What each part is for:
- Inbox: what agents need from you: questions (answer first) and approvals (send or merge).
- Notifications: what GitHub told you.
- Projects: each repository you work on, private or open source, as a board from open to done; each issue on it has
  one page with its whole story (pages/WorkItemPage.tsx).
- Team: the agents and their chats. Machines: the VMs, their desktops and images.
- Settings (your picture, top right): GitHub account, when agents ask you, theme, env vars, remote access, updates.

App owns the theme and accent (Settings changes them): it puts them on <html> (class "dark", data-accent) and keeps
them in localStorage; index.html applies the saved ones before the first paint.

A VM's page, once visited, stays mounted (hidden) while you are elsewhere, so its desktop keeps its connection and
coming back is instant. It is dropped when that VM no longer exists.
*/

import { useEffect, useState } from "react";

import { Toaster } from "@/components/ui/sonner";
import TitleTooltips from "@/components/ui/title-tooltips";
import { TooltipProvider } from "@/components/ui/tooltip";
import Explore from "@/Explore";
import { useLiveValue, useLoaded } from "@/live";
import { useGithubAccount } from "@/model/account";
import InboxItemPage from "@/pages/InboxItemPage";
import InboxPage from "@/pages/InboxPage";
import MachinesPage from "@/pages/MachinesPage";
import NotificationsPage from "@/pages/NotificationsPage";
import ProjectPage from "@/pages/ProjectPage";
import ProjectsPage from "@/pages/ProjectsPage";
import SettingsPage from "@/pages/SettingsPage";
import { AgentPage, TeamPage } from "@/pages/TeamPage";
import { JobPage, WorkItemPage } from "@/pages/WorkItemPage";
import PhoneVM from "@/PhoneVM";
import { legacyAddress, parseRoute } from "@/routes";
import type { ThemeMode } from "@/settings/AppearanceSettings";
import Header from "@/shell/Header";
import LeftList from "@/shell/LeftList";
import Sherpa from "@/Sherpa";
import VMPage from "@/VMPage";

const FILLS = ["agent", "phone-vm", "find", "machines"];

function savedTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "system") {
      return saved;
    }
  } catch {
    // Storage blocked (private window): the default.
  }
  return "dark";
}

function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window): the choice just isn't kept.
  }
}

export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const [theme, setTheme] = useState<ThemeMode>(savedTheme);
  const [accent, setAccent] = useState(document.documentElement.dataset.accent ?? "blue");
  const [visitedVMs, setVisitedVMs] = useState<string[]>([]);
  const account = useGithubAccount();
  // Only the names: App re-renders every page under it, and the VM list changes every second.
  const vmNames = useLiveValue((topics) => topics.vms.map((vm) => vm.name).join(" ")).split(" ");
  const vmsLoaded = useLoaded("vms");

  useEffect(() => {
    function onHashChange() {
      const moved = legacyAddress(window.location.hash);
      if (moved !== null) {
        window.location.replace(moved);
        return;
      }
      setHash(window.location.hash);
    }
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The theme on <html>. System follows the OS, also when the OS switches while the app is open.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    }
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const route = parseRoute(hash);

  // Remember every VM page opened, so it stays mounted. (Setting state while rendering is React's pattern for state
  // derived from props; it re-renders at once, before anything is shown.)
  const openVM = route.page === "machine" ? route.name : null;
  if (openVM !== null && !visitedVMs.includes(openVM)) {
    setVisitedVMs([...visitedVMs, openVM]);
  }
  const mountedVMs = visitedVMs.filter((name) => name === openVM || !vmsLoaded || vmNames.includes(name));

  let page = null;
  if (route.page === "inbox") {
    page = <InboxPage tab={route.tab} />;
  }
  if (route.page === "inbox-item") {
    page = <InboxItemPage key={route.id} id={route.id} />;
  }
  if (route.page === "notifications") {
    page = <NotificationsPage />;
  }
  if (route.page === "projects") {
    page = <ProjectsPage />;
  }
  if (route.page === "project") {
    page = <ProjectPage key={route.repo} repo={route.repo} tab={route.tab} />;
  }
  if (route.page === "work") {
    page = <WorkItemPage key={`${route.repo}#${route.number}`} repo={route.repo} number={route.number} />;
  }
  if (route.page === "job") {
    page = <JobPage key={route.id} id={route.id} />;
  }
  if (route.page === "find") {
    page = <Explore />;
  }
  if (route.page === "team") {
    page = <TeamPage />;
  }
  if (route.page === "agent") {
    page = <AgentPage id={route.id} />;
  }
  if (route.page === "machines") {
    page = <MachinesPage tab={route.tab} />;
  }
  if (route.page === "phone-vm") {
    page = <PhoneVM />;
  }
  if (route.page === "settings") {
    page = (
      <SettingsPage
        theme={theme}
        onTheme={(next) => {
          setTheme(next);
          keep("theme", next);
        }}
        accent={accent}
        onAccent={(next) => {
          document.documentElement.dataset.accent = next;
          setAccent(next);
          keep("accent", next);
        }}
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <Header account={account} />
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <LeftList route={route} />
          <main className="relative min-h-0 min-w-0 flex-1 overflow-auto">
            {/* Pages made before the redesign (a chat, a desktop, the VM list, Find) fill the page and scroll inside;
                the others scroll here, under their sticky header. */}
            {page !== null && (
              <div key={hash.split("?")[0]} className={FILLS.includes(route.page) ? "h-full" : "min-h-full"}>
                {page}
              </div>
            )}
            {mountedVMs.map((name) => (
              <div key={name} className={name === openVM ? "h-full" : "hidden"}>
                <VMPage name={name} active={name === openVM} tab={name === openVM && route.page === "machine" ? route.tab : null} />
              </div>
            ))}
          </main>
        </div>
      </div>
      {/* Toasts sit above Sherpa's round button. */}
      <Toaster theme={theme} position="bottom-right" offset={{ bottom: 72 }} />
      <Sherpa />
      <TitleTooltips />
    </TooltipProvider>
  );
}
