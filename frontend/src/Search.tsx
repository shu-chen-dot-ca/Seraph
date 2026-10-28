/*
The Search page: find a repo on GitHub by a word or two of its name and add it to Repos by hand, without Explore.

Type in the box on top (its name, roughly, owner/name, a GitHub link, or a few words on what it does) and press Enter
or Search. Two searches start at once (backend/search_api.py):
- GitHub's own, shown first (it is quick): like the search box on github.com, best match first, over names,
  descriptions and topics. A single word is also tried as word/word, so openclaw finds openclaw/openclaw first; words
  that find nothing together are tried as any of them. Up to 30 repos, forks left out.
- The search agent's (github_searcher/search_agent.py), a few seconds later: it works out what you mean, the way a
  person would (ibasync is ib_async, opencraw is openclaw, a nickname, what the project does), searches GitHub itself,
  and picks the repo you most likely mean and closely related ones (what it was forked from or took over from, its
  official plugins, the best-known alternatives). A line above the table says what it thinks you are after; while it
  looks, a spinner and a Stop button that ends it (GitHub's own matches stay). Its picks go on top of the table, each
  with a line under it: "Likely what you mean" or "Related", and why. GitHub's own matches follow, without the ones
  it picked. A newer search drops an older one's answer. The page never names the model behind it.

The results are a table like the Explore page's, the agent's picks first, then GitHub's order: Repo (its description
under it; the icon opens it on GitHub in a new tab; archived repos say so in amber), Stars, Language, Last push, then
Add, which puts it in Repos (added by you; the Repos page's Ctrl+Z takes it out again): a spinner on it until the
backend answers, then a note at the bottom right, and the row says In Repos, a link to the Repos page (so does a repo
that was in Repos already). A click on a row opens it in place: its README, then its files folded at the bottom
(RepoTree), like on Explore and Repos. The last search and its results stay while you are on other pages, until a
reload, the agent's answer too (also one that comes while you are on another page).
*/

import { ExternalLink, Loader2, Search as SearchIcon, Sparkles, Square, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import RepoTree from "@/RepoTree";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, useLive } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

type FoundRepo = {
  full_name: string;
  description: string;
  stars: number;
  language: string | null;
  pushed_at: string;
  archived: boolean;
  html_url: string;
  // Only on the agent's picks: the one you most likely mean, or a related one, and why.
  kind?: "match" | "related";
  why?: string;
};

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// The last search, kept while the page is closed (until a reload).
let lastText = "";
let lastSearched = "";
let lastResults: FoundRepo[] | null = null;
// The agent's answer to the last search (null until it comes), whether it is still looking, and why it failed. Kept
// here, not in the page's state, so an answer that comes while the page is closed shows when it opens again.
let smart: { meant: string; results: FoundRepo[] } | null = null;
let smartBusy = false;
let smartError = "";
// The id the running agent search has on the backend, for Stop.
let smartId = "";
// Goes up with every search, so the answer to an older one is dropped.
let searchNumber = 0;
// Draws the open page again when the agent's answer comes (null while the page is closed).
let redraw: (() => void) | null = null;

export default function Search() {
  const repos = useLive("repos");
  const [text, setText] = useState(lastText);
  // What the results are for, and the results (null before the first search).
  const [searched, setSearched] = useState(lastSearched);
  const [results, setResults] = useState<FoundRepo[] | null>(lastResults);
  const [busy, setBusy] = useState(false);
  // Repos whose Add is waiting for the backend, and the rows open in place.
  const [adding, setAdding] = useState<string[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    redraw = () => setTick((tick) => tick + 1);
    return () => {
      redraw = null;
    };
  }, []);

  // Names in Repos, without case: those rows say In Repos.
  const inRepos = repos.items.map((each) => each.full_name.toLowerCase());

  async function search() {
    const query = text.trim();
    if (query === "") {
      return;
    }
    searchNumber += 1;
    askAgent(query, searchNumber);
    setBusy(true);
    try {
      const answer = await api<{ results: FoundRepo[] }>(`/api/search?q=${encodeURIComponent(query)}`);
      setResults(answer.results);
      setSearched(query);
      setOpen([]);
      lastResults = answer.results;
      lastSearched = query;
    } catch (err) {
      toast.error(`Could not search: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  // The agent's half (GET /api/search/agent): slower, so GitHub's own matches show first.
  async function askAgent(query: string, number: number) {
    smart = null;
    smartError = "";
    smartBusy = true;
    smartId = `${Date.now()}-${number}`;
    try {
      const answer = await api<{ meant: string; results: FoundRepo[] }>(`/api/search/agent?q=${encodeURIComponent(query)}&id=${smartId}`);
      if (number === searchNumber) {
        smart = answer;
      }
    } catch (err) {
      if (number === searchNumber) {
        smartError = err instanceof Error ? err.message : String(err);
      }
    }
    if (number === searchNumber) {
      smartBusy = false;
      if (redraw !== null) {
        redraw();
      }
    }
  }

  // Stop: the backend ends the agent search, and its answer (a "Stopped" error) is dropped like an older search's.
  async function stopAgent() {
    const id = smartId;
    searchNumber += 1;
    smartBusy = false;
    if (redraw !== null) {
      redraw();
    }
    try {
      await api("/api/search/agent/stop", { method: "POST", body: { id } });
    } catch (err) {
      toast.error(`Could not stop it: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function add(name: string) {
    setAdding((now) => [...now, name]);
    try {
      await api("/api/repos/add", { method: "POST", body: { name } });
      toast.success(`Added ${name} to Repos`);
    } catch (err) {
      toast.error(`Could not add ${name}: ${err instanceof Error ? err.message : err}`);
    } finally {
      setAdding((now) => now.filter((each) => each !== name));
    }
  }

  function toggle(name: string) {
    setOpen(open.includes(name) ? open.filter((each) => each !== name) : [...open, name]);
  }

  // The agent's picks first, then GitHub's own matches that aren't among them.
  const rows: FoundRepo[] = [];
  const picked: string[] = [];
  for (const each of smart !== null ? smart.results : []) {
    rows.push(each);
    picked.push(each.full_name.toLowerCase());
  }
  for (const each of results ?? []) {
    if (!picked.includes(each.full_name.toLowerCase())) {
      rows.push(each);
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b px-3 py-1">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <Input
            className="w-80"
            autoFocus
            placeholder="A repo's name (roughly), owner/name, or what it does"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              lastText = event.target.value;
            }}
          />
          <Button type="submit" disabled={busy || text.trim() === ""}>
            {busy ? <Loader2 className="animate-spin" /> : <SearchIcon />} Search
          </Button>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {(smartBusy || smart !== null || smartError !== "") && (
          <div className="flex min-h-8 items-center gap-2 border-b px-3 py-1">
            {smartBusy && (
              <>
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Working out what you mean and looking for related repos…</span>
                <Button variant="ghost" size="xs" onClick={stopAgent} title="Stop looking; GitHub's own matches stay">
                  <Square /> Stop
                </Button>
              </>
            )}
            {!smartBusy && smart !== null && (
              <>
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <span>{smart.meant}</span>
              </>
            )}
            {!smartBusy && smartError !== "" && <span className="text-muted-foreground">Couldn't look further: {smartError}</span>}
          </div>
        )}

        {results !== null && rows.length === 0 && !smartBusy && <div className="px-3 py-2 text-muted-foreground">Nothing found for "{searched}".</div>}

        {/* One grid for the whole table, like the Explore page's: the header and each row are subgrids of it, so they
            line up; Repo takes the room left over. The description and the open repo span the row without widening it. */}
        {rows.length > 0 && (
          <div className="grid w-max min-w-full gap-x-4 border-b" style={{ gridTemplateColumns: "minmax(160px,1fr) max-content max-content max-content max-content" }}>
            <div className="col-span-full grid h-7 grid-cols-subgrid items-center bg-muted/40 px-3 text-xs font-medium">
              <span>Repo</span>
              <span title="Stars on GitHub">Stars</span>
              <span title="Its main language on GitHub">Language</span>
              <span title="The last push to GitHub">Last push</span>
              <span />
            </div>
            {rows.map((each) => (
              <div key={each.full_name} className="col-span-full grid grid-cols-subgrid border-t">
                <div
                  className={cn("col-span-full grid cursor-pointer grid-cols-subgrid px-3 hover:bg-accent/50", open.includes(each.full_name) && "bg-accent/40")}
                  onClick={(event) => {
                    // Its links and buttons do their own thing.
                    if ((event.target as HTMLElement).closest("a, button") !== null) {
                      return;
                    }
                    toggle(each.full_name);
                  }}
                >
                  <span className="flex h-7 min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{each.full_name}</span>
                    <a
                      href={each.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-primary hover:text-foreground"
                      aria-label={`Open ${each.full_name} on GitHub`}
                      title="Open on GitHub in a new tab"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                    {each.archived && <span className="shrink-0 text-warn">archived</span>}
                  </span>
                  <span className="flex h-7 items-center gap-1 tabular-nums">
                    <Star className="size-3.5" />
                    {STARS.format(each.stars)}
                  </span>
                  <span className="flex h-7 items-center whitespace-nowrap">{each.language ?? ""}</span>
                  <span className="flex h-7 items-center whitespace-nowrap tabular-nums">{timeAgo(each.pushed_at)}</span>
                  <span className="flex h-7 items-center justify-end">
                    {inRepos.includes(each.full_name.toLowerCase()) ? (
                      <a href="#/repos" className="px-2 text-primary hover:underline" title="It is in Repos already">
                        In Repos
                      </a>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        title="Add it to Repos"
                        disabled={adding.includes(each.full_name)}
                        onClick={() => add(each.full_name)}
                      >
                        {adding.includes(each.full_name) && <Loader2 className="animate-spin" />}
                        Add
                      </Button>
                    )}
                  </span>
                  {each.description !== "" && (
                    <div className={cn("w-0 min-w-full truncate", each.why === undefined && "pb-1.5")} style={{ gridColumn: "1 / -1" }} title={each.description}>
                      {each.description}
                    </div>
                  )}
                  {each.why !== undefined && (
                    <div className="w-0 min-w-full truncate pb-1.5 text-muted-foreground" style={{ gridColumn: "1 / -1" }} title={each.why}>
                      <span className={cn(each.kind === "match" && "text-primary")}>{each.kind === "match" ? "Likely what you mean" : "Related"}</span> · {each.why}
                    </div>
                  )}
                </div>
                {open.includes(each.full_name) && (
                  <div className="col-span-full w-0 min-w-full border-t bg-muted/30">
                    <RepoTree repo={each} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
