import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
The one list every page uses, so every list works the same way. Rows are two lines, like a mail app: the title and
its time on top, the other details in small text under it.
- Sort: the Sort menu, and the arrow next to it to flip it. Kept per list, so coming back keeps it.
- Filter: the chips and the search box above the list.
- Select, like a mail app: Ctrl/⌘-click one, Shift-click a range, or press on a row and drag down the rows. On a
  phone, press and hold a row, then tap more. Ctrl/⌘+A selects all, Esc clears.
- A plain click (or tap) opens the row: its address (rowHref), and onOpen first when the page needs to know (an
  empty address only calls onOpen, for rows that open a pop-up).
- The bar that shows once something is selected only has actions that fit everything selected (the page decides).
*/

export type Column<T> = {
  key: string;
  label: string;
  sortValue: (row: T) => string | number;
  cell: (row: T) => ReactNode;
  // The title: bold, on the first line.
  main?: boolean;
  // A time: top right.
  time?: boolean;
};
export type Chip<T> = { key: string; label: string; test: (row: T) => boolean };
export type BulkAction<T> = { label: string; primary?: boolean; onClick: (rows: T[]) => void };
type SortKey = { key: string; dir: number };

type Props<T> = {
  // Names the list, so its sort is kept apart from other lists'.
  id: string;
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  rowHref: (row: T) => string;
  defaultSort: SortKey;
  chips?: Chip<T>[];
  search?: (row: T) => string;
  bulk: (selected: T[]) => BulkAction<T>[];
  // Shown when there is nothing at all.
  empty: string;
  // Rows shown quieter, like read mail.
  quiet?: (row: T) => boolean;
  onOpen?: (row: T) => void;
};

export default function DataList<T>(props: Props<T>) {
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("sort3-" + props.id) ?? "null");
      if (saved && saved.key) {
        return saved;
      }
    } catch {
      // Storage blocked (private window): the default sort.
    }
    return props.defaultSort;
  });
  const [chip, setChip] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  // The row a Shift-click selects from, the drag going on, and the touch press going on.
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ start: number; moved: boolean } | null>(null);
  const press = useRef<{ index: number; x: number; y: number; fired: boolean; timer: number } | null>(null);
  // What is shown right now, for the document's pointer handlers below (they are added once).
  const idsRef = useRef<string[]>([]);
  const rowsRef = useRef<T[]>([]);
  const selectedRef = useRef<string[]>([]);
  const onOpenRef = useRef(props.onOpen);
  const rowHrefRef = useRef(props.rowHref);

  useEffect(() => {
    try {
      localStorage.setItem("sort3-" + props.id, JSON.stringify(sort));
    } catch {
      // Storage blocked: the sort just isn't kept.
    }
  }, [props.id, sort]);

  let visible = props.rows;
  const activeChip = props.chips?.find((each) => each.key === chip);
  if (activeChip) {
    visible = visible.filter(activeChip.test);
  }
  const q = query.trim().toLowerCase();
  if (q !== "" && props.search) {
    const search = props.search;
    visible = visible.filter((row) => search(row).toLowerCase().includes(q));
  }
  const sortColumn = props.columns.find((column) => column.key === sort.key) ?? props.columns[0];
  visible = [...visible].sort((a, b) => {
    const va = sortColumn.sortValue(a);
    const vb = sortColumn.sortValue(b);
    const result = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return result * sort.dir;
  });
  idsRef.current = visible.map(props.rowId);
  rowsRef.current = visible;
  selectedRef.current = selected;
  onOpenRef.current = props.onOpen;
  rowHrefRef.current = props.rowHref;
  const chosen = visible.filter((row) => selected.includes(props.rowId(row)));

  function selectRange(a: number, b: number) {
    setSelected(idsRef.current.slice(Math.min(a, b), Math.max(a, b) + 1));
  }

  function open(index: number) {
    const row = rowsRef.current[index];
    onOpenRef.current?.(row);
    const address = rowHrefRef.current(row);
    if (address !== "") {
      window.location.hash = address;
    }
  }

  function toggle(index: number) {
    const id = idsRef.current[index];
    setSelected((before) => (before.includes(id) ? before.filter((each) => each !== id) : [...before, id]));
  }

  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (drag.current) {
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-row]");
        const index = row && row.dataset.list === props.id ? Number(row.dataset.row) : null;
        if (index !== null && (index !== drag.current.start || drag.current.moved)) {
          drag.current.moved = true;
          anchor.current = drag.current.start;
          selectRange(drag.current.start, index);
          setStatus("");
        }
      }
      if (press.current && (Math.abs(event.clientX - press.current.x) > 8 || Math.abs(event.clientY - press.current.y) > 8)) {
        clearTimeout(press.current.timer);
        press.current = null;
      }
    }
    function onUp() {
      if (drag.current) {
        const start = drag.current.start;
        const moved = drag.current.moved;
        drag.current = null;
        if (!moved) {
          open(start);
        }
      }
      if (press.current) {
        const index = press.current.index;
        const fired = press.current.fired;
        clearTimeout(press.current.timer);
        press.current = null;
        if (!fired && selectedRef.current.length > 0) {
          toggle(index);
        } else if (!fired) {
          open(index);
        }
      }
    }
    function onCancel() {
      if (press.current) {
        clearTimeout(press.current.timer);
      }
      press.current = null;
      drag.current = null;
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
    // selectRange, toggle and open only use refs and setters, so the first ones stay right.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // A link or button inside a row does its own thing.
    if (target.closest("a, button, input, select")) {
      return;
    }
    const row = target.closest<HTMLElement>("[data-row]");
    if (!row) {
      return;
    }
    const index = Number(row.dataset.row);
    if (event.pointerType !== "mouse") {
      const timer = window.setTimeout(() => {
        if (press.current) {
          press.current.fired = true;
          anchor.current = index;
          toggle(index);
          setStatus("Selecting: tap more rows.");
        }
      }, 450);
      press.current = { index, x: event.clientX, y: event.clientY, fired: false, timer };
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      anchor.current = index;
      toggle(index);
      setStatus("");
      return;
    }
    if (event.shiftKey && anchor.current !== null) {
      selectRange(anchor.current, index);
      setStatus("");
      return;
    }
    // Keep the browser from selecting text while dragging down the rows.
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = { start: index, moved: false };
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      setSelected([]);
      setStatus("");
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(idsRef.current);
    }
  }

  const mainColumn = props.columns.find((column) => column.main);
  const timeColumn = props.columns.find((column) => column.time);
  const otherColumns = props.columns.filter((column) => !column.main && !column.time);
  const actions = chosen.length > 0 ? props.bulk(chosen) : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {props.search && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search"
            className="h-7 w-40 max-w-full rounded-md border bg-background px-2 text-[12.5px] outline-none focus-visible:border-ring"
          />
        )}
        {props.chips && (
          <div className="flex flex-wrap gap-1">
            {[{ key: "all", label: "All" }, ...props.chips].map((each) => (
              <button
                key={each.key}
                type="button"
                onClick={() => setChip(each.key)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground",
                  chip === each.key && "border-transparent bg-selected font-medium text-primary hover:text-primary",
                )}
              >
                {each.label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <select
            value={sortColumn.key}
            onChange={(event) => setSort({ key: event.target.value, dir: 1 })}
            aria-label="Sort by"
            className="h-7 rounded-md border bg-background px-1.5 text-[12.5px]"
          >
            {props.columns.map((column) => (
              <option key={column.key} value={column.key}>
                Sort: {column.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="icon-sm" aria-label="Flip the sort" onClick={() => setSort({ key: sort.key, dir: -sort.dir })}>
            {sort.dir === 1 ? "↓" : "↑"}
          </Button>
        </div>
      </div>

      <div tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className="relative outline-none select-none [-webkit-touch-callout:none]">
        {visible.map((row, index) => (
          <div
            key={props.rowId(row)}
            data-row={index}
            data-list={props.id}
            className={cn(
              "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b px-4 py-2 hover:bg-accent",
              selected.includes(props.rowId(row)) && "bg-selected hover:bg-selected",
              props.quiet?.(row) && "text-muted-foreground",
            )}
          >
            <div className={cn("min-w-0 truncate", !props.quiet?.(row) && "font-medium")}>{mainColumn?.cell(row)}</div>
            <div className="text-right text-xs text-muted-foreground tabular-nums">{timeColumn?.cell(row)}</div>
            <div className="col-span-2 flex min-w-0 items-center gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
              {otherColumns.map((column) => (
                <span key={column.key} className="min-w-0 truncate">
                  {column.cell(row)}
                </span>
              ))}
            </div>
          </div>
        ))}
        {props.rows.length === 0 && <div className="px-4 py-8 text-center text-muted-foreground">{props.empty}</div>}
        {props.rows.length > 0 && visible.length === 0 && <div className="px-4 py-8 text-center text-muted-foreground">Nothing matches.</div>}

        {props.rows.length > 0 && (
          <div className="px-4 py-2 text-xs text-muted-foreground">
            {status || "Click a row to open it. Ctrl/⌘-click or Shift-click to select, or drag down the rows."}
          </div>
        )}

        {chosen.length > 0 && (
          <div className="sticky bottom-3 z-10 mx-auto mb-3 flex w-fit max-w-[calc(100%-24px)] flex-wrap items-center gap-1.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 shadow-overlay">
            <span className="mr-1 font-semibold tabular-nums">{chosen.length} selected</span>
            {actions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.primary ? "default" : "outline"}
                onClick={() => {
                  action.onClick(chosen);
                  setSelected([]);
                }}
              >
                {action.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <span className="text-xs text-muted-foreground">Esc clears</span>
          </div>
        )}
      </div>
    </div>
  );
}
