/*
What an image has, shown when its row in the Images tab is open. Three tabs:
- Overview: the system, languages, tools, ready-made Docker images, models, caches and package counts
  (all from the live feed's summary, so it opens at once).
- Packages: every package, searchable and filtered by kind (apt, pip, npm, cargo, snap, flatpak, VS Code,
  Docker, Playwright). The full list comes from GET /api/images/inventory/<fingerprint>.
- Compare: what differs from another image, or from an older build of one (a rebuild replaces the image,
  but its list is kept): languages, tools and packages added, removed or at another version.

Lists never change once made, so each one is fetched once and kept for the session (inventories below).
Long lists only draw the rows on screen.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, type Image, type Inventory } from "@/live";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<string, string> = {
  apt: "apt",
  pip: "pip",
  npm: "npm",
  cargo: "cargo",
  snap: "snap",
  flatpak: "flatpak",
  vscode: "VS Code",
  docker: "Docker",
  playwright: "Playwright",
  language: "language",
  tool: "tool",
};

// Fetched lists by fingerprint, kept for the session: an image's list never changes. A failed fetch is
// forgotten, so opening the tab again tries again.
const inventories = new Map<string, Promise<Inventory>>();

export default function ImageInventory(props: { image: Image }) {
  const [tab, setTab] = useState("overview");
  const highlights = props.image.inventory;
  if (highlights === null) {
    return null;
  }
  const total = Object.values(highlights.counts).reduce((sum, count) => sum + count, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview" className="px-2.5">
              Overview
            </TabsTrigger>
            <TabsTrigger value="packages" className="px-2.5">
              Packages
              <span className="text-xs text-muted-foreground tabular-nums">{total.toLocaleString()}</span>
            </TabsTrigger>
            <TabsTrigger value="compare" className="px-2.5">
              Compare
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">
          Listed {new Date(highlights.inspected_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
        </span>
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <span className="text-muted-foreground">System</span>
          <span>
            {highlights.system.os} · kernel {highlights.system.kernel} · {highlights.system.desktop} · {highlights.system.arch} ·{" "}
            {highlights.system.disk_used_gb} GB used · user {highlights.system.user}
          </span>

          <span className="text-muted-foreground">Languages</span>
          <span className="flex flex-wrap gap-1">
            {highlights.languages.map((item) => (
              <Badge key={item.name} variant="secondary" title={item.raw}>
                {item.name} {item.version}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Tools</span>
          <span className="flex flex-wrap gap-1">
            {highlights.tools.map((item) => (
              <Badge key={item.name} variant="outline" title={item.raw}>
                {item.name} {item.version}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Docker</span>
          <span className="flex flex-wrap gap-1">
            {highlights.docker_images.length === 0 && <span className="text-muted-foreground">No images pulled</span>}
            {highlights.docker_images.map((name) => (
              <Badge key={name} variant="outline" className="font-mono">
                {name}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Models</span>
          <span className="flex flex-wrap gap-1">
            {highlights.models.length === 0 && <span className="text-muted-foreground">None downloaded</span>}
            {highlights.models.map((name) => (
              <Badge key={name} variant="outline">
                {name}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Caches</span>
          <span>
            {highlights.caches.length === 0 && <span className="text-muted-foreground">None</span>}
            {highlights.caches.map((cache) => `${cache.name} ${cache.size_gb.toFixed(2)} GB`).join(" · ")}
          </span>

          <span className="text-muted-foreground">Packages</span>
          <span>
            {Object.entries(highlights.counts)
              .map(([kind, count]) => `${KIND_LABEL[kind] ?? kind} ${count.toLocaleString()}`)
              .join(" · ")}
          </span>
        </div>
      )}

      {tab === "packages" && <PackagesTab fingerprint={props.image.fingerprint} counts={highlights.counts} />}
      {tab === "compare" && <CompareTab image={props.image} />}
    </div>
  );
}

function PackagesTab(props: { fingerprint: string; counts: Record<string, number> }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("all");
  const [filter, setFilter] = useState("");
  const [manualOnly, setManualOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    let request = inventories.get(props.fingerprint);
    if (request === undefined) {
      request = api<Inventory>(`/api/images/inventory/${props.fingerprint}`);
      inventories.set(props.fingerprint, request);
    }
    request
      .then((answer) => {
        if (!stopped) {
          setInventory(answer);
        }
      })
      .catch((err) => {
        inventories.delete(props.fingerprint);
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      stopped = true;
    };
  }, [props.fingerprint]);

  const needle = filter.trim().toLowerCase();
  const rows = (inventory?.packages ?? []).filter((item) => {
    if (kind !== "all" && item.kind !== kind) {
      return false;
    }
    if (manualOnly && item.kind === "apt" && !item.manual) {
      return false;
    }
    return needle === "" || item.name.toLowerCase().includes(needle);
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-56" placeholder="Search packages" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">All kinds</SelectItem>
            {Object.entries(props.counts).map(([name, count]) => (
              <SelectItem key={name} value={name}>
                {KIND_LABEL[name] ?? name}
                <span className="text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(kind === "all" || kind === "apt") && (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={manualOnly} onChange={(event) => setManualOnly(event.target.checked)} />
            apt: only ones installed on purpose
          </label>
        )}
        {inventory !== null && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{rows.length.toLocaleString()} shown</span>}
      </div>

      {inventory === null && error === "" && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading the list…
        </div>
      )}
      {error !== "" && <div className="text-destructive">Could not load the list: {error}</div>}

      {inventory !== null && (
        <div ref={scrollRef} className="h-80 overflow-auto border bg-background">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const pkg = rows[item.index];
              return (
                <div
                  key={item.key}
                  className="absolute left-0 grid h-6 w-full grid-cols-[88px_minmax(0,1fr)_minmax(0,260px)] items-center gap-3 border-b px-2 font-mono text-xs"
                  style={{ top: item.start }}
                >
                  <span className="text-muted-foreground">{KIND_LABEL[pkg.kind] ?? pkg.kind}</span>
                  <span className="truncate">
                    {pkg.name}
                    {pkg.manual && <span className="ml-2 font-sans text-muted-foreground">on purpose</span>}
                  </span>
                  <span className="truncate text-muted-foreground">{pkg.version}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type Change = { change: "added" | "removed" | "changed"; kind: string; name: string; before: string; after: string };

function CompareTab(props: { image: Image }) {
  const data = useLive("images");
  // Every other image that has a list, and the lists of images that are gone (older builds).
  const others = [
    ...data.images
      .filter((each) => each.fingerprint !== props.image.fingerprint && each.inventory !== null)
      .map((each) => ({ fingerprint: each.fingerprint, label: each.name })),
    ...data.old_builds.map((build) => ({
      fingerprint: build.fingerprint,
      label: `${build.name} (older build, ${new Date(build.created_at).toLocaleDateString()})`,
    })),
  ];
  const [other, setOther] = useState(others[0]?.fingerprint ?? "");
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("all");
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Read "before" as the other image and "after" as this one.
  useEffect(() => {
    if (other === "") {
      return;
    }
    let stopped = false;
    setChanges(null);
    setError("");
    const requests = [];
    for (const fingerprint of [other, props.image.fingerprint]) {
      let request = inventories.get(fingerprint);
      if (request === undefined) {
        request = api<Inventory>(`/api/images/inventory/${fingerprint}`);
        inventories.set(fingerprint, request);
      }
      requests.push(request);
    }
    Promise.all(requests)
      .then(([before, after]) => {
        if (stopped) {
          return;
        }
        const old: Record<string, string> = {};
        const now: Record<string, string> = {};
        for (const item of before.languages) {
          old[`language\t${item.name}`] = item.version;
        }
        for (const item of before.tools) {
          old[`tool\t${item.name}`] = item.version;
        }
        for (const item of before.packages) {
          old[`${item.kind}\t${item.name}`] = item.version;
        }
        for (const item of after.languages) {
          now[`language\t${item.name}`] = item.version;
        }
        for (const item of after.tools) {
          now[`tool\t${item.name}`] = item.version;
        }
        for (const item of after.packages) {
          now[`${item.kind}\t${item.name}`] = item.version;
        }
        const found: Change[] = [];
        for (const key of Object.keys(now)) {
          const [itemKind, name] = key.split("\t");
          if (!(key in old)) {
            found.push({ change: "added", kind: itemKind, name, before: "", after: now[key] });
          } else if (old[key] !== now[key]) {
            found.push({ change: "changed", kind: itemKind, name, before: old[key], after: now[key] });
          }
        }
        for (const key of Object.keys(old)) {
          const [itemKind, name] = key.split("\t");
          if (!(key in now)) {
            found.push({ change: "removed", kind: itemKind, name, before: old[key], after: "" });
          }
        }
        // Languages and tools first (they matter most), then by kind and name.
        const order = ["language", "tool"];
        found.sort((a, b) => {
          const rankA = order.includes(a.kind) ? order.indexOf(a.kind) : 2;
          const rankB = order.includes(b.kind) ? order.indexOf(b.kind) : 2;
          return rankA - rankB || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
        });
        setChanges(found);
      })
      .catch((err) => {
        inventories.delete(other);
        inventories.delete(props.image.fingerprint);
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      stopped = true;
    };
  }, [other, props.image.fingerprint]);

  const needle = filter.trim().toLowerCase();
  const rows = (changes ?? []).filter(
    (item) => (kind === "all" || item.kind === kind) && (needle === "" || item.name.toLowerCase().includes(needle)),
  );
  const kinds = [...new Set((changes ?? []).map((item) => item.kind))];
  const added = (changes ?? []).filter((item) => item.change === "added").length;
  const removed = (changes ?? []).filter((item) => item.change === "removed").length;
  const changed = (changes ?? []).filter((item) => item.change === "changed").length;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  if (others.length === 0) {
    return <div className="text-muted-foreground">No other image has a list to compare with yet. Inspect another image, or rebuild this one.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{props.image.name} compared with</span>
        <Select value={other} onValueChange={setOther}>
          <SelectTrigger className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {others.map((each) => (
              <SelectItem key={each.fingerprint} value={each.fingerprint}>
                {each.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {changes !== null && (
          <span className="tabular-nums">
            <span className="text-ok">+{added} added</span> · <span className="text-destructive">−{removed} removed</span> ·{" "}
            <span className="text-warn">{changed} changed</span>
          </span>
        )}
      </div>

      {changes === null && error === "" && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading the lists…
        </div>
      )}
      {error !== "" && <div className="text-destructive">Could not load the lists: {error}</div>}
      {changes !== null && changes.length === 0 && <div className="text-muted-foreground">They have exactly the same things.</div>}

      {changes !== null && changes.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <Input className="w-56" placeholder="Search" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">All kinds</SelectItem>
                {kinds.map((name) => (
                  <SelectItem key={name} value={name}>
                    {KIND_LABEL[name] ?? name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div ref={scrollRef} className="h-80 overflow-auto border bg-background">
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                return (
                  <div
                    key={item.key}
                    className="absolute left-0 grid h-6 w-full grid-cols-[16px_88px_minmax(0,1fr)_minmax(0,320px)] items-center gap-3 border-b px-2 font-mono text-xs"
                    style={{ top: item.start }}
                  >
                    <span
                      className={cn(
                        "font-semibold",
                        row.change === "added" && "text-ok",
                        row.change === "removed" && "text-destructive",
                        row.change === "changed" && "text-warn",
                      )}
                    >
                      {row.change === "added" ? "+" : row.change === "removed" ? "−" : "~"}
                    </span>
                    <span className="text-muted-foreground">{KIND_LABEL[row.kind] ?? row.kind}</span>
                    <span className="truncate">{row.name}</span>
                    <span className="truncate text-muted-foreground">
                      {row.change === "changed" && `${row.before} → ${row.after}`}
                      {row.change === "added" && row.after}
                      {row.change === "removed" && row.before}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
