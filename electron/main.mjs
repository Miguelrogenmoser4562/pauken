/* Pauken desktop shell.
 *
 * The app is a local web app. This shell:
 *   1. starts the local server (serves the built UI + API) on launch
 *   2. opens a window pointed at it
 *   3. keeps the server alive — if it ever stops answering, it's restarted so
 *      the window is never left showing a dead page
 *   4. shuts the server down on quit
 *
 * Developers can run the exact same server with `npm run serve`.
 * Multi-user mode requires connecting to a separate Pauken server (see Settings).
 */

import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/httpServer.mjs";

/* Load .env from project root so the Electron app picks up
   DEEPSEEK_API_KEY and other server configuration. */
{
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* .env absent — that's fine */ }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 4180;
const PORT_FILE = path.join(app.getPath("userData"), "pauken-port.txt");

let mainWindow = null;
let serverInfo = null;
let healthTimer = null;

function readSavedPort() {
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf8").trim();
    const p = parseInt(raw, 10);
    return Number.isFinite(p) && p >= 1024 && p <= 65535 ? p : null;
  } catch {
    return null;
  }
}

function savePort(port) {
  try {
    fs.writeFileSync(PORT_FILE, String(port), "utf8");
  } catch {
    /* non-critical */
  }
}

async function tryPort(port) {
  try {
    const info = await startServer({
      distDir: path.join(__dirname, "..", "dist"),
      host: "127.0.0.1",
      port,
    });
    return info;
  } catch {
    return null;
  }
}

async function resolvePort() {
  const saved = readSavedPort();
  if (saved) {
    const info = await tryPort(saved);
    if (info) return info;
  }
  const want = await tryPort(DEFAULT_PORT);
  if (want) return want;
  for (let p = DEFAULT_PORT + 1; p < DEFAULT_PORT + 20; p++) {
    const info = await tryPort(p);
    if (info) return info;
  }
  return tryPort(0);
}

async function ensureServer() {
  if (serverInfo) {
    try {
      const res = await fetch(`${serverInfo.url}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return serverInfo;
    } catch {
      /* server died — fall through and restart */
    }
    try {
      serverInfo.server.close();
    } catch {
      /* already closed */
    }
    serverInfo = null;
  }
  serverInfo = await resolvePort();
  if (serverInfo) savePort(serverInfo.port);
  return serverInfo;
}

/* Poll health; if the server is gone, restart it and reload the window so the
   user never sees a blank/broken page. */
function startHealthWatch() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow) return;
    const before = serverInfo?.url;
    const info = await ensureServer();
    if (info.url !== before) {
      mainWindow.loadURL(info.url);
    }
  }, 5000);
}

async function createWindow() {
  const info = await ensureServer();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#faf7f5",
    title: "Pauken",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank / external links in the system browser, not a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(info.url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(info.url);
  startHealthWatch();
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* Tear the local server down when the app exits. */
app.on("will-quit", () => {
  clearInterval(healthTimer);
  if (serverInfo) {
    try {
      serverInfo.server.close();
    } catch {
      /* already closed */
    }
    serverInfo = null;
  }
});
