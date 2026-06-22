import { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess } from "electron";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS, GetReportRequestSchema, SaveSecretsRequestSchema, type BackendReady, type ResearchEvent } from "../shared/ipc";

const isDev = !app.isPackaged;
const APP_USER_MODEL_ID = "com.scraply.app";
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

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveEnvImportPath(): string | null {
  const { dataDir } = getPaths();
  const candidates = [
    join(dataDir, ".env"),
    ...(isDev ? [join(process.cwd(), ".env"), join(__dirname, "../../.env")] : []),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadEnvFile(): boolean {
  if (process.env.SCRAPLY_E2E === "1") return false;
  const envPath = resolveEnvImportPath();
  if (!envPath) return false;

  let loaded = false;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = parseEnvValue(trimmed.slice(idx + 1));
    if (key === "OPENCODE_API_KEY" && value) {
      secrets.opencodeApiKey = value;
      loaded = true;
    }
    if (key === "EXA_API_KEY" && value) {
      secrets.exaApiKey = value;
      loaded = true;
    }
  }

  if (loaded && secrets.opencodeApiKey && secrets.exaApiKey) {
    persistSecrets();
  }
  return loaded;
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

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Backend startup timed out")), 15000);

    backendProcess?.on("message", (message) => {
      const payload = message as {
        type: string;
        port?: number;
        token?: string;
        message?: string;
        event?: ResearchEvent;
      };

      if (payload.type === "error") {
        clearTimeout(timer);
        reject(new Error(payload.message ?? "Backend failed to start"));
        return;
      }

      if (payload.type === "event" && payload.event && mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.BACKEND_EVENT, payload.event);
        return;
      }

      if (payload.type === "ready" && payload.port && payload.token) {
        clearTimeout(timer);
        resolve({ port: payload.port, token: payload.token });
      }
    });

    backendProcess?.postMessage({
      type: "start",
      dataDir,
      dbPath,
      opencodeApiKey: secrets.opencodeApiKey,
      exaApiKey: secrets.exaApiKey,
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
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  if (process.env.SCRAPLY_DEVTOOLS === "1" && process.env.SCRAPLY_E2E !== "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!backendReady) throw new Error("Backend is not ready");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${backendReady.token}`);
  headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${backendReady.port}${path}`, { ...init, headers });
}

async function proxyJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await backendFetch(path, init);
  const text = await response.text();
  let body: { error?: string } = {};
  if (text) {
    try {
      body = JSON.parse(text) as { error?: string };
    } catch {
      throw new Error(`Invalid backend response (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return body;
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.GET_BACKEND, () => backendReady);
  ipcMain.handle(IPC_CHANNELS.GET_VALIDATION, async () => proxyJson("/validation"));
  ipcMain.handle(IPC_CHANNELS.TEST_MODELS, async (_e, body: { models: string[] }) =>
    proxyJson("/validation/test-models", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.GET_WORKSPACE, async () => proxyJson("/workspace"));
  ipcMain.handle(IPC_CHANNELS.SAVE_SECRETS, async (_event, payload: unknown) => {
    const input = SaveSecretsRequestSchema.parse(payload);
    secrets = {
      opencodeApiKey: input.opencodeApiKey.trim(),
      exaApiKey: input.exaApiKey.trim(),
    };
    persistSecrets();
    backendProcess?.postMessage({
      type: "update-secrets",
      opencodeApiKey: secrets.opencodeApiKey,
      exaApiKey: secrets.exaApiKey,
    });
    return proxyJson("/validation");
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_ENV, async () => {
    if (!loadEnvFile()) {
      throw new Error(
        "No .env file found. Add OPENCODE_API_KEY and EXA_API_KEY to a .env file in your Scraply data folder.",
      );
    }
    backendProcess?.postMessage({
      type: "update-secrets",
      opencodeApiKey: secrets.opencodeApiKey ?? "",
      exaApiKey: secrets.exaApiKey ?? "",
    });
    return proxyJson("/validation");
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_DATA_FOLDER, async () => {
    await shell.openPath(getPaths().dataDir);
  });

  ipcMain.handle(IPC_CHANNELS.CREATE_THREAD, (_e, body) => proxyJson("/threads", { method: "POST", body: JSON.stringify(body ?? {}) }));
  ipcMain.handle(IPC_CHANNELS.SELECT_THREAD, (_e, body) => proxyJson("/threads/select", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.DELETE_THREAD, (_e, body) => proxyJson("/threads/delete", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.SUBMIT_INTAKE, (_e, body) => proxyJson("/intake", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CONFIRM_BRIEF, (_e, body) => proxyJson("/brief/confirm", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.SAVE_RUN_CONFIG, (_e, body) => proxyJson("/run-config", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.START_RESEARCH, (_e, body) => proxyJson("/research/start", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.LAUNCH_RESEARCH, (_e, body) => proxyJson("/research/launch", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.SAVE_DRAFT, (_e, body) => proxyJson("/draft/save", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CANCEL_RESEARCH, (_e, body) => proxyJson("/research/cancel", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.RESUME_RESEARCH, (_e, body) => proxyJson("/research/resume", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CANCEL_INCOMPLETE_RESEARCH, (_e, body) => proxyJson("/research/cancel-incomplete", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.GENERATE_IDEAS, (_e, body) => proxyJson("/ideas/generate", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.RATE_IDEA, (_e, body) => proxyJson("/ideas/rate", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.EXPORT_IDEAS, (_e, body) => proxyJson("/ideas/export", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.CREATE_BRANCH, (_e, body) => proxyJson("/threads/branch", { method: "POST", body: JSON.stringify(body) }));
  ipcMain.handle(IPC_CHANNELS.GET_REPORT, async (_e, body: unknown) => {
    const input = GetReportRequestSchema.parse(body);
    return proxyJson(`/reports/${encodeURIComponent(input.reportId)}`);
  });
}

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName("Scraply");

  app.whenReady().then(async () => {
    loadStoredSecrets();
    loadEnvFile();
    registerIpc();
    try {
      backendReady = await startBackendProcess();
    } catch (error) {
      console.error("Backend failed to start:", error);
    }
    createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    backendProcess?.kill();
  });
}
