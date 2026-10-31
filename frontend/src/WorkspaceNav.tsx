/*
The Workspace tab's left list: App shows it instead of the sidebar tree on the Workspace tab, with the same look as the
sidebar (Sidebar.tsx). The Workspace tab is the app's new layout; it uses the same agents, jobs, VMs and Inbox as the
Home and GitHub tabs, nothing works differently there. Every line is a link to a page; the open one is marked:
- Home (Home.tsx): your repositories as cards, and the open one's page like on GitHub (code, issues, pull requests,
  commits, actions).
- Under Open source, the pages that find work on other people's projects, the same as on the Home tab: Explore, Repos,
  Issues and Tracked.
- Under Machines: VMs (also marked on a VM's page), Images (the VMs page's Images tab) and Resource.
- Settings, pinned at the bottom, opens Settings (SettingsDialog), the same as at the bottom of the Home tab's sidebar.
On a narrow screen (a phone) the list is a thin column: each line is its icon with its name small under it, and the
headings are left out.
*/

import { CircleDot, Compass, Eye, FolderGit2, Gauge, House, Layers, Monitor, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

export default function WorkspaceNav(props: { page: string; vmTab: string | null; onOpenSettings: () => void }) {
  // The same rows as the sidebar's (Sidebar.tsx). On a narrow screen: the icon, its name small under it.
  const row =
    "flex h-8 w-full items-center gap-2 rounded-md px-2 font-medium hover:bg-sidebar-accent hover:text-foreground max-md:h-auto max-md:flex-col max-md:gap-0.5 max-md:px-0 max-md:py-1.5 max-md:text-[10px]";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>svg]:text-primary";
  const heading = "px-2 pb-1 text-xs font-medium text-muted-foreground max-md:hidden";
  const icon = "size-4 shrink-0 text-muted-foreground";

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none max-md:w-16">
      <div className="min-h-0 flex-1 overflow-y-auto p-2 max-md:px-1">
        <a href="#/home" className={cn(row, props.page === "home" && selected)}>
          <House className={icon} />
          Home
        </a>

        <div className="mx-1 my-2 border-t" />
        <div className={heading}>Open source</div>

        <a href="#/explore" className={cn(row, props.page === "explore" && selected)}>
          <Compass className={icon} />
          Explore
        </a>

        <a href="#/repos" className={cn(row, props.page === "repos" && selected)}>
          <FolderGit2 className={icon} />
          Repos
        </a>

        <a href="#/issues" className={cn(row, props.page === "issues" && selected)}>
          <CircleDot className={icon} />
          Issues
        </a>

        <a href="#/tracked" className={cn(row, props.page === "tracked" && selected)}>
          <Eye className={icon} />
          Tracked
        </a>

        <div className="mx-1 my-2 border-t" />
        <div className={heading}>Machines</div>

        <a href="#/vms" className={cn(row, props.page === "vms" && props.vmTab !== "images" && selected)}>
          <Monitor className={icon} />
          VMs
        </a>

        <a href="#/vms?tab=images" className={cn(row, props.page === "vms" && props.vmTab === "images" && selected)}>
          <Layers className={icon} />
          Images
        </a>

        <a href="#/resource" className={cn(row, props.page === "resource" && selected)}>
          <Gauge className={icon} />
          Resource
        </a>
      </div>

      <div className="border-t p-2 max-md:px-1">
        <button type="button" className={row} onClick={props.onOpenSettings}>
          <Settings className={icon} />
          Settings
        </button>
      </div>
    </nav>
  );
}
