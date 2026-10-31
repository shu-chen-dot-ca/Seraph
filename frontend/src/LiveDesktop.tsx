/*
A VM's screen, live: noVNC's client (RFB) draws only the screen into the box, scaled to fit, none of noVNC's page
around it. A dropped connection tries again every 2 seconds. viewOnly keeps the mouse and keyboard out; it can change
without connecting again (a lock comes and goes while the agent works).

The agent page's Desktop (AgentChat.tsx) uses it view-only. Through the remote access domain (REMOTE) the VM page
(VMPage.tsx) uses it too, instead of noVNC's page from the VM in an iframe:
the phone can't reach the VM's address, and an https page can't load http. Its VNC connection then passes through
the backend (the websocket /api/vms/{name}/vnc).
*/

import RFB from "@novnc/novnc";
import { useEffect, useRef } from "react";

// The page came through the remote access domain, not from this computer.
export const REMOTE = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";

export default function LiveDesktop(props: { url: string; viewOnly: boolean; className?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  // Read by each new connection, so one made while locked starts locked.
  const viewOnlyRef = useRef(props.viewOnly);

  // Declared before the connection below, so the first connection already reads the right value.
  useEffect(() => {
    viewOnlyRef.current = props.viewOnly;
    if (rfbRef.current !== null) {
      rfbRef.current.viewOnly = props.viewOnly;
    }
  }, [props.viewOnly]);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) {
      return;
    }
    let stopped = false;
    let timer = 0;
    // An arrow function, not a declaration: it keeps box narrowed to not null.
    const connect = () => {
      const rfb = new RFB(box, props.url);
      rfb.viewOnly = viewOnlyRef.current;
      rfb.scaleViewport = true;
      rfb.focusOnClick = !viewOnlyRef.current;
      rfb.background = "black";
      rfb.addEventListener("disconnect", () => {
        // A disconnected RFB is done for good: the next try is a new one. The old one's event can come after a new
        // one was made (a new url): that one stays.
        if (rfbRef.current === rfb) {
          rfbRef.current = null;
        }
        if (!stopped) {
          timer = window.setTimeout(connect, 2000);
        }
      });
      rfbRef.current = rfb;
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (rfbRef.current !== null) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };
  }, [props.url]);

  return <div ref={boxRef} className={props.className} />;
}
