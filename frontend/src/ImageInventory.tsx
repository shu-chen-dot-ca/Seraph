/*
What an image has, shown in the Details dialog of the Images tab. Three tabs:
- Overview: the system, languages, tools, ready-made Docker images, models, caches and package counts
  (all from the live feed's summary, so it opens at once).
- Packages: every package, searchable and filtered by kind (apt, pip, npm, cargo, snap, flatpak, VS Code,
  Docker, Playwright). The full list comes from GET /api/images/inventory/<fingerprint>.
- Agent: a chat with the image's agent, which keeps its description and builds it (ImageAgent). Overview and
  Packages are what the build has; once the description differs from it, the tab has an amber dot until a rebuild.

A list never changes once made, so each one is fetched once and kept: for the session (inventories below)
and in localStorage, so it opens at once after a reload too. Kept by fingerprint and when it was listed, since
Inspect again makes a new list for the same image; only the current list of each image stays in localStorage.
Long lists only draw the rows on screen.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ImageAgent from "@/ImageAgent";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, type Image, type Inventory } from "@/live";

const KIND_LABEL: Record<string, string> = {
  apt: "apt",
  rpm: "rpm",
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

// Fetched lists by "inventory:<fingerprint>:<inspected_at>" (the localStorage key too), kept for the session.
// A failed fetch is forgotten, so opening the tab again tries again.
const inventories = new Map<string, Promise<Inventory>>();

export default function ImageInventory(props: { image: Image; onRebuild: () => void }) {
  const [tab, setTab] = useState("overview");
  const highlights = props.image.inventory;
  if (highlights === null) {
    return null;
  }
  const total = Object.values(highlights.counts).reduce((sum, count) => sum + count, 0);

  return (
    <div className="space-y-2">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview" className="px-2.5">
            Overview
          </TabsTrigger>
          <TabsTrigger value="packages" className="px-2.5">
            Packages
            <span className="text-xs text-muted-foreground tabular-nums">{total.toLocaleString()}</span>
          </TabsTrigger>
          <TabsTrigger value="agent" className="px-2.5">
            Agent
            {props.image.spec_changed && <StatusDot tone="amber" />}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "overview" && (
        <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <span className="text-muted-foreground">System</span>
          <span>
            {highlights.system.os} · kernel {highlights.system.kernel} · {highlights.system.desktop} · {highlights.system.arch} ·{" "}
            {highlights.system.disk_used_gb} GB used · user {highlights.system.user}
          </span>

          <span className="text-muted-foreground">Languages</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {highlights.languages.map((item) => (
              <Badge key={item.name} variant="secondary" title={item.raw}>
                {item.name} {item.version}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Tools</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {highlights.tools.map((item) => (
              <Badge key={item.name} variant="secondary" title={item.raw}>
                {item.name} {item.version}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Docker</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {highlights.docker_images.length === 0 && <span className="text-muted-foreground">No images pulled</span>}
            {highlights.docker_images.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))}
          </span>

          <span className="text-muted-foreground">Models</span>
          <span className="flex flex-wrap items-center gap-1.5">
            {highlights.models.length === 0 && <span className="text-muted-foreground">None downloaded</span>}
            {highlights.models.map((name) => (
              <Badge key={name} variant="secondary">
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

      {tab === "agent" && <ImageAgent image={props.image} onRebuild={props.onRebuild} />}
      {tab === "packages" && <PackagesTab fingerprint={props.image.fingerprint} inspectedAt={highlights.inspected_at} counts={highlights.counts} />}
    </div>
  );
}

function PackagesTab(props: { fingerprint: string; inspectedAt: string; counts: Record<string, number> }) {
  const data = useLive("images");
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("all");
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    const key = `inventory:${props.fingerprint}:${props.inspectedAt}`;
    let saved: Inventory | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      // Storage blocked, or a broken entry: fetch it.
    }
    if (saved !== null) {
      setInventory(saved);
      return;
    }
    let request = inventories.get(key);
    if (request === undefined) {
      request = api<Inventory>(`/api/images/inventory/${props.fingerprint}`);
      inventories.set(key, request);
    }
    request
      .then((answer) => {
        try {
          // Only the current list of each image stays: older ones (before Inspect again) and deleted images' go.
          const current = data.images.map((image) => `inventory:${image.fingerprint}:${image.inventory?.inspected_at}`);
          for (const name of Object.keys(localStorage)) {
            if (name.startsWith("inventory:") && name !== key && !current.includes(name)) {
              localStorage.removeItem(name);
            }
          }
          localStorage.setItem(key, JSON.stringify(answer));
        } catch {
          // Storage full or blocked: it is kept for this session only.
        }
        if (!stopped) {
          setInventory(answer);
        }
      })
      .catch((err) => {
        inventories.delete(key);
        if (!stopped) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      stopped = true;
    };
    // data is only read when the answer comes, to tidy up; a change in it is no reason to load again.
  }, [props.fingerprint, props.inspectedAt]);

  const needle = filter.trim().toLowerCase();
  const rows = (inventory?.packages ?? []).filter((item) => {
    if (kind !== "all" && item.kind !== kind) {
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
            <SelectItem value="all">All</SelectItem>
            {Object.entries(props.counts).map(([name, count]) => (
              <SelectItem key={name} value={name}>
                {KIND_LABEL[name] ?? name}
                <span className="text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
