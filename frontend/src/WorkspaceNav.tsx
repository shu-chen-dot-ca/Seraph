/*
The Workspace tab's left list: App shows it instead of the sidebar tree on the Workspace tab, with the same look as the
sidebar (Sidebar.tsx). The Workspace tab is the app's new layout; it uses the same agents, jobs, VMs and Inbox as the
Home and GitHub tabs, nothing works differently there. Every line is a link to a page; the open one is marked:
- Home (Home.tsx): your repositories as cards, and the open one's page like on GitHub (code, issues, pull requests,
  commits, actions).
- Pull requests (PullRequests.tsx): your pull requests anywhere on GitHub, open and closed, like github.com/pulls.
- Papers (Papers.tsx): research papers you gave agents to reproduce, and their reports.
- VM (PhoneVM.tsx), only in phone mode: one VM desktop to use yourself from the phone, with keys under it.
- Settings, pinned at the bottom, opens Settings (SettingsDialog), the same as at the bottom of the Home tab's sidebar.
On a narrow screen (a phone) it is in phone mode's Menu instead (App.tsx), under the other two tabs' lists.
*/

import { FileText, GitPullRequest, House, Monitor, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

export default function WorkspaceNav(props: { page: string; onOpenSettings: () => void }) {
  // The same rows as the sidebar's (Sidebar.tsx).
  const row = "flex h-8 w-full items-center gap-2 rounded-md px-2 font-medium hover:bg-sidebar-accent hover:text-foreground";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>svg]:text-primary";
  const icon = "size-4 shrink-0 text-muted-foreground";

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <a href="#/home" className={cn(row, props.page === "home" && selected)}>
          <House className={icon} />
          Home
        </a>

        <a href="#/pulls" className={cn(row, props.page === "pulls" && selected)}>
          <GitPullRequest className={icon} />
          Pull requests
        </a>

        <a href="#/papers" className={cn(row, props.page === "papers" && selected)}>
          <FileText className={icon} />
          Papers
        </a>

        <a href="#/vm" className={cn(row, "md:hidden", props.page === "vm" && selected)}>
          <Monitor className={icon} />
          VM
        </a>
      </div>

      <div className="border-t p-2">
        <button type="button" className={row} onClick={props.onOpenSettings}>
          <Settings className={icon} />
          Settings
        </button>
      </div>
    </nav>
  );
}
