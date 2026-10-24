import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// Which columns a table shows and in what order, laid out like a trading app's column settings: on the left the
// columns it could show, grouped and searchable; on the right the ones it shows, top to bottom being left to right.
//
//   drag a column from the left to the right       adds it where it is dropped (a blue line shows where)
//   drag a shown column up or down                 moves it
//   drag a shown column back to the left           removes it
//   double-click                                   adds (left) or removes (right) at once, without dragging
//   Reset                                          goes back to the table's defaults
//
// fixed is the column that always comes first and can't be moved or removed (a repo's name). Every change shows in
// the table at once, so there is nothing to apply.

type Column = { key: string; name: string; group: string }

export function ColumnsDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  columns: Column[]
  groups: string[]
  shown: string[]
  defaults: string[]
  fixed: string
  onChange: (shown: string[]) => void
}) {
  const [filter, setFilter] = useState("")
  // The column being dragged and which list it came from; where it would land among the shown ones (0 is first);
  // and whether a shown column is over the left list, about to be removed.
  const [dragging, setDragging] = useState<{ key: string; from: "available" | "shown" } | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [overAvailable, setOverAvailable] = useState(false)
  const needle = filter.trim().toLowerCase()
  const available = props.columns.filter((column) => !props.shown.includes(column.key) && (needle === "" || column.name.toLowerCase().includes(needle)))

  function stopDragging() {
    setDragging(null)
    setDropAt(null)
    setOverAvailable(false)
  }

  // Puts the column at this place among the shown ones, whether it was shown already (a move) or not (an add).
  function place(key: string, at: number) {
    const before = props.shown.indexOf(key)
    const rest = props.shown.filter((each) => each !== key)
    // Taking it out first moves the ones after it up by one.
    const to = before >= 0 && before < at ? at - 1 : at
    props.onChange([...rest.slice(0, to), key, ...rest.slice(to)])
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Columns</DialogTitle>
          <DialogDescription>
            Drag a column to the right to show it, up or down to order it, and back to the left to hide it. Top to bottom here is left to right in the
            table.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Available</span>
            <Input placeholder="Search columns" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <div
              className={cn("h-80 overflow-auto rounded-md border", overAvailable && "border-primary bg-primary/5")}
              onDragOver={(event) => {
                if (dragging?.from !== "shown") {
                  return
                }
                event.preventDefault()
                setOverAvailable(true)
                setDropAt(null)
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setOverAvailable(false)
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging?.from === "shown") {
                  props.onChange(props.shown.filter((each) => each !== dragging.key))
                }
                stopDragging()
              }}
            >
              {props.groups.map((group) => {
                const inGroup = available.filter((column) => column.group === group)
                if (inGroup.length === 0) {
                  return null
                }
                return (
                  <div key={group}>
                    <div className="sticky top-0 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{group}</div>
                    {inGroup.map((column) => (
                      <div
                        key={column.key}
                        draggable
                        className={cn("cursor-grab truncate px-3 py-0.5 select-none hover:bg-accent", dragging?.key === column.key && "opacity-40")}
                        onDragStart={(event) => {
                          // Firefox only starts a drag that carries some data.
                          event.dataTransfer.setData("text/plain", column.key)
                          event.dataTransfer.effectAllowed = "move"
                          setDragging({ key: column.key, from: "available" })
                        }}
                        onDragEnd={stopDragging}
                        onDoubleClick={() => place(column.key, props.shown.length)}
                      >
                        {column.name}
                      </div>
                    ))}
                  </div>
                )
              })}
              {available.length === 0 && <div className="px-2 py-1 text-muted-foreground">{needle === "" ? "Every column is shown" : "No column matches"}</div>}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Shown, left to right</span>
            <div
              className="h-0 min-h-0 flex-1 overflow-auto rounded-md border"
              onDragOver={(event) => {
                if (dragging === null) {
                  return
                }
                event.preventDefault()
                // Below the last column: at the end. The rows themselves say before or after them.
                if (event.target === event.currentTarget) {
                  setDropAt(props.shown.length)
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropAt(null)
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null && dropAt !== null) {
                  place(dragging.key, dropAt)
                }
                stopDragging()
              }}
            >
              <div
                className="truncate px-3 py-0.5 text-muted-foreground"
                onDragOver={(event) => {
                  if (dragging !== null) {
                    event.preventDefault()
                    setDropAt(0)
                  }
                }}
              >
                {props.fixed} (always first)
              </div>
              {props.shown.map((key, index) => {
                const column = props.columns.find((each) => each.key === key)
                if (column === undefined) {
                  return null
                }
                return (
                  <div
                    key={key}
                    draggable
                    className={cn(
                      "cursor-grab truncate px-3 py-0.5 select-none hover:bg-accent",
                      dragging?.key === key && "opacity-40",
                      // The blue line where the dragged column would land: above this one, or below the last.
                      dropAt === index && "shadow-[inset_0_2px_0_0_var(--color-primary)]",
                      dropAt === props.shown.length && index === props.shown.length - 1 && "shadow-[inset_0_-2px_0_0_var(--color-primary)]",
                    )}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", key)
                      event.dataTransfer.effectAllowed = "move"
                      setDragging({ key, from: "shown" })
                    }}
                    onDragEnd={stopDragging}
                    onDragOver={(event) => {
                      if (dragging === null) {
                        return
                      }
                      event.preventDefault()
                      const box = event.currentTarget.getBoundingClientRect()
                      setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1)
                    }}
                    onDoubleClick={() => props.onChange(props.shown.filter((each) => each !== key))}
                  >
                    {column.name}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onChange(props.defaults)}>
            Reset to default
          </Button>
          <Button onClick={() => props.onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
