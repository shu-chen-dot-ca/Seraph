import { Loader2, Plus, Search, WifiOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import AskAgentDialog from "@/dialogs/AskAgentDialog";
import FixIssueDialog from "@/dialogs/FixIssueDialog";
import NewIssueDialog from "@/dialogs/NewIssueDialog";
import { api, useConnected, useLive, type GithubAccountStatus } from "@/live";
import { askOf } from "@/model/inbox";
import { useProjects } from "@/model/projects";
import { useWorkItems } from "@/model/work";
import NewJobDialog from "@/NewJobDialog";
import { href } from "@/routes";
import UpdateDialog from "@/UpdateDialog";

/*
The 36px bar at the top of every page.
- Go to: type a name or a number to jump to an issue, a project, an agent, a VM, or something in the Inbox; Enter
  opens the first.
- New: start anything from one place: Fix an issue (pick an open one, then assign it), New issue (in one of your
  private projects), New task (anything else, for any agent), Ask an agent.
- On the right: Restarting… while the app restarts on an update, Update once a newer release is ready, Offline while
  the connection is down, then Sign in, or your GitHub picture, which opens Settings; and this repo on GitHub.
*/

// This repo on GitHub, or "": vite.config.ts puts it in from git's origin remote.
declare const __REPO_URL__: string;

type Result = { label: string; text: string; link: string };

export default function Header(props: { account: GithubAccountStatus | null }) {
  const items = useWorkItems();
  const projects = useProjects(items);
  const agents = useLive("agents");
  const vms = useLive("vms");
  const drafts = useLive("inbox");
  const updates = useLive("updates");
  const connected = useConnected();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"fix" | "issue" | "task" | "ask" | "update" | null>(null);

  const q = query.trim().toLowerCase();
  const results: Result[] = [];
  if (q !== "") {
    for (const item of items.values()) {
      if (`${item.title} ${item.repo} #${item.number} ${item.pr?.number ?? ""}`.toLowerCase().includes(q)) {
        results.push({ label: "Issue", text: `${item.repo} #${item.number} · ${item.title}`, link: href.work(item.repo, item.number) });
      }
    }
    for (const project of projects) {
      if (project.key.includes(q)) {
        results.push({ label: "Project", text: project.repo, link: href.project(project.repo) });
      }
    }
    for (const agent of agents) {
      if (agent.name.toLowerCase().includes(q) || agent.id.includes(q)) {
        results.push({ label: "Agent", text: agent.name, link: href.agent(agent.id) });
      }
    }
    for (const vm of vms) {
      if (vm.name.toLowerCase().includes(q)) {
        results.push({ label: "VM", text: vm.name, link: href.machine(vm.name) });
      }
    }
    for (const draft of drafts) {
      if (draft.status === "pending" && askOf(draft).toLowerCase().includes(q)) {
        results.push({ label: "Inbox", text: askOf(draft), link: href.inboxItem(draft.id) });
      }
    }
  }

  async function signIn() {
    if (props.account === null || !props.account.can_sign_in) {
      window.location.hash = href.settings();
      return;
    }
    try {
      const data = await api<{ url: string }>("/api/github_account/sign_in", { method: "POST" });
      window.location.href = data.url;
    } catch (err) {
      toast.error(`Could not sign in: ${err instanceof Error ? err.message : err}`);
    }
  }

  const newItems: { key: "fix" | "issue" | "task" | "ask"; label: string; line: string }[] = [
    { key: "fix", label: "Fix an issue", line: "Pick an open issue and assign it" },
    { key: "issue", label: "New issue", line: "Say what should change in one of your projects" },
    { key: "task", label: "New task", line: "Anything else, for any agent" },
    { key: "ask", label: "Ask an agent", line: "Write to any agent" },
  ];

  return (
    <header className="relative flex h-9 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
      <a href={href.inbox()} className="mr-2 font-semibold max-md:hidden">
        Seraph
      </a>
      <div className="relative mx-auto w-full max-w-sm">
        <Search className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results.length > 0) {
              window.location.hash = results[0].link;
              setQuery("");
            }
            if (event.key === "Escape") {
              setQuery("");
            }
          }}
          placeholder="Go to: an issue, project, agent or VM"
          aria-label="Go to"
          className="h-6 w-full rounded-md border bg-background pr-2 pl-7 text-[12.5px] outline-none focus-visible:border-ring"
        />
        {q !== "" && (
          <div className="absolute inset-x-0 top-7 z-40 max-h-80 overflow-auto rounded-lg border bg-popover p-1 shadow-overlay">
            {results.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">Nothing found</div>}
            {results.slice(0, 10).map((result) => (
              <a key={result.label + result.link} href={result.link} onClick={() => setQuery("")} className="flex gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                <span className="w-14 shrink-0 text-muted-foreground">{result.label}</span>
                <span className="truncate">{result.text}</span>
              </a>
            ))}
          </div>
        )}
      </div>
      <Button size="xs" onClick={() => setMenu(!menu)}>
        <Plus /> New
      </Button>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
          <div className="absolute top-8 right-12 z-40 w-64 rounded-lg border bg-popover p-1 shadow-overlay">
            {newItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  setMenu(false);
                  setDialog(item.key);
                }}
              >
                <span>{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.line}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {updates.restarting && (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Restarting…
        </span>
      )}
      {updates.ready !== null && !updates.restarting && (
        <Button size="xs" variant="outline" onClick={() => setDialog("update")} title={`${updates.ready} is ready`}>
          Update
        </Button>
      )}
      {!connected && !updates.restarting && (
        <span className="flex shrink-0 items-center gap-1.5 text-destructive">
          <WifiOff className="size-3.5" /> Offline
        </span>
      )}
      {props.account !== null && !props.account.connected && (
        <Button size="xs" variant="outline" onClick={signIn}>
          Sign in
        </Button>
      )}
      {props.account !== null && props.account.connected && (
        <a href={href.settings()} className="flex shrink-0 items-center rounded-full hover:ring-2 hover:ring-ring/40" title={`@${props.account.login} · Settings`}>
          <img src={`https://github.com/${props.account.login}.png?size=40`} alt="Settings" className="size-6 rounded-full" />
        </a>
      )}
      {props.account !== null && !props.account.connected && (
        <a href={href.settings()} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
          Settings
        </a>
      )}
      {__REPO_URL__ !== "" && (
        <a
          href={__REPO_URL__}
          target="_blank"
          rel="noreferrer"
          className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground max-md:hidden"
          title="This repo on GitHub"
          aria-label="This repo on GitHub"
        >
          {/* GitHub's mark (lucide has no brand icons). */}
          <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      )}

      {dialog === "fix" && <FixIssueDialog onClose={() => setDialog(null)} />}
      {dialog === "issue" && <NewIssueDialog onClose={() => setDialog(null)} />}
      {dialog === "task" && <NewJobDialog onClose={() => setDialog(null)} />}
      {dialog === "ask" && <AskAgentDialog onClose={() => setDialog(null)} />}
      <UpdateDialog open={dialog === "update"} onOpenChange={(open) => setDialog(open ? "update" : null)} />
    </header>
  );
}
