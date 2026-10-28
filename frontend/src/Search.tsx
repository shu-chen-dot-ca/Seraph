/*
The Search page: find a repo on GitHub by a word or two of its name and add it to Repos by hand, without Explore.

Type in the box on top (its name, roughly, owner/name, a GitHub link, or a few words on what it does) and press Enter
or Search. It searches GitHub like the search box on github.com (backend/search_api.py): best match first, over
names, descriptions and topics. A single word is also tried as word/word, so openclaw finds openclaw/openclaw first;
words that find nothing together are tried as any of them. Up to 30 repos, forks left out.

The results are a table like the Explore page's, in GitHub's order: Repo (its description
under it; the icon opens it on GitHub in a new tab; archived repos say so in amber), Stars, Language, Last push, then
Add, which puts it in Repos (added by you; the Repos page's Ctrl+Z takes it out again): a spinner on it until the
backend answers, then a note at the bottom right, and the row says In Repos, a link to the Repos page (so does a repo
that was in Repos already). A click on a row opens it in place: its README, then its files folded at the bottom
(RepoTree), like on Explore and Repos. The last search and its results stay while you are on other pages, until a
reload.
*/

import { ExternalLink, Loader2, Search as SearchIcon, Star } from "lucide-react";
import { useState } from "react";
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
};

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// The last search, kept while the page is closed (until a reload).
let lastText = "";
let lastSearched = "";
let lastResults: FoundRepo[] | null = null;

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

  // Names in Repos, without case: those rows say In Repos.
  const inRepos = repos.items.map((each) => each.full_name.toLowerCase());

  async function search() {
    const query = text.trim();
    if (query === "") {
      return;
    }
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

  const rows = results ?? [];

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
        {results !== null && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">Nothing found for "{searched}".</div>}

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
                    <div className="w-0 min-w-full truncate pb-1.5" style={{ gridColumn: "1 / -1" }} title={each.description}>
                      {each.description}
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
