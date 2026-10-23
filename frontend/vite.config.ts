import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Read BACKEND_PORT from the project's .env (one folder up), the same file the backend reads.
  // Only BACKEND_* variables are loaded, so no secrets end up here.
  const env = loadEnv(mode, "..", "BACKEND_");
  const backendPort = env.BACKEND_PORT || "8000";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // "@/live" means "src/live", the same alias tsconfig.json declares.
      alias: { "@": path.resolve(import.meta.dirname, "src") },
    },
    // One bundle for a local app is fine; don't warn about its size.
    build: { chunkSizeWarningLimit: 2000 },
    server: {
      // Forward /api/* to the backend, so the browser sees one origin (no CORS).
      // ws: true also forwards the /api/live websocket.
      // 127.0.0.1, not localhost: Node may resolve localhost to IPv6 (::1), where the backend isn't listening.
      proxy: {
        "/api": { target: `http://127.0.0.1:${backendPort}`, ws: true },
      },
    },
  };
});
