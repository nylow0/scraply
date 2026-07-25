import { z } from "zod";
import { ResearchEventSchema } from "./ipc";

const SecretsSchema = z.object({
  opencodeApiKey: z.string().nullable(),
  exaApiKey: z.string().nullable(),
});

export const BackendStartMessageSchema = z.object({
  type: z.literal("start"),
  dataDir: z.string().min(1),
  dbPath: z.string().min(1),
  bundledPromptsDir: z.string().min(1),
  promptOverridesDir: z.string().min(1),
  appVersion: z.string().min(1),
  secrets: SecretsSchema,
});

export const BackendUpdateSecretsMessageSchema = z.object({
  type: z.literal("update-secrets"),
  requestId: z.string().min(1),
  secrets: SecretsSchema,
});

export const MainToBackendMessageSchema = z.discriminatedUnion("type", [
  BackendStartMessageSchema,
  BackendUpdateSecretsMessageSchema,
]);

export const BackendLogMessageSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  event: z.string().min(1).max(128),
  message: z.string().max(2_000).optional(),
  context: z.record(z.unknown()).optional(),
  error: z.object({
    name: z.string().max(128),
    message: z.string().max(2_000),
    stack: z.string().max(8_000).optional(),
  }).optional(),
});

export const BackendToMainMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    port: z.number().int().positive(),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal("event"),
    event: ResearchEventSchema,
  }),
  z.object({
    type: z.literal("startup-failed"),
    message: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("secrets-updated"),
    requestId: z.string().min(1),
  }),
  BackendLogMessageSchema,
]);

export type BackendStartMessage = z.infer<typeof BackendStartMessageSchema>;
export type BackendUpdateSecretsMessage = z.infer<typeof BackendUpdateSecretsMessageSchema>;
export type MainToBackendMessage = z.infer<typeof MainToBackendMessageSchema>;
export type BackendToMainMessage = z.infer<typeof BackendToMainMessageSchema>;
export type BackendSecrets = z.infer<typeof SecretsSchema>;
