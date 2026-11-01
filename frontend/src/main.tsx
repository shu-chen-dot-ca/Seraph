import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import App from "./App";

// An error on a page is one of the app's own errors (github_searcher/crashes.py, POST /api/errors), which its agent
// turns into an issue. Never more than one report a second, so a loop of errors can't flood it.
// The browser's own noise, not the app's errors: the backend down for a moment, a resize that took two frames.
const NOISE = ["Failed to fetch", "NetworkError", "Load failed", "ResizeObserver loop"];
let lastReport = 0;
function report(message: string, stack: string) {
  if (Date.now() - lastReport < 1000 || NOISE.some((noise) => message.includes(noise))) {
    return;
  }
  lastReport = Date.now();
  const body = JSON.stringify({ message, stack, page: window.location.hash || "#/" });
  fetch("/api/errors", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {
    // The backend is down (an update restarts it): nothing to report to.
  });
}
window.addEventListener("error", (event) => {
  report(event.message, event.error instanceof Error ? (event.error.stack ?? "") : `${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  report(reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? (reason.stack ?? "") : "");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
