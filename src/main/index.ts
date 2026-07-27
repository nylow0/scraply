import { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
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
  ResumeResearchSchema,
  SaveFavoriteModelSchema,
  SaveRunConfigSchema,
  SaveSecretsRequestSchema,
  SelectThreadRequestSchema,
  StartBriefIntakeSchema,
  StartResearchSchema,
  SubmitIntakeAnswerSchema,
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
let backendStartupFailure: string | null = null;
let logger: FileLogger | null = null;

interface PendingSecretUpdate {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingSecretUpdates = new Map<string, PendingSecretUpdate>();
let secrets: BackendSecrets = { opencodeApiKey: null, exaApiKey: null };

function secretValues(): string[] {
  return [secrets.opencodeApiKey, secrets.exaApiKey].filter((value): value is string => Boolean(value));
}

function getPaths() {
  const dataDir = join(app.getPath("userData"), "scraply");
  const dbPath = join(dataDir, "scraply.db");
  const logsDir = join(dataDir, "logs");
  const bundledPromptsDir = join(app.getAppPath(), "prompts");
  const promptOverridesDir = join(dataDir, "prompts");
  return { dataDir, dbPath, logsDir, bundledPromptsDir, promptOverridesDir };
}

function readDevEnvSecrets(): Partial<BackendSecrets> {
  if (!isDev || process.env.SCRAPLY_E2E === "1") return {};
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  const candidate: Partial<BackendSecrets> = {};
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key === "OPENCODE_API_KEY" && value) candidate.opencodeApiKey = value;
    if (key === "EXA_API_KEY" && value) candidate.exaApiKey = value;
  }
  return candidate;
}

function loadStoredSecrets(): void {
  const settingsPath = join(app.getPath("userData"), "secrets.bin");
  if (!existsSync(settingsPath) || !safeStorage.isEncryptionAvailable()) return;
  try {
    const raw = safeStorage.decryptString(readFileSync(settingsPath));
    const parsed = JSON.parse(raw) as BackendSecrets;
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
      reject(new Error("Backend startup timed out"));
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
      backendStartupFailure = message;
      logger?.log({ level: "error", component: "main", event: "backend-process-error", message });
      rejectPendingUpdates(message);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    });

    processHandle.on("exit", (code) => {
      const message = backendStartupFailure ?? `The local backend exited unexpectedly (code ${code}).`;
      backendStartupFailure = message;
      logger?.log({
        level: code === 0 ? "info" : "error",
        component: "main",
        event: "backend-exit",
        message,
        context: { exitCode: code },
      });
      backendReady = null;
      rejectPendingUpdates(message);
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
  if (!backendReady) {
    throw new AppError("backend_unavailable", backendStartupFailure ?? "The local backend is unavailable.");
  }
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

function normalizeSecrets(value: { opencodeApiKey: string; exaApiKey: string }): BackendSecrets {
  return {
    opencodeApiKey: value.opencodeApiKey.trim() || null,
    exaApiKey: value.exaApiKey.trim() || null,
  };
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
    const validation = await backendRequest<ValidationState>("/validation?validateOptional=1");
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
    return validateAndPersistSecrets(normalizeSecrets(payload));
  });
  handle(IPC_CHANNELS.IMPORT_ENV, async () => {
    const envSecrets = readDevEnvSecrets();
    const candidate = SaveSecretsRequestSchema.parse({
      opencodeApiKey: envSecrets.opencodeApiKey ?? secrets.opencodeApiKey ?? "",
      exaApiKey: envSecrets.exaApiKey ?? secrets.exaApiKey ?? "",
    });
    return validateAndPersistSecrets(normalizeSecrets(candidate));
  });
  handle(IPC_CHANNELS.OPEN_DATA_FOLDER, async () => {
    await shell.openPath(getPaths().dataDir);
  });
  handle(IPC_CHANNELS.OPEN_LOGS_FOLDER, async () => {
    await shell.openPath(getPaths().logsDir);
  });
  handle(IPC_CHANNELS.CREATE_THREAD, (body) => post("/threads", CreateThreadRequestSchema.parse(body ?? {})));
  handle(IPC_CHANNELS.SELECT_THREAD, (body) => post("/threads/select", SelectThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.DELETE_THREAD, (body) => post("/threads/delete", DeleteThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.SUBMIT_INTAKE, (body) => post("/intake", SubmitIntakeAnswerSchema.parse(body)));
  handle(IPC_CHANNELS.START_BRIEF_INTAKE, (body) => post("/intake/brief", StartBriefIntakeSchema.parse(body)));
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
    secrets = { ...secrets, ...readDevEnvSecrets() };
    registerIpc();
    try {
      backendReady = await startBackendProcess();
    } catch (error) {
      backendStartupFailure = error instanceof Error ? error.message : "The local backend failed to start.";
      console.error("Backend startup failed", error);
    }
    createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    logger?.log({ level: "info", component: "main", event: "app-shutdown" });
    backendProcess?.kill();
  });
}
