import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "@primer/octicons-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "github-markdown-css/github-markdown.css";
import "./styles.css";
import Explore from "./explore/Explore";
import Sessions from "./vm/Sessions";

// The tab the user was on, so a refresh opens it again.
let savedTab = "explore";
try {
  savedTab = localStorage.getItem("tab") ?? "explore";
} catch {
  savedTab = "explore";
}

// Both tabs stay mounted, the hidden one keeps its state: switching back finds the search, chats and VM connections as they were.
function App() {
  const [tab, setTab] = useState<"explore" | "vm">(savedTab === "vm" ? "vm" : "explore");
  const [leftOpen, setLeftOpen] = useState(true);

  // Remember the tab for the next refresh. Storage can be blocked (private window): then it just isn't kept.
  useEffect(() => {
    try {
      localStorage.setItem("tab", tab);
    } catch {
      return;
    }
  }, [tab]);

  // Ctrl+B folds the left panel. Ctrl+Alt+B and Esc are handled by each tab.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && !event.altKey && event.code === "KeyB") {
        event.preventDefault();
        setLeftOpen(!leftOpen);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Top of the left panel in both tabs: its fold tab, and the Explore / VM Sessions switch above it.
  const tabs = (
    <>
      <button
        className="fold-tab"
        type="button"
        aria-label={leftOpen ? "Hide chat and query" : "Show chat and query"}
        title={leftOpen ? "Hide chat and query" : "Show chat and query"}
        onClick={() => setLeftOpen(!leftOpen)}
      >
        {leftOpen ? <ChevronLeftIcon size={12} /> : <ChevronRightIcon size={12} />}
      </button>
      <div className="view-toggle left-tabs">
        <button className={tab === "explore" ? "view-toggle-on" : ""} type="button" aria-pressed={tab === "explore"} onClick={() => setTab("explore")}>
          Explore
        </button>
        <button className={tab === "vm" ? "view-toggle-on" : ""} type="button" aria-pressed={tab === "vm"} onClick={() => setTab("vm")}>
          VM Sessions
        </button>
      </div>
    </>
  );

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="app-logo" href="/">
            <SearchIcon size={24} />
            <span className="app-name">Searcher</span>
          </a>
        </div>
      </header>

      <Explore active={tab === "explore"} leftOpen={leftOpen} tabs={tabs} />
      <Sessions active={tab === "vm"} leftOpen={leftOpen} tabs={tabs} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
