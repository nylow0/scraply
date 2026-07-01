import { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess } from "electron";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS, type BackendReady, type ResearchEvent } from "../shared/ipc";

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("use-gl", "swiftshader");
app.disableHardwareAcceleration();

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let backendReady: BackendReady | null = null;
let backendProcess: Electron.UtilityProcess | null = null;

interface StoredSecrets {
  opencodeApiKey: string | null;
  exaApiKey: string | null;
}

let secrets: StoredSecrets = { opencodeApiKey: null, exaApiKey: null };

function getPaths() {
  const dataDir = join(app.getPath("userData"), "scraply");
  const dbPath = join(dataDir, "scraply.db");
  return { dataDir, dbPath };
}

function loadDevEnv(): void {
  if (!isDev || process.env.SCRAPLY_E2E === "1") return;
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key === "OPENCODE_API_KEY" && value) secrets.opencodeApiKey = value;
    if (key === "EXA_API_KEY" && value) secrets.exaApiKey = value;
  }
}

function loadStoredSecrets(): void {
  const settingsPath = join(app.getPath("userData"), "secrets.bin");
  if (!existsSync(settingsPath) || !safeStorage.isEncryptionAvailable()) return;
  try {
    const raw = safeStorage.decryptString(readFileSync(settingsPath));
    const parsed = JSON.parse(raw) as StoredSecrets;
    secrets = parsed;
  } catch {
    // ignore corrupt secrets file
  }
}

function persistSecrets(): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  const settingsPath = join(app.getPath("userData"), "secrets.bin");
  const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
  writeFileSync(settingsPath, encrypted);
}

async function startBackendProcess(): Promise<BackendReady> {
  const { dataDir, dbPath } = getPaths();
  const backendEntry = join(__dirname, "backend.js");

  backendProcess = utilityProcess.fork(backendEntry, [], { serviceName: "scraply-backend" });
  backendProcess.on("exit", (code) => {
    console.error("Backend exited", code);
    backendReady = null;
  });

  backendProcess.on("message", (message) => {
    const payload = message as { type: string; event?: ResearchEvent };
    if (payload.type === "event" && payload.event && mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.BACKEND_EVENT, payload.event);
    }
  });

  backendProcess.postMessage({
    type: "start",
    dataDir,
    dbPath,
    opencodeApiKey: secrets.opencodeApiKey,
    exaApiKey: secrets.exaApiKey,
  });

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Backend startup timed out")), 15000);
    backendProcess?.on("message", (message) => {
      const payload = message as { type: string; port?: number; token?: string };
      if (payload.type === "ready" && payload.port && payload.token) {
        clearTimeout(timer);
        resolve({ port: payload.port, token: payload.token });
      }
    });
  });
}

function createWindow(): void {
  const iconPath = join(process.cwd(), "build/icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    title: "Scraply",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`,
  ].join("; ");

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    if (process.env.SCRAPLY_E2E !== "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!backendReady) throw new Error("Backend is not ready");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${backendReady.token}`);
  headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${backendReady.port}${path}`, { ...init, headers });
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.GET_BACKEND, () => backendReady);
  ipcMain.handle(IPC_CHANNELS.GET_VALIDATION, async () => (await backendFetch("/validation")).json());
  ipcMain.handle(IPC_CHANNELS.GET_WORKSPACE, async () => (await backendFetch("/workspace")).json());
  ipcMain.handle(IPC_CHANNELS.SAVE_SECRETS, async (_event, payload: { opencodeApiKey: string; exaApiKey: string }) => {
    secrets = { opencodeApiKey: payload.opencodeApiKey, exaApiKey: payload.exaApiKey };
    persistSecrets();
    backendProcess?.postMessage({ type: "update-secrets", ...payload });
    return (await backendFetch("/validation")).json();
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_ENV, async () => {
    loadDevEnv();
    persistSecrets();
    backendProcess?.postMessage({
      type: "update-secrets",
      opencodeApiKey: secrets.opencodeApiKey ?? "",
      exaApiKey: secrets.exaApiKey ?? "",
    });
    return (await backendFetch("/validation")).json();
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_DATA_FOLDER, async () => {
    await shell.openPath(getPaths().dataDir);
  });

  const proxy = async (path: string, init?: RequestInit) => (await backendFetch(path, init)).json();
  ipcMain.handle(IPC_CHANNELS.CREATE_THREAD, (_e, body) => proxy("/threads", { method: "POST", body: JSON.stringify(body ?? {}) }));
  ipcMain.handle(IPC_CHANNELS.SELECT_THREAD, (_e, body) => proxy("/threads/select", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.DELETE_THREAD, (_e, body) => proxy("/threads/delete", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.SUBMIT_INTAKE, (_e, body) => proxy("/intake", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CONFIRM_BRIEF, (_e, body) => proxy("/brief/confirm", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.SAVE_RUN_CONFIG, (_e, body) => proxy("/run-config", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.START_RESEARCH, (_e, body) => proxy("/research/start", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CANCEL_RESEARCH, (_e, body) => proxy("/research/cancel", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.RESUME_RESEARCH, (_e, body) => proxy("/research/resume", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CANCEL_INCOMPLETE_RESEARCH, (_e, body) => proxy("/research/cancel-incomplete", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.GENERATE_IDEAS, (_e, body) => proxy("/ideas/generate", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.RATE_IDEA, (_e, body) => proxy("/ideas/rate", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.EXPORT_IDEAS, (_e, body) => proxy("/ideas/export", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CREATE_BRANCH, (_e, body) => proxy("/threads/branch", { method: "POST", body: JSON.stringify(body) }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    loadStoredSecrets();
    loadDevEnv();
    registerIpc();
    createWindow();
    try {
      backendReady = await startBackendProcess();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    } catch (error) {
      console.error("Backend startup failed", error);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    backendProcess?.kill();
  });
}
