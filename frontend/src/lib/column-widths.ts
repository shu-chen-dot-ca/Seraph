import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

// Column widths that fit the widest cell of each column, for a list whose rows are grids of their own (so CSS can't
// line their columns up by itself, as in a virtualized list that only draws the rows on screen).
//
// The page draws a hidden grid (ref) holding a copy of every row's cells, its columns max-content, so the browser makes
// each column as wide as its widest cell. This reads the widths it gave them, in px, after every render and whenever
// the hidden grid changes size (a font loading, a cell growing), so the visible rows can use the same widths.
export function useColumnWidths(ref: RefObject<HTMLElement | null>): number[] {
  const [widths, setWidths] = useState<number[]>([]);

  function read() {
    const grid = ref.current;
    if (grid === null) {
      return;
    }
    const next = getComputedStyle(grid)
      .gridTemplateColumns.split(" ")
      .map((each) => Math.ceil(parseFloat(each)) || 0);
    // The same widths again: no new render.
    setWidths((current) => (current.join(" ") === next.join(" ") ? current : next));
  }

  // Before the browser paints, so the rows never show with the old widths.
  useLayoutEffect(read);

  useEffect(() => {
    const grid = ref.current;
    if (grid === null) {
      return;
    }
    const observer = new ResizeObserver(read);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [ref]);

  return widths;
}
