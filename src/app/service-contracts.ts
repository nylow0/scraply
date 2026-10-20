import { z } from "zod";
import type { BackendSecrets, MainToBackendMessage } from "../shared/backend-process";
import type { BackendReady, ResearchEvent } from "../shared/ipc";
import type { createCredentialStore } from "../main/credential-store";

export interface AppServicePaths {
  dataDir: string;
  dbPath: string;
  logsDir: string;
  bundledPromptsDir: string;
  promptOverridesDir: string;
}

export interface AppBackendStart {
  paths: AppServicePaths;
  appVersion: string;
  secrets: BackendSecrets;
  // CLI startup defers search-key checks until an explicit validation/billing request.
  validateAutomaticSecrets?: boolean;
  persistProviderCredential(providerId: string, credential: string): Promise<void>;
  publishEvent(event: ResearchEvent): void;
}

/** Implemented by either the utility-process client or an in-process backend host. */
export interface AppBackend {
  start(input: AppBackendStart): Promise<void>;
  isReady(): boolean;
  request(path: string, init?: RequestInit): Promise<unknown>;
  updateSecrets(secrets: BackendSecrets, onlyWhenIdle?: boolean): Promise<void>;
  finishSearchKeyUpdate(previousSecrets?: BackendSecrets): Promise<void>;
  stop(): void | Promise<void>;
}

export interface BackendClientOptions {
  launch(input: AppBackendStart, hooks: {
    secretsUpdated(requestId: string, error?: string): void;
    unavailable(message: string): void;
  }): Promise<BackendReady>;
  postMessage(message: MainToBackendMessage): void;
  hasProcess(): boolean;
  stop(): void | Promise<void>;
  // The existing external e2e backend has no utility-process credential bridge.
  externalSecretsNoop?: boolean;
}

export const AppInvocationOptionsSchema = z.object({
  openBrowser: z.boolean().default(false),
  revealPaths: z.boolean().default(false),
  exportTarget: z.enum(["files", "download", "dialog"]).default("files"),
}).strict();
export type AppInvocationOptions = z.input<typeof AppInvocationOptionsSchema>;
export type AppRequestHandler = (...args: unknown[]) => unknown;

export interface AppServiceStartOptions {
  validateAutomaticSecrets?: boolean;
}

export type ExportTargetRequest =
  | { kind: "research"; filename: string }
  | { kind: "ideas" };

export interface AppServiceOptions {
  paths: AppServicePaths;
  appVersion: string;
  credentialStore: Pick<ReturnType<typeof createCredentialStore>, "load" | "save">;
  backend: AppBackend;
  automaticSecrets?: {
    environment: NodeJS.ProcessEnv;
    // Desktop development also reads .env. Production and CLI hosts omit this.
    envFile?: string;
  };
  openExternal?: (url: string) => Promise<void>;
  revealPath?: (path: string) => Promise<void>;
  chooseExportTarget?: (request: ExportTargetRequest) => Promise<string | null>;
  publishEvent?: (event: ResearchEvent) => void;
}
