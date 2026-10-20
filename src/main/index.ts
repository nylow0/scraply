import { installApplicationMenu } from "./app-menu";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, shell, utilityProcess, type IpcMainInvokeEvent } from "electron";
import { startBrowserDevHost } from "./browser-dev";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IPC_CHANNELS, type BackendReady } from "../shared/ipc";
import { BackendToMainMessageSchema } from "../shared/backend-process";
import { AppError } from "../shared/errors";
import { resolveRuntimeLaunch } from "../shared/runtime-artifact";
import { createFileLogger, type FileLogger } from "./logging";
import { createCredentialStore } from "./credential-store";
import { configureCredentialProfile, selectDesktopProfile } from "./credential-profile";
import { isAllowedRendererUrl, rendererEntryUrl } from "./security";
import { readWindowState, saveWindowState } from "./window-state";
import { createAppService } from "../app/service";
import { createBackendClient } from "../app/backend-client";
import type { AppRequestHandler, BackendClientOptions, ExportTargetRequest } from "../app/service-contracts";
import { createDesktopOwner } from "./desktop-owner";
import { createRemoteApp } from "./remote-app";
import { operationRegistry, appControlRegistry } from "../shared/cli-contracts";

const isDev = !app.isPackaged;
const browserDev = isDev && process.env.SCRAPLY_BROWSER_DEV === "1";
const selectedProfile = selectDesktopProfile(app, process.env, process.argv);
// This configures paths only. Credential construction/decryption stays inside the owner factory.
const { projectProfile, credentialsPath } = configureCredentialProfile(app, process.env, { explicitProfile: selectedProfile.explicit });
let browserDevHost: Awaited<ReturnType<typeof startBrowserDevHost>> | undefined;
let mainWindow: BrowserWindow | null = null;
let backendProcess: Electron.UtilityProcess | null = null;
let backendStartupFailure: string | null = null;
let logger: FileLogger | null = null;
let isQuitting = false;
let quitComplete = false;
const backendExits = new Map<Electron.UtilityProcess, Promise<void>>();
const credentialWrites = new Set<Promise<void>>();
const localRequests = new Set<Promise<unknown>>();

function getPaths() {
  const dataDir = join(projectProfile, "scraply");
  const dbPath = join(dataDir, "scraply.db");
  const logsDir = join(dataDir, "logs");
  const bundledPromptsDir = join(app.getAppPath(), "prompts");
  const promptOverridesDir = join(dataDir, "prompts");
  return { dataDir, dbPath, logsDir, bundledPromptsDir, promptOverridesDir };
}

const localEffects = {
  openExternal: (url: string) => shell.openExternal(url),
  async revealPath(path: string) {
    const error = await shell.openPath(path);
    if (error) throw new AppError("validation_error", "The selected folder could not be opened.");
  },
  chooseExportTarget,
};

async function chooseExportTarget(request: ExportTargetRequest) {
  if (!mainWindow) throw new AppError("backend_unavailable");
  if (request.kind === "research") {
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "Export research JSON", defaultPath: request.filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return selection.canceled ? null : selection.filePath ?? null;
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Export solution files", properties: ["openDirectory", "createDirectory"],
  });
  return selection.canceled ? null : selection.filePaths[0] ?? null;
}

async function stopBackendProcess() {
  const processHandle = backendProcess;
  if (processHandle) {
    // The backend closes its runtime, SQLite and pending credential work before exit.
    // Keep the handle until exit so retry cannot fork another SQLite owner early.
    processHandle.postMessage({ type: "shutdown" });
    await backendExits.get(processHandle);
  }
  await Promise.all([...backendExits.values()]);
  await Promise.allSettled([...credentialWrites]);
}

const desktopOwner = createDesktopOwner({
  profileDir: projectProfile, version: app.getVersion(),
  async createApplication(publishEvent) {
    await app.whenReady();
    if (isQuitting) throw new AppError("backend_unavailable", "Scraply is closing.");
    const backendClient = createBackendClient({
      launch: startBackendProcess,
      postMessage(message) {
        if (!backendProcess) throw new AppError("backend_unavailable");
        backendProcess.postMessage(message);
      },
      hasProcess: () => backendProcess !== null,
      stop: stopBackendProcess,
      externalSecretsNoop: Boolean(process.env.SCRAPLY_E2E_BACKEND_URL),
    });
    const service = createAppService({
      paths: getPaths(), appVersion: app.getVersion(),
      credentialStore: createCredentialStore(credentialsPath, safeStorage), backend: backendClient,
      automaticSecrets: {
        environment: process.env,
        ...(isDev && process.env.SCRAPLY_E2E !== "1" ? { envFile: join(process.cwd(), ".env") } : {}),
      },
      ...localEffects, publishEvent,
    });
    const handlers = service.createHandlers({ openBrowser: true, revealPaths: true, exportTarget: browserDev ? "download" : "dialog" });
    // Passive startup restores account/status only. Explicit validation retains its normal checks.
    const startup = service.start({ validateAutomaticSecrets: false }).catch(error => {
      logger?.log({ level: "error", component: "main", event: "backend-startup-failed", error });
    });
    return {
      async invoke(channel, payload, interactive) {
        if (!interactive) return service.invokeRemote(channel, payload);
        const handler = handlers.get(channel);
        if (!handler) throw new AppError("not_found", "Unknown app request.");
        return handler(...(payload === undefined ? [] : [payload]));
      },
      secretValues: service.secretValues,
      async stop() {
        await startup;
        // The graceful utility shutdown drains model work and credential callbacks.
        await service.stop();
        await Promise.allSettled([...localRequests]);
      },
    };
  },
  publishEvent(event) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.BACKEND_EVENT, event);
    browserDevHost?.publish(event);
  },
  onDisconnect(error) { logger?.log({ level: "warn", component: "main", event: "owner-disconnected", error }); },
});
const remoteApp = createRemoteApp({
  invoke: (channel, payload) => desktopOwner.invoke(channel, payload, false), browserDev, ...localEffects,
});
const appHandlers: ReadonlyMap<string, AppRequestHandler> = new Map([
  ...Object.keys(operationRegistry), ...Object.keys(appControlRegistry),
].map(channel => [channel, async (...args: unknown[]) => {
  if (isQuitting) throw new AppError("backend_unavailable", "Scraply is closing.");
  if (args.length > 1) throw new AppError("validation_error", "App requests accept at most one argument.");
  const request = (async () => {
    if (desktopOwner.kind === "desktop") return desktopOwner.invoke(channel, args[0]);
    const handler = remoteApp.handlers.get(channel);
    if (!handler) throw new AppError("not_found", "Unknown app request.");
    return handler(...args);
  })();
  localRequests.add(request);
  try { return await request; }
  finally { localRequests.delete(request); }
}]));

async function startBackendProcess(
  input: Parameters<BackendClientOptions["launch"]>[0],
  hooks: Parameters<BackendClientOptions["launch"]>[1],
): Promise<BackendReady> {
  if (isQuitting) throw new AppError("backend_unavailable", "Scraply is closing.");
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

  const { dataDir, dbPath, bundledPromptsDir, promptOverridesDir } = input.paths;
  let runtime: ReturnType<typeof resolveRuntimeLaunch>;
  let runtimeError: string | undefined;
  try {
    runtime = resolveRuntimeLaunch({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : "Native runtime package validation failed";
    logger?.log({ level: "error", component: "main", event: "native-runtime-unavailable", message: runtimeError });
  }
  const useE2eBackend = process.env.SCRAPLY_E2E === "1" && process.env.SCRAPLY_E2E_REAL_BACKEND === "1";
  const backendEntry = join(__dirname, useE2eBackend ? "backend-e2e.js" : "backend.js");
  logger?.log({ level: "info", component: "main", event: "backend-starting" });
  const processHandle = utilityProcess.fork(backendEntry, [], { serviceName: "scraply-backend" });
  backendProcess = processHandle;
  let processExited = false;
  const exited = new Promise<void>(resolve => { processHandle.once("exit", () => { processExited = true; resolve(); }); });
  backendExits.set(processHandle, exited);
  void exited.then(() => { backendExits.delete(processHandle); });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = "Backend startup timed out";
      backendStartupFailure = message;
      processHandle.kill();
      reject(new Error(message));
    }, 15_000);

    const rejectPendingUpdates = hooks.unavailable;

    processHandle.on("message", async (rawMessage) => {
      const parsed = BackendToMainMessageSchema.safeParse(rawMessage);
      if (!parsed.success) return;
      const message = parsed.data;

      if (message.type === "event") {
        input.publishEvent(message.event);
        return;
      }
      if (message.type === "persist-provider-credential") {
        if (processExited) return;
        const pending = input.persistProviderCredential(message.providerId, message.credential);
        credentialWrites.add(pending);
        try {
          await pending;
          if (!processExited) processHandle.postMessage({ type: "provider-credential-persisted", requestId: message.requestId, ok: true });
        } catch (error) {
          if (!processExited) processHandle.postMessage({
            type: "provider-credential-persisted", requestId: message.requestId, ok: false,
            error: error instanceof Error ? error.message : "Credential persistence failed",
          });
        } finally { credentialWrites.delete(pending); }
        return;
      }
      if (message.type === "secrets-updated") {
        hooks.secretsUpdated(message.requestId, message.error);
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
      appVersion: input.appVersion,
      secrets: input.secrets,
      ...(input.validateAutomaticSecrets !== undefined ? { validateAutomaticSecrets: input.validateAutomaticSecrets } : {}),
      ...(runtimeError ? { runtimeError } : {}),
      ...(runtime ? { runtime } : {}),
    });
  });
}

function createWindow(): void {
  const iconPath = join(process.cwd(), "build/icon.png");
  const expectedRendererUrl = rendererEntryUrl(
    join(__dirname, "../renderer/index.html"),
    isDev ? process.env.ELECTRON_RENDERER_URL : undefined,
  );
  const hideWindow = process.env.SCRAPLY_TEST_HIDE_WINDOWS === "1";
  // Reopen at the size and position the user left, maximized if it was. Each profile keeps its own file.
  const windowStatePath = join(app.getPath("userData"), "window-state.json");
  const savedState = readWindowState(windowStatePath, screen.getAllDisplays().map(display => display.workArea));
  mainWindow = new BrowserWindow({
    // Shown below, after the saved placement is applied, so the window does not visibly resize.
    show: false,
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#000000",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#000000", symbolColor: "#c2c7c5", height: 36 },
    title: "Scraply",
    autoHideMenuBar: true,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      // Keep hidden test windows rendering so layout and screenshot checks remain meaningful.
      offscreen: hideWindow,
      backgroundThrottling: !hideWindow,
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const createdWindow = mainWindow;
  // setBounds lands closer to the saved size than constructor bounds with the hidden title bar.
  if (savedState) createdWindow.setBounds(savedState.bounds);
  if (!hideWindow) {
    if (savedState?.maximized) createdWindow.maximize();
    createdWindow.show();
  }
  const initialNormalBounds = createdWindow.getNormalBounds();
  installApplicationMenu(createdWindow);
  createdWindow.on("close", () => {
    try { saveWindowState(windowStatePath, createdWindow, savedState?.bounds, initialNormalBounds); }
    catch (error) { logger?.log({ level: "warn", component: "main", event: "window-state-save-failed", error }); }
  });
  createdWindow.on("closed", () => {
    if (mainWindow === createdWindow) mainWindow = null;
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
  for (const [channel, handler] of appHandlers) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedSender(event);
      return handler(...args);
    });
  }
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
  // Start locking before ready. The owner-only factory waits for safeStorage readiness.
  const ownerStartup = desktopOwner.start();
  void ownerStartup.catch(() => undefined);
  app.whenReady().then(async () => {
    logger = createFileLogger({
      logsDir: getPaths().logsDir,
      appVersion: app.getVersion(),
      getSecrets: desktopOwner.secretValues,
    });
    logger.log({
      level: "info",
      component: "main",
      event: "app-startup",
      context: { version: app.getVersion() },
    });
    await ownerStartup;
    if (isQuitting) return;
    registerIpc();
    if (browserDev) {
      browserDevHost = await startBrowserDevHost({
        port: z.coerce.number().int().min(1).max(65535).parse(process.env.SCRAPLY_BROWSER_PORT),
        token: z.string().min(32).parse(process.env.SCRAPLY_BROWSER_TOKEN),
        sessionId: z.string().uuid().parse(process.env.SCRAPLY_BROWSER_SESSION),
        handlers: appHandlers,
        shutdown: () => app.quit(),
      });
    } else {
      createWindow();
    }
  }).catch(error => {
    if (isQuitting) return;
    logger?.log({ level: "error", component: "main", event: "owner-startup-failed", error });
    dialog.showErrorBox("Scraply could not open this profile", error instanceof Error ? error.message : "Close Scraply and try again.");
    app.quit();
  });

  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.on("window-all-closed", () => {
    if (!browserDev && process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!isQuitting && !browserDev && !mainWindow && desktopOwner.kind !== "disconnected") createWindow();
  });

  app.on("before-quit", event => {
    if (quitComplete) return;
    event.preventDefault();
    if (isQuitting) return;
    isQuitting = true;
    const closingBrowserHost = browserDevHost;
    browserDevHost = undefined;
    closingBrowserHost?.close();
    logger?.log({ level: "info", component: "main", event: "app-shutdown" });
    void Promise.all([desktopOwner.close(), Promise.allSettled([...localRequests])]).then(() => {
      quitComplete = true;
      app.quit();
    }).catch(error => {
      // Keep ownership if cleanup fails. Another host must not open live SQLite.
      logger?.log({ level: "error", component: "main", event: "owner-shutdown-failed", error });
      dialog.showErrorBox("Scraply could not close safely", "The profile is still reserved because shutdown did not finish. Wait for current work to stop before closing Scraply.");
    });
  });
}
