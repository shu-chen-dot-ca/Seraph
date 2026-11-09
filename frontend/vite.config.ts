import { execSync } from "node:child_process";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// This repo on GitHub, for the header's link (App.tsx), from git's origin remote: no account name written in the code.
// git@github.com:owner/name.git and https://github.com/owner/name.git both become https://github.com/owner/name.
// "" when there is no origin remote, or it isn't on GitHub: the header has no link then. A release of the live copy
// (deploy/) isn't a git checkout: SERAPH_REPO from its .env (owner/name) gives the link there.
let repoUrl = "";
try {
  const remote = execSync("git remote get-url origin", { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  repoUrl = match === null ? "" : `https://github.com/${match[1]}`;
} catch {
  // Not a git checkout, or no origin remote.
}

export default defineConfig(({ mode }) => {
  // Read BACKEND_PORT, REMOTE_ACCESS_DOMAIN and SERAPH_REPO from the project's .env (one folder up), the same file the
  // backend reads. Only BACKEND_*, REMOTE_ACCESS_* and SERAPH_* variables are loaded, so no secrets end up here.
  const env = loadEnv(mode, "..", ["BACKEND_", "REMOTE_ACCESS_", "SERAPH_"]);
  const backendPort = env.BACKEND_PORT || "8000";
  // Remote access (remote_access/README.md): Caddy passes the app's files on from that address, after a sign in.
  const remoteDomain = (env.REMOTE_ACCESS_DOMAIN || "").trim();

  return {
    plugins: [react(), tailwindcss()],
    define: { __REPO_URL__: JSON.stringify(repoUrl !== "" || !env.SERAPH_REPO ? repoUrl : `https://github.com/${env.SERAPH_REPO}`) },
    resolve: {
      // "@/live" means "src/live", the same alias tsconfig.json declares.
      alias: { "@": path.resolve(import.meta.dirname, "src") },
    },
    // One bundle for a local app is fine; don't warn about its size.
    build: { chunkSizeWarningLimit: 2000 },
    server: {
      // localhost always; the remote access address too, once it is set.
      allowedHosts: remoteDomain === "" ? [] : [remoteDomain],
      // Forward /api/* to the backend, so the browser sees one origin (no CORS).
      // ws: true also forwards the /api/live websocket.
      // 127.0.0.1, not localhost: Node may resolve localhost to IPv6 (::1), where the backend isn't listening.
      // When the browser's side of a websocket closes, the backend's side is closed too: the proxy only half-closes it
      // and stops reading, so the backend's live feed got stuck sending into it, and every backend reload waited on it.
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${backendPort}`,
          ws: true,
          configure: (proxy) => {
            proxy.on("proxyReqWs", (proxyReq, _req, socket) => {
              proxyReq.on("upgrade", (_res, proxySocket) => {
                socket.on("close", () => proxySocket.destroy());
              });
            });
          },
        },
      },
    },
  };
});
