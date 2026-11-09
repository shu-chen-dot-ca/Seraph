/*
The agent's cursor over a VM desktop on the VM page (VMPage.tsx): an arrow with the agent's name under it, where the
agent last clicked, dragged or scrolled (the VM's pointers, sandbox/vms.py). White while the agent works on the
desktop (its turn runs), gray while it doesn't (between turns, or asleep while its run goes). Not shown while
someone else holds the desktop, or before the agent's first click there.

A new place glides there slowly instead of jumping, and the agent waits for that before it clicks
(GLIDE_SECONDS, sandbox/agent/tools.py), so you see where it is about to click.

It lies over the whole box the desktop is drawn in (noVNC's page in an iframe, or LiveDesktop.tsx) and finds the
screen in it the way noVNC draws it: scaled to fit, in the middle.
*/

import { useEffect, useRef, useState } from "react";

import { useLive, type AgentSummary, type VMSummary } from "@/live";
import { cn } from "@/lib/utils";

export default function AgentCursor(props: { vm: VMSummary; desktop: number }) {
  const agents = useLive("agents");
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // The box's size, again on every resize (a divider dragged, the window resized).
  useEffect(() => {
    const element = boxRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setBox({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The agent that last put the mouse there, while it still holds that desktop.
  const pointer = props.vm.pointers[props.desktop] ?? null;
  const line = props.vm.desktops.find((each) => each.number === props.desktop) ?? null;
  let agent: AgentSummary | null = null;
  if (pointer !== null && line !== null) {
    const here = line.holder === pointer.agent;
    for (const each of agents) {
      if (here && each.id === pointer.agent) {
        agent = each;
      }
    }
  }

  let cursor: React.ReactNode = null;
  if (pointer !== null && line !== null && agent !== null && box.width > 0) {
    const active = agent.busy && line.holder === agent.id;
    // The screen is scaled to fit the box and centered in it.
    const scale = Math.min(box.width / pointer.width, box.height / pointer.height);
    const left = (box.width - pointer.width * scale) / 2 + pointer.x * scale;
    const top = (box.height - pointer.height * scale) / 2 + pointer.y * scale;
    cursor = (
      <div className="absolute top-0 left-0 transition-transform duration-700 ease-in-out" style={{ transform: `translate(${left}px, ${top}px)` }}>
        {/* The arrow's tip (2, 2) is on the place. */}
        <svg viewBox="0 0 20 20" className="absolute -top-0.5 -left-0.5 size-5 drop-shadow-md">
          <path
            d="M2 2 L18 8.5 L10.5 10.5 L8.5 18 Z"
            strokeWidth="1.25"
            strokeLinejoin="round"
            className={cn("transition-colors duration-300", active ? "fill-white stroke-neutral-900" : "fill-neutral-500 stroke-white")}
          />
        </svg>
        <span
          className={cn(
            "absolute top-4 left-3.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap shadow-md transition-colors duration-300",
            active ? "bg-white text-neutral-900" : "bg-neutral-500 text-white",
          )}
        >
          {agent.name}
        </span>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      {cursor}
    </div>
  );
}
