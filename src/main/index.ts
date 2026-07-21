import { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess, type IpcMainInvokeEvent } from "electron";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ApiErrorResponseSchema,
  ApiResponseSchema,
  CancelIncompleteResearchSchema,
  CancelResearchSchema,
  ConfirmBriefSchema,
  CreateBranchRequestSchema,
  CreateThreadRequestSchema,
  DeleteThreadRequestSchema,
  ExportIdeasRequestSchema,
  GenerateIdeasRequestSchema,
  GetIdeaDetailRequestSchema,
  GetReportDetailRequestSchema,
  GetSourceDetailRequestSchema,
  IPC_CHANNELS,
  RateIdeaSchema,
  ResearchEventSchema,
  ResumeResearchSchema,
  SaveFavoriteModelSchema,
  SaveRunConfigSchema,
  SaveSecretsRequestSchema,
  SelectThreadRequestSchema,
  StartResearchSchema,
  SubmitIntakeAnswerSchema,
  type BackendReady,
  type ResearchEvent,
} from "../shared/ipc";
import { AppError } from "../shared/errors";
import { isAllowedRendererUrl, parseExternalHttpsUrl, rendererEntryUrl } from "./security";

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
  const bundledPromptsDir = join(app.getAppPath(), "prompts");
  const promptOverridesDir = join(dataDir, "prompts");
  return { dataDir, dbPath, bundledPromptsDir, promptOverridesDir };
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

function persistSecrets(nextSecrets = secrets): void {
  if (!safeStorage.isEncryptionAvailable()) throw new AppError("secure_storage_unavailable");
  const settingsPath = join(app.getPath("userData"), "secrets.bin");
  const encrypted = safeStorage.encryptString(JSON.stringify(nextSecrets));
  writeFileSync(settingsPath, encrypted);
}

async function startBackendProcess(): Promise<BackendReady> {
  const e2eBackendUrl = process.env.SCRAPLY_E2E_BACKEND_URL;
  const e2eBackendToken = process.env.SCRAPLY_E2E_BACKEND_TOKEN;
  if (process.env.SCRAPLY_E2E === "1" && e2eBackendUrl && e2eBackendToken) {
    const url = new URL(e2eBackendUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
      throw new Error("SCRAPLY_E2E_BACKEND_URL must be an http://127.0.0.1 URL with an explicit port");
    }
    return { port: Number(url.port), token: e2eBackendToken };
  }

  const { dataDir, dbPath, bundledPromptsDir, promptOverridesDir } = getPaths();
  const backendEntry = join(__dirname, "backend.js");

  backendProcess = utilityProcess.fork(backendEntry, [], { serviceName: "scraply-backend" });
  backendProcess.on("exit", (code) => {
    console.error("Backend exited", code);
    backendReady = null;
  });

  backendProcess.on("message", (message) => {
    const payload = message as { type: string; event?: ResearchEvent };
    const event = ResearchEventSchema.safeParse(payload.event);
    if (payload.type === "event" && event.success && mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.BACKEND_EVENT, event.data);
    }
  });

  backendProcess.postMessage({
    type: "start",
    dataDir,
    dbPath,
    bundledPromptsDir,
    promptOverridesDir,
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
  const expectedRendererUrl = rendererEntryUrl(
    join(__dirname, "../renderer/index.html"),
    isDev ? process.env.ELECTRON_RENDERER_URL : undefined,
  );
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    title: "Scraply",
    autoHideMenuBar: true,
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

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url, expectedRendererUrl)) event.preventDefault();
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

async function backendRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!backendReady) throw new AppError("backend_unavailable");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${backendReady.token}`);
  headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${backendReady.port}${path}`, { ...init, headers });
  } catch {
    throw new AppError("backend_unavailable");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = ApiErrorResponseSchema.safeParse(payload);
    if (parsedError.success) {
      throw new AppError(parsedError.data.error.code, parsedError.data.error.message, response.status);
    }
    throw new AppError("internal_error");
  }

  const parsed = ApiResponseSchema(z.unknown()).safeParse(payload);
  if (!parsed.success || !parsed.data.ok) throw new AppError("internal_error");
  return parsed.data.data as T;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? "";
  const expectedRendererUrl = rendererEntryUrl(
    join(__dirname, "../renderer/index.html"),
    isDev ? process.env.ELECTRON_RENDERER_URL : undefined,
  );
  if (!mainWindow || event.sender !== mainWindow.webContents || !isAllowedRendererUrl(senderUrl, expectedRendererUrl)) {
    throw new AppError("unauthorized");
  }
}

function registerIpc(): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return handler(...args);
    });
  };
  const post = <T>(path: string, body: T) => backendRequest(path, { method: "POST", body: JSON.stringify(body) });

  handle(IPC_CHANNELS.GET_VALIDATION, () => backendRequest("/validation?validateOptional=1"));
  handle(IPC_CHANNELS.GET_WORKSPACE, () => backendRequest("/workspace"));
  handle(IPC_CHANNELS.SAVE_SECRETS, async (rawPayload) => {
    const payload = SaveSecretsRequestSchema.parse(rawPayload);
    persistSecrets(payload);
    secrets = payload;
    backendProcess?.postMessage({ type: "update-secrets", ...payload });
    return backendRequest("/validation?validateOptional=1");
  });
  handle(IPC_CHANNELS.IMPORT_ENV, async () => {
    loadDevEnv();
    persistSecrets();
    backendProcess?.postMessage({
      type: "update-secrets",
      opencodeApiKey: secrets.opencodeApiKey ?? "",
      exaApiKey: secrets.exaApiKey ?? "",
    });
    return backendRequest("/validation?validateOptional=1");
  });
  handle(IPC_CHANNELS.OPEN_DATA_FOLDER, async () => {
    await shell.openPath(getPaths().dataDir);
  });
  handle(IPC_CHANNELS.CREATE_THREAD, (body) => post("/threads", CreateThreadRequestSchema.parse(body ?? {})));
  handle(IPC_CHANNELS.SELECT_THREAD, (body) => post("/threads/select", SelectThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.DELETE_THREAD, (body) => post("/threads/delete", DeleteThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.SUBMIT_INTAKE, (body) => post("/intake", SubmitIntakeAnswerSchema.parse(body)));
  handle(IPC_CHANNELS.CONFIRM_BRIEF, (body) => post("/brief/confirm", ConfirmBriefSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_RUN_CONFIG, (body) => post("/run-config", SaveRunConfigSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_FAVORITE_MODEL, (body) => post("/models/favorite", SaveFavoriteModelSchema.parse(body)));
  handle(IPC_CHANNELS.START_RESEARCH, (body) => post("/research/start", StartResearchSchema.parse(body)));
  handle(IPC_CHANNELS.CANCEL_RESEARCH, (body) => post("/research/cancel", CancelResearchSchema.parse(body)));
  handle(IPC_CHANNELS.RESUME_RESEARCH, (body) => post("/research/resume", ResumeResearchSchema.parse(body)));
  handle(IPC_CHANNELS.CANCEL_INCOMPLETE_RESEARCH, (body) => post("/research/cancel-incomplete", CancelIncompleteResearchSchema.parse(body)));
  handle(IPC_CHANNELS.GENERATE_IDEAS, (body) => post("/ideas/generate", GenerateIdeasRequestSchema.parse(body)));
  handle(IPC_CHANNELS.RATE_IDEA, (body) => post("/ideas/rate", RateIdeaSchema.parse(body)));
  handle(IPC_CHANNELS.EXPORT_IDEAS, (body) => post("/ideas/export", ExportIdeasRequestSchema.parse(body)));
  handle(IPC_CHANNELS.CREATE_BRANCH, (body) => post("/threads/branch", CreateBranchRequestSchema.parse(body)));
  handle(IPC_CHANNELS.GET_REPORT_DETAIL, (body) => {
    const { reportId } = GetReportDetailRequestSchema.parse(body);
    return backendRequest(`/reports/${encodeURIComponent(reportId)}`);
  });
  handle(IPC_CHANNELS.GET_SOURCE_DETAIL, (body) => {
    const { sourceId } = GetSourceDetailRequestSchema.parse(body);
    return backendRequest(`/sources/${encodeURIComponent(sourceId)}`);
  });
  handle(IPC_CHANNELS.GET_IDEA_DETAIL, (body) => {
    const { ideaId } = GetIdeaDetailRequestSchema.parse(body);
    return backendRequest(`/ideas/${encodeURIComponent(ideaId)}`);
  });
  handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (body) => {
    await shell.openExternal(parseExternalHttpsUrl(body));
  });
}

const gotLock = process.env.SCRAPLY_E2E === "1" || app.requestSingleInstanceLock();
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
