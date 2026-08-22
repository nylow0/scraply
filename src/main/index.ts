import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ApiErrorResponseSchema,
  ApiResponseSchema,
  CancelResearchSchema,
  CreateThreadRequestSchema,
  DeleteThreadRequestSchema,
  ExportIdeasRequestSchema,
  ExportResearchRequestSchema,
  GetIdeaDetailRequestSchema,
  GetSourceDetailRequestSchema,
  IPC_CHANNELS,
  ResumeResearchSchema,
  SaveFavoriteModelSchema,
  SaveRunConfigSchema,
  SaveScopeSchema,
  SelectProblemsSchema,
  SelectThreadRequestSchema,
  StartResearchSchema,
  type BackendReady,
  type ValidationState,
} from "../shared/ipc";
import { BackendToMainMessageSchema, type BackendSecrets } from "../shared/backend-process";
import { AppError } from "../shared/errors";
import { createFileLogger, type FileLogger } from "./logging";
import { isAllowedRendererUrl, parseExternalHttpsUrl, rendererEntryUrl } from "./security";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let backendReady: BackendReady | null = null;
let backendProcess: Electron.UtilityProcess | null = null;
let backendStartPromise: Promise<BackendReady> | null = null;
let backendStartupFailure: string | null = null;
let logger: FileLogger | null = null;
let isQuitting = false;

interface PendingSecretUpdate {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingSecretUpdates = new Map<string, PendingSecretUpdate>();
let secrets: BackendSecrets = { exaApiKey: null };

function secretValues(): string[] {
  return [secrets.exaApiKey].filter((value): value is string => Boolean(value));
}

function getPaths() {
  const dataDir = join(app.getPath("userData"), "scraply");
  const dbPath = join(dataDir, "scraply.db");
  const logsDir = join(dataDir, "logs");
  const bundledPromptsDir = join(app.getAppPath(), "prompts");
  const promptOverridesDir = join(dataDir, "prompts");
  return { dataDir, dbPath, logsDir, bundledPromptsDir, promptOverridesDir };
}

function readAutomaticSecrets(): Partial<BackendSecrets> {
  const candidate: Partial<BackendSecrets> = {};
  const environmentKey = process.env.EXA_API_KEY?.trim();
  if (environmentKey) candidate.exaApiKey = environmentKey;
  if (!isDev || process.env.SCRAPLY_E2E === "1") return candidate;
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return candidate;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key === "EXA_API_KEY" && value) candidate.exaApiKey = value;
  }
  return candidate;
}

function loadStoredSecrets(): void {
  const settingsPath = join(app.getPath("userData"), "secrets.bin");
  if (!existsSync(settingsPath) || !safeStorage.isEncryptionAvailable()) return;
  try {
    const raw = safeStorage.decryptString(readFileSync(settingsPath));
    const parsed = JSON.parse(raw) as Partial<BackendSecrets>;
    secrets = { exaApiKey: typeof parsed.exaApiKey === "string" ? parsed.exaApiKey : null };
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
    backendStartupFailure = null;
    return { port: Number(url.port), token: e2eBackendToken };
  }

  const { dataDir, dbPath, bundledPromptsDir, promptOverridesDir } = getPaths();
  const useE2eBackend = process.env.SCRAPLY_E2E === "1" && process.env.SCRAPLY_E2E_REAL_BACKEND === "1";
  const backendEntry = join(__dirname, useE2eBackend ? "backend-e2e.js" : "backend.js");
  logger?.log({ level: "info", component: "main", event: "backend-starting" });
  const processHandle = utilityProcess.fork(backendEntry, [], { serviceName: "scraply-backend" });
  backendProcess = processHandle;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = "Backend startup timed out";
      backendStartupFailure = message;
      if (backendProcess === processHandle) backendProcess = null;
      processHandle.kill();
      reject(new Error(message));
    }, 15_000);

    const rejectPendingUpdates = (message: string): void => {
      for (const [requestId, pending] of pendingSecretUpdates) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
        pendingSecretUpdates.delete(requestId);
      }
    };

    processHandle.on("message", (rawMessage) => {
      const parsed = BackendToMainMessageSchema.safeParse(rawMessage);
      if (!parsed.success) return;
      const message = parsed.data;

      if (message.type === "event" && mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.BACKEND_EVENT, message.event);
        return;
      }
      if (message.type === "secrets-updated") {
        const pending = pendingSecretUpdates.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingSecretUpdates.delete(message.requestId);
        pending.resolve();
        return;
      }
      if (message.type === "log") {
        let error: Error | undefined;
        if (message.error) {
          error = new Error(message.error.message);
          error.name = message.error.name;
          if (message.error.stack) error.stack = message.error.stack;
        }
        logger?.log({
          level: message.level,
          component: "backend",
          event: message.event,
          ...(message.message ? { message: message.message } : {}),
          ...(message.context ? { context: message.context } : {}),
          ...(error ? { error } : {}),
        });
        return;
      }
      if (settled) return;
      if (message.type === "ready") {
        settled = true;
        clearTimeout(timer);
        backendStartupFailure = null;
        logger?.log({ level: "info", component: "main", event: "backend-ready" });
        resolve({ port: message.port, token: message.token });
      } else if (message.type === "startup-failed") {
        settled = true;
        clearTimeout(timer);
        backendStartupFailure = message.message;
        logger?.log({ level: "error", component: "backend", event: "backend-startup-failed", message: message.message });
        reject(new Error(message.message));
      }
    });

    processHandle.on("error", (error) => {
      const message = `The local backend process failed: ${error}.`;
      if (backendProcess === processHandle) backendStartupFailure = message;
      logger?.log({ level: "error", component: "main", event: "backend-process-error", message });
      rejectPendingUpdates(message);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    });

    processHandle.on("exit", (code) => {
      const expectedShutdown = isQuitting && code === 0;
      const message = expectedShutdown
        ? "The local backend stopped during app shutdown."
        : backendStartupFailure ?? `The local backend exited unexpectedly (code ${code}).`;
      const isCurrentProcess = backendProcess === processHandle;
      if (isCurrentProcess) {
        backendProcess = null;
        backendReady = null;
        backendStartupFailure = expectedShutdown ? null : message;
      }
      logger?.log({
        level: code === 0 ? "info" : "error",
        component: "main",
        event: "backend-exit",
        message,
        context: { exitCode: code },
      });
      if (isCurrentProcess && !expectedShutdown) rejectPendingUpdates(message);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    });

    processHandle.postMessage({
      type: "start",
      dataDir,
      dbPath,
      bundledPromptsDir,
      promptOverridesDir,
      appVersion: app.getVersion(),
      secrets,
    });
  });
}

async function ensureBackend(): Promise<BackendReady> {
  if (backendReady) return backendReady;
  if (!backendStartPromise) {
    backendStartPromise = startBackendProcess()
      .then((ready) => {
        backendReady = ready;
        return ready;
      })
      .catch((error) => {
        backendStartupFailure = error instanceof Error ? error.message : "The local backend failed to start.";
        throw error;
      })
      .finally(() => {
        backendStartPromise = null;
      });
  }
  return backendStartPromise;
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
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    logger?.log({
      level: "error",
      component: "renderer",
      event: "renderer-load-failed",
      message: errorDescription,
      context: { code: errorCode },
    });
  });
  mainWindow.webContents.on("preload-error", (_event, _preloadPath, error) => {
    logger?.log({ level: "error", component: "renderer", event: "preload-error", error });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logger?.log({
      level: "error",
      component: "renderer",
      event: "renderer-process-gone",
      context: { reason: details.reason, exitCode: details.exitCode },
    });
  });
  mainWindow.on("unresponsive", () => {
    logger?.log({ level: "warn", component: "renderer", event: "renderer-unresponsive" });
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
  let ready = backendReady;
  if (!ready) {
    try {
      ready = await ensureBackend();
    } catch {
      throw new AppError("backend_unavailable", backendStartupFailure ?? "The local backend is unavailable.");
    }
  }
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${ready.token}`);
  headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${ready.port}${path}`, { ...init, headers });
  } catch {
    throw new AppError("backend_unavailable");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = ApiErrorResponseSchema.safeParse(payload);
    if (parsedError.success) {
      const { code, message, reference } = parsedError.data.error;
      throw new AppError(
        code,
        reference ? `${message} Reference: ${reference}` : message,
        response.status,
        reference,
      );
    }
    throw new AppError("internal_error");
  }

  const parsed = ApiResponseSchema(z.unknown()).safeParse(payload);
  if (!parsed.success || !parsed.data.ok) throw new AppError("internal_error");
  return parsed.data.data as T;
}

async function updateBackendSecrets(nextSecrets: BackendSecrets): Promise<void> {
  if (!backendProcess) {
    if (process.env.SCRAPLY_E2E_BACKEND_URL) return;
    throw new AppError("backend_unavailable", backendStartupFailure ?? "The local backend is unavailable.");
  }
  if (!backendReady) throw new AppError("backend_unavailable", backendStartupFailure ?? "The local backend is unavailable.");
  const requestId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSecretUpdates.delete(requestId);
      reject(new AppError("backend_unavailable", "The local backend did not acknowledge the credential update."));
    }, 5_000);
    pendingSecretUpdates.set(requestId, { resolve, reject, timer });
    backendProcess?.postMessage({ type: "update-secrets", requestId, secrets: nextSecrets });
  });
}

async function validateAndPersistSecrets(candidate: BackendSecrets): Promise<ValidationState> {
  const previous = secrets;
  await updateBackendSecrets(candidate);
  try {
    const validation = await backendRequest<ValidationState>("/validation");
    if (!validation.setupComplete) {
      await updateBackendSecrets(previous);
      return validation;
    }
    persistSecrets(candidate);
    secrets = candidate;
    return validation;
  } catch (error) {
    await updateBackendSecrets(previous).catch(() => undefined);
    throw error;
  }
}

async function retryAutomaticConnection(): Promise<void> {
  const automaticSecrets = readAutomaticSecrets();
  const candidate: BackendSecrets = {
    exaApiKey: automaticSecrets.exaApiKey ?? secrets.exaApiKey,
  };

  if (!backendReady) {
    const staleProcess = backendProcess;
    backendProcess = null;
    staleProcess?.kill();
    secrets = candidate;
    await ensureBackend();
  }

  await validateAndPersistSecrets(candidate);
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

  handle(IPC_CHANNELS.GET_VALIDATION, () => backendRequest("/validation"));
  handle(IPC_CHANNELS.RETRY_CONNECTION, retryAutomaticConnection);
  handle(IPC_CHANNELS.GET_WORKSPACE, () => backendRequest("/workspace"));
  handle(IPC_CHANNELS.OPEN_DATA_FOLDER, async () => {
    await shell.openPath(getPaths().dataDir);
  });
  handle(IPC_CHANNELS.OPEN_LOGS_FOLDER, async () => {
    await shell.openPath(getPaths().logsDir);
  });
  handle(IPC_CHANNELS.CREATE_THREAD, (body) => post("/threads", CreateThreadRequestSchema.parse(body ?? {})));
  handle(IPC_CHANNELS.SELECT_THREAD, (body) => post("/threads/select", SelectThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.DELETE_THREAD, (body) => post("/threads/delete", DeleteThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_SCOPE, (body) => post("/scope", SaveScopeSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_RUN_CONFIG, (body) => post("/run-config", SaveRunConfigSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_FAVORITE_MODEL, (body) => post("/models/favorite", SaveFavoriteModelSchema.parse(body)));
  handle(IPC_CHANNELS.START_RESEARCH, (body) => post("/research/start", StartResearchSchema.parse(body)));
  handle(IPC_CHANNELS.CANCEL_RESEARCH, (body) => post("/research/cancel", CancelResearchSchema.parse(body)));
  handle(IPC_CHANNELS.RESUME_RESEARCH, (body) => post("/research/resume", ResumeResearchSchema.parse(body)));
  handle(IPC_CHANNELS.SELECT_PROBLEMS, (body) => post("/research/select-problems", SelectProblemsSchema.parse(body)));
  handle(IPC_CHANNELS.EXPORT_RESEARCH, async (body) => {
    const payload = ExportResearchRequestSchema.parse(body);
    const bundle = await post("/research/export", payload) as { filename: string; content: string };
    if (!mainWindow) throw new AppError("backend_unavailable");
    const filename = bundle.filename.replace(/[^a-zA-Z0-9._-]/g, "-");
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "Export research JSON",
      defaultPath: filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    writeFileSync(selection.filePath, bundle.content, "utf8");
    return { cancelled: false, file: selection.filePath };
  });
  handle(IPC_CHANNELS.EXPORT_IDEAS, async (body) => {
    const payload = ExportIdeasRequestSchema.parse(body);
    const bundle = await post("/ideas/export", payload) as { files: Array<{ filename: string; content: string }> };
    if (!mainWindow) throw new AppError("backend_unavailable");
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Export solution files",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true, files: [] };
    const directory = selection.filePaths[0];
    const files = bundle.files.map((file) => {
      const filename = file.filename.replace(/[^a-zA-Z0-9._-]/g, "-");
      writeFileSync(join(directory, filename), file.content, "utf8");
      return filename;
    });
    return { cancelled: false, directory, files };
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

process.on("uncaughtExceptionMonitor", (error) => {
  logger?.log({ level: "error", component: "main", event: "uncaught-exception", error });
});

process.on("unhandledRejection", (error) => {
  logger?.log({ level: "error", component: "main", event: "unhandled-rejection", error });
});

app.on("child-process-gone", (_event, details) => {
  logger?.log({
    level: "error",
    component: "main",
    event: "child-process-gone",
    context: { processType: details.type, reason: details.reason, exitCode: details.exitCode },
  });
});

const gotLock = process.env.SCRAPLY_E2E === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    logger = createFileLogger({
      logsDir: getPaths().logsDir,
      appVersion: app.getVersion(),
      getSecrets: secretValues,
    });
    logger.log({
      level: "info",
      component: "main",
      event: "app-startup",
      context: { version: app.getVersion() },
    });
    loadStoredSecrets();
    const automaticSecrets = readAutomaticSecrets();
    secrets = { ...secrets, ...automaticSecrets };
    registerIpc();
    createWindow();
    void ensureBackend()
      .then(async () => {
        if (!automaticSecrets.exaApiKey) return;
        const validation = await backendRequest<ValidationState>("/validation");
        if (validation.setupComplete) persistSecrets(secrets);
      })
      .catch((error) => {
        console.error("Backend startup failed", error);
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    logger?.log({ level: "info", component: "main", event: "app-shutdown" });
    backendProcess?.kill();
  });
}
