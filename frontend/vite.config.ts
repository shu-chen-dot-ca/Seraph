import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Read BACKEND_PORT from the project's .env (one folder up), the same file the backend reads.
  // Only BACKEND_* variables are loaded, so no secrets end up here.
  const env = loadEnv(mode, "..", "BACKEND_");
  const backendPort = env.BACKEND_PORT || "8000";

  return {
    plugins: [react()],
    server: {
      // Forward /api/* to the backend, so the browser sees one origin (no CORS).
      // 127.0.0.1, not localhost: Node may resolve localhost to IPv6 (::1), where the backend isn't listening.
      proxy: {
        "/api": `http://127.0.0.1:${backendPort}`,
      },
    },
  };
});
