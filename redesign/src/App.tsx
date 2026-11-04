import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import MockApp from "@/MockApp";
import Proposal from "@/Proposal";
import { EMPTY_STORE, StoreContext, type Store } from "@/store";

/*
The redesign app. #/ is this round's page (Proposal.tsx); every other address is the mock Seraph (MockApp.tsx,
addresses in links.tsx). A thin bar at the very top, outside the mock, shows it at phone width, starts over
(Reset forgets everything you did in the mock), and sets the theme. What you do in the mock lives here (store.tsx),
so switching to Phone keeps it.
*/

export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const [store, setStore] = useState<Store>(EMPTY_STORE);
  const [phone, setPhone] = useState(false);
  const [dark, setDark] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    function onHashChange() {
      setHash(window.location.hash);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    let timer = 0;
    function onToast(event: Event) {
      setMessage((event as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(""), 3500);
    }
    window.addEventListener("toast", onToast);
    return () => window.removeEventListener("toast", onToast);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // "#/p/tabularis/w1" → ["p", "tabularis", "w1"]. No address at all is the round's page.
  const parts = hash.replace(/^#\/?/, "").split("/");
  const onProposal = parts[0] === "";

  return (
    <StoreContext.Provider value={{ store, update: (change) => setStore(change) }}>
      <div className="flex h-full flex-col">
        <div className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-b border-dashed bg-muted px-3 text-xs whitespace-nowrap text-muted-foreground">
          <a href="#/" className={cn("font-medium hover:text-foreground", onProposal && "text-foreground")}>
            Seraph redesign · Round 3
          </a>
          {onProposal && (
            <a href="#/questions" className="text-primary hover:underline">
              Open the mockup →
            </a>
          )}
          <span className="ml-auto" />
          {!onProposal && (
            <>
              <button type="button" className={cn("hover:text-foreground", phone && "font-medium text-primary")} onClick={() => setPhone(!phone)}>
                Phone
              </button>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => {
                  setStore(EMPTY_STORE);
                  setMessage("Started over.");
                }}
              >
                Reset
              </button>
            </>
          )}
          <button type="button" className="hover:text-foreground" onClick={() => setDark(!dark)}>
            {dark ? "Light" : "Dark"}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {onProposal && <Proposal />}
          {!onProposal && !phone && <MockApp parts={parts} />}
          {!onProposal && phone && (
            <div className="flex h-full items-center justify-center overflow-auto bg-muted p-4">
              <div className="h-[780px] max-h-full w-[390px] max-w-full overflow-hidden rounded-[32px] border-8 border-sidebar-accent shadow-overlay">
                <MockApp parts={parts} />
              </div>
            </div>
          )}
        </div>
        {message && (
          <div className="fixed bottom-4 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-xs text-background shadow-overlay">{message}</div>
        )}
      </div>
    </StoreContext.Provider>
  );
}
