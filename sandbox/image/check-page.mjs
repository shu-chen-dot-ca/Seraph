// Opens one page of the demo app in headless Chromium inside the sandbox and
// prints, as JSON, what the setup agent needs to judge it: HTTP status, title,
// visible text, console errors, failed requests, requests to other local ports
// (the user's browser can only reach the app's own port) and a screenshot.
// Used by check_app in sandbox/vm.py.
//
//     node /opt/sandbox/check-page.mjs <port> <path>

import { chromium } from "playwright";

const port = Number(process.argv[2]);
const path = process.argv[3] || "/";
const url = `http://localhost:${port}${path}`;

const MAX_ITEMS = 20;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

const errors = [];
const failedRequests = [];
const otherPorts = new Set();

function add(list, text) {
  if (list.length < MAX_ITEMS) list.push(String(text).slice(0, 500));
}

/** A request to this machine on a port other than the app's: fine here, unreachable for the user. */
function isOtherLocalPort(target) {
  if (!["http:", "https:", "ws:", "wss:"].includes(target.protocol)) return false;
  const local = LOCAL_HOSTS.has(target.hostname) || target.hostname.endsWith(".localhost");
  const defaultPort = target.protocol === "https:" || target.protocol === "wss:" ? 443 : 80;
  return local && Number(target.port || defaultPort) !== port;
}

const result = { url, status: null, title: "", text: "", errors, failed_requests: failedRequests, other_ports: [] };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (message) => message.type() === "error" && add(errors, message.text()));
  page.on("pageerror", (error) => add(errors, error));
  page.on("requestfailed", (request) => {
    if (!isOtherLocalPort(new URL(request.url()))) {
      add(failedRequests, `${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      add(failedRequests, `${response.request().method()} ${response.url()}: HTTP ${response.status()}`);
    }
  });
  page.on("websocket", (socket) => isOtherLocalPort(new URL(socket.url())) && otherPorts.add(socket.url()));
  // Fail these like the user's browser would, so the screenshot shows what the user will see.
  await page.route(isOtherLocalPort, (route) => {
    otherPorts.add(route.request().url());
    return route.abort();
  });

  try {
    const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    result.status = response ? response.status() : null;
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  } catch (error) {
    add(errors, `Loading ${url} failed: ${error.message}`);
  }

  result.title = await page.title().catch(() => "");
  result.text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 2000);
  const screenshot = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
  result.screenshot = screenshot ? screenshot.toString("base64") : null;
} finally {
  await browser.close();
}

result.other_ports = [...otherPorts].slice(0, MAX_ITEMS);
process.stdout.write(JSON.stringify(result));
