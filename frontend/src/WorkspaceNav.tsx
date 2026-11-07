/*
The Workspace part of the Home tab's left list (Sidebar.tsx shows it under its Workspace heading, with the same rows).
Every line is a link to a page; the open one is marked:
- Home (Home.tsx): your repositories as cards, and the open one's page like on GitHub (code, issues, pull requests,
  commits, actions).
- Pull requests (PullRequests.tsx): your pull requests anywhere on GitHub, open and closed, like github.com/pulls.
- Papers (Papers.tsx): research papers you gave agents to reproduce, and their reports.
- VM (PhoneVM.tsx), only in phone mode: one VM desktop to use yourself from the phone, with keys under it.
*/

import { FileText, GitPullRequest, House, Monitor } from "lucide-react";

import { cn } from "@/lib/utils";

export default function WorkspaceNav(props: { page: string }) {
  // The same rows as the sidebar's (Sidebar.tsx).
  const row = "flex h-8 w-full items-center gap-2 rounded-md px-2 pl-6 font-medium hover:bg-sidebar-accent hover:text-foreground";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>svg]:text-primary";
  const icon = "size-4 shrink-0 text-muted-foreground";

  return (
    <>
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
    </>
  );
}
