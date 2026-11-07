/*
The Dashboard's Problems page (#/dashboard/problems): what went wrong in how the app made agents work, as the agents
reported it (report_problem, github_searcher/problems.py), so you can fix them all at one time. Not the projects' own
bugs and not the app's crashes: a rule or tool that led an agent the wrong way, or something a maintainer or you had to
correct (an agent claimed an issue someone else's pull request already closed, say).

Two tabs, with how many: Open and Closed (?state=closed). A row, newest first: the agent's report in full, under it the
issue or pull request it happened on (on GitHub), the agent (its chat) and how long ago. On Open, Close all (it asks
first; Enter confirms) closes every open one once you fixed them (POST /api/problems/close); they move to Closed. It
comes from the live "problems" topic, so a new report shows at once.
*/

import { Bot, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded } from "@/live";
import { timeAgo } from "@/lib/utils";

export default function Problems(props: { state: "open" | "closed" }) {
  const problems = useLive("problems");
  const agents = useLive("agents");
  const loaded = useLoaded("problems");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const open = problems.filter((problem) => problem.closed_at === null);
  const closed = problems.filter((problem) => problem.closed_at !== null);
  const shown = props.state === "closed" ? closed : open;

  async function closeAll() {
    try {
      const result = await api<{ closed: string[] }>("/api/problems/close", { method: "POST", body: { ids: open.map((problem) => problem.id) } });
      toast.success(`Closed ${result.closed.length} ${result.closed.length === 1 ? "problem" : "problems"}`);
    } catch (err) {
      toast.error(`Could not close them: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 items-center border-b px-3 py-1">
        <Tabs
          value={props.state}
          onValueChange={(value) => {
            window.location.hash = value === "closed" ? "#/dashboard/problems?state=closed" : "#/dashboard/problems";
          }}
        >
          <TabsList>
            <TabsTrigger value="open" className="px-2.5">
              Open <span className="text-xs text-muted-foreground tabular-nums">{loaded ? open.length : ""}</span>
            </TabsTrigger>
            <TabsTrigger value="closed" className="px-2.5">
              Closed <span className="text-xs text-muted-foreground tabular-nums">{loaded ? closed.length : ""}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {props.state === "open" && open.length > 0 && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setConfirmOpen(true)}>
            Close all
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && shown.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">{props.state === "closed" ? "No closed problems." : "No open problems."}</div>
        )}
        {shown.map((problem) => {
          const agent = agents.find((each) => each.id === problem.agent);
          return (
            <div key={problem.id} className="flex gap-3 border-b px-3 py-2.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <div className="break-words whitespace-pre-wrap">{problem.text}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
                  {problem.about !== null && (
                    <>
                      <a
                        href={`https://github.com/${problem.about.replace("#", "/issues/")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate hover:text-foreground hover:underline"
                      >
                        {problem.about}
                      </a>
                      <span>·</span>
                    </>
                  )}
                  <Bot />
                  <a href={`#/agents/${problem.agent}`} className="truncate hover:text-foreground hover:underline">
                    {agent?.name ?? problem.agent}
                  </a>
                  <span>·</span>
                  <span title={new Date(problem.at).toLocaleString()}>{timeAgo(problem.at)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {open.length === 1 ? "1 problem" : `${open.length} problems`}?</AlertDialogTitle>
            <AlertDialogDescription>Close them once they are fixed. They move to Closed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={closeAll}>Close all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
