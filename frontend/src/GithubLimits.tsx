/*
GitHub's rate limits as bars, in the Explore page's top bar between the run controls and Profile: one per kind of request (search, GraphQL, REST, code search), over
all the tokens in .env together (github_searcher/token_balancer.py). Each bar is what is left of the quota: gray when
there is plenty (so it doesn't pull the eye from the Start button), amber under 30%, red under 10%, with the percent left next to it. Hovering one lists each token in
its tooltip, with how much is left, when its quota fills up again, and whether GitHub paused it (a secondary limit).

The numbers come from the live feed after every GitHub request; this component alone re-renders for them, and ticks
every second so a quota counts as full again on time. A quota whose reset time has passed counts as full: GitHub filled it again.
*/

import { useEffect, useState } from "react";

import { useLive, type GithubKind } from "@/live";
import { cn } from "@/lib/utils";

const KINDS: { kind: GithubKind; label: string }[] = [
  { kind: "search", label: "Search" },
  { kind: "graphql", label: "GraphQL" },
  { kind: "core", label: "REST" },
  { kind: "code_search", label: "Code search" },
];

export default function GithubLimits() {
  const github = useLive("github");
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (github === null) {
    return <span className="text-muted-foreground">GitHub limits: not known yet</span>;
  }

  const now = Date.now();
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
      {KINDS.map(({ kind, label }) => {
        const status = github[kind];
        let remaining = 0;
        let limit = 0;
        const lines: string[] = [];
        for (const token of status.tokens) {
          const reset = token.reset_at !== null && new Date(token.reset_at).getTime() > now ? token.reset_at : null;
          if (token.limit === null) {
            lines.push(`${token.name}: not used yet`);
            continue;
          }
          // Past its reset time the quota is full again, whatever was last seen.
          const left = reset === null ? token.limit : (token.remaining ?? token.limit);
          remaining += left;
          limit += token.limit;
          let line = `${token.name}: ${left} of ${token.limit} left`;
          if (reset !== null && left < token.limit) {
            const seconds = Math.max(0, Math.round((new Date(reset).getTime() - now) / 1000));
            line += `, full again in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
          }
          if (token.paused_until !== null && new Date(token.paused_until).getTime() > now) {
            const seconds = Math.max(0, Math.round((new Date(token.paused_until).getTime() - now) / 1000));
            line += `, paused for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
          }
          if (token.running > 0) {
            line += `, ${token.running} running`;
          }
          lines.push(line);
        }
        const share = limit > 0 ? remaining / limit : 1;
        const color = share < 0.1 ? "bg-destructive" : share < 0.3 ? "bg-warn" : "bg-muted-foreground/70";
        const percent = Math.round(share * 100);
        return (
          <span key={kind} className="flex items-center gap-2" title={[`${label}: ${percent}% left`, ...lines].join("\n")}>
            <span className="text-muted-foreground">{label}</span>
            <span className="h-2 w-28 overflow-hidden rounded-full bg-muted">
              <span className={cn("block h-full rounded-full transition-[width,background-color] duration-500", color)} style={{ width: `${percent}%` }} />
            </span>
            <span className="-ml-0.5 w-9 text-xs text-muted-foreground tabular-nums">{percent}%</span>
          </span>
        );
      })}
    </div>
  );
}
