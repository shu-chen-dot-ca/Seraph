import fs from "node:fs";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The redesign mockups: a separate app with made-up data, so the real frontend (port 5173) is never touched.
// Your picks (Keep / Change / Drop, A / B / C and notes) are saved to picks.json next to this file, so the next
// round can start from them. GET /api/picks reads them all, POST /api/picks saves one { key, choice, note }.
const picksFile = path.resolve(import.meta.dirname, "picks.json");

function readPicks(): Record<string, unknown> {
  if (!fs.existsSync(picksFile)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(picksFile, "utf8"));
}

const picks: Plugin = {
  name: "picks",
  configureServer(server) {
    server.middlewares.use("/api/picks", (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") {
        res.end(JSON.stringify(readPicks()));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      // Read the file only now, once the body is in, so two quick saves can't overwrite each other.
      req.on("end", () => {
        const pick = JSON.parse(body);
        const all = readPicks();
        all[pick.key] = { choice: pick.choice, note: pick.note, at: new Date().toISOString() };
        fs.writeFileSync(picksFile, JSON.stringify(all, null, 2) + "\n");
        res.end(JSON.stringify(all));
      });
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), picks],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  // The real app's vite is on 5173, so this one is on 5174 and both can run at once.
  server: { port: 5174, strictPort: true },
});
