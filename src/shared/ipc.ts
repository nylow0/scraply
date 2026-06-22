import { z, type ZodError } from "zod";
import { IdeaSchema, MessageSchema, ProjectBriefSchema, RunConfigSchema, ThreadSchema } from "./schemas";

/** Human-readable validation errors for API and IPC callers. */
export function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "body";
    return `${path}: ${issue.message}`;
  }).join("; ");
}

export const BackendReadySchema = z.object({
  port: z.number().int().positive(),
  token: z.string().min(1),
});

export const ValidationStateSchema = z.object({
  opencode: z.object({
    valid: z.boolean(),
    modelCount: z.number().int().nonnegative(),
    models: z.array(z.string()),
    error: z.string().optional(),
  }),
  exa: z.object({
    valid: z.boolean(),
    error: z.string().optional(),
  }),
  codex: z.object({
    detected: z.boolean(),
    compatible: z.boolean(),
    version: z.string().optional(),
    error: z.string().optional(),
  }),
  setupComplete: z.boolean(),
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  persistenceCheck: z.string().optional(),
});

export const SaveSecretsRequestSchema = z.object({
  opencodeApiKey: z.string().min(1),
  exaApiKey: z.string().min(1),
});

export const TestModelsRequestSchema = z.object({
  models: z.array(z.string().min(1)).min(1).max(5),
});

export const ModelTestResultSchema = z.object({
  model: z.string(),
  chatOk: z.boolean(),
  chatError: z.string().optional(),
  chatReply: z.string().optional(),
  structuredOk: z.boolean(),
  structuredError: z.string().optional(),
  latencyMs: z.number().nonnegative(),
});

export const TestModelsResponseSchema = z.object({
  results: z.array(ModelTestResultSchema),
});

export const CreateThreadRequestSchema = z.object({
  title: z.string().min(1).optional(),
});

export const DeleteThreadRequestSchema = z.object({
  threadId: z.string().min(1),
});

export const SelectThreadRequestSchema = z.object({
  threadId: z.string().min(1),
});

export const ThreadIdRequestSchema = z.object({
  threadId: z.string().min(1),
});

export const CreateBranchRequestSchema = z.object({
  parentThreadId: z.string().min(1),
  ideaTitle: z.string().min(1),
});

export const SubmitIntakeAnswerSchema = z.object({
  threadId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string(),
  skipped: z.boolean().optional(),
});

export const ConfirmBriefSchema = z.object({
  threadId: z.string().min(1),
  brief: ProjectBriefSchema,
});

export const SaveRunConfigSchema = z.object({
  threadId: z.string().min(1),
  config: RunConfigSchema,
  presetName: z.string().optional(),
});

export const StartResearchSchema = z.object({
  threadId: z.string().min(1),
});

/** One-shot: persist the brief + config and kick off the run. Replaces the chat intake flow. */
export const LaunchResearchSchema = z.object({
  threadId: z.string().min(1),
  brief: ProjectBriefSchema,
  config: RunConfigSchema,
});

/** Auto-save configurator draft without launching research. */
export const SaveDraftSchema = z.object({
  threadId: z.string().min(1),
  brief: ProjectBriefSchema,
  config: RunConfigSchema,
});

export const CancelResearchSchema = z.object({
  runId: z.string().min(1),
});

export const ResumeResearchSchema = z.object({
  runId: z.string().min(1),
});

export const CancelIncompleteResearchSchema = z.object({
  runId: z.string().min(1),
});

export const PendingRunSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  status: z.string(),
  completedStreams: z.number().int().nonnegative(),
  totalStreams: z.number().int().positive(),
  hasSynthesis: z.boolean(),
});

export const RateIdeaSchema = z.object({
  ideaId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  notes: z.string().optional(),
});

export const WorkspaceStateSchema = z.object({
  validation: ValidationStateSchema,
  threads: z.array(ThreadSchema),
  activeThreadId: z.string().nullable(),
  messages: z.array(MessageSchema),
  brief: ProjectBriefSchema.nullable(),
  runConfig: RunConfigSchema.nullable(),
  models: z.array(z.string()),
  presets: z.array(z.object({ name: z.string(), config: RunConfigSchema })),
  ideas: z.array(IdeaSchema).default([]),
  ideaRatings: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
  reports: z.array(z.object({
    id: z.string(),
    streamId: z.string().nullable(),
    title: z.string(),
  })).default([]),
  pendingRuns: z.array(PendingRunSchema).default([]),
});

export const ResearchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-started"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("stream-started"), runId: z.string(), streamId: z.string() }),
  z.object({ type: z.literal("stream-progress"), runId: z.string(), streamId: z.string(), message: z.string() }),
  z.object({ type: z.literal("stream-completed"), runId: z.string(), streamId: z.string(), reportId: z.string() }),
  z.object({ type: z.literal("stream-failed"), runId: z.string(), streamId: z.string(), error: z.string() }),
  z.object({ type: z.literal("follow-up-started"), runId: z.string(), streamId: z.string(), round: z.number() }),
  z.object({ type: z.literal("coverage-review-started"), runId: z.string() }),
  z.object({ type: z.literal("coverage-review-completed"), runId: z.string(), overallCoverage: z.number() }),
  z.object({ type: z.literal("coverage-review-failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("synthesis-started"), runId: z.string() }),
  z.object({ type: z.literal("synthesis-completed"), runId: z.string(), reportId: z.string() }),
  z.object({ type: z.literal("synthesis-failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("run-resumed"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("run-completed"), runId: z.string(), partial: z.boolean() }),
  z.object({ type: z.literal("run-failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("run-cancelled"), runId: z.string() }),
  z.object({ type: z.literal("ideas-generated"), threadId: z.string(), ideaCount: z.number().int().nonnegative() }),
  z.object({ type: z.literal("ideas-failed"), threadId: z.string(), error: z.string() }),
]);

export type BackendReady = z.infer<typeof BackendReadySchema>;
export type ValidationState = z.infer<typeof ValidationStateSchema>;
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type ResearchEvent = z.infer<typeof ResearchEventSchema>;
export type PendingRun = z.infer<typeof PendingRunSchema>;

export const ReportDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  html: z.string(),
});

export type ReportDetail = z.infer<typeof ReportDetailSchema>;

/** Messages from the Electron main process to the backend utility process. */
export const BackendStartMessageSchema = z.object({
  type: z.literal("start"),
  dataDir: z.string().min(1),
  dbPath: z.string().min(1),
  opencodeApiKey: z.string().nullable(),
  exaApiKey: z.string().nullable(),
});

export const BackendUpdateSecretsMessageSchema = z.object({
  type: z.literal("update-secrets"),
  opencodeApiKey: z.string(),
  exaApiKey: z.string(),
});

export const BackendUtilityMessageSchema = z.discriminatedUnion("type", [
  BackendStartMessageSchema,
  BackendUpdateSecretsMessageSchema,
]);

export const BackendReadyMessageSchema = z.object({
  type: z.literal("ready"),
  port: z.number().int().positive(),
  token: z.string().min(1),
});

export const BackendErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string().min(1),
});

export const BackendEventMessageSchema = z.object({
  type: z.literal("event"),
  event: ResearchEventSchema,
});

export type BackendUtilityMessage = z.infer<typeof BackendUtilityMessageSchema>;

export const IPC_CHANNELS = {
  GET_BACKEND: "scraply:get-backend",
  GET_VALIDATION: "scraply:get-validation",
  TEST_MODELS: "scraply:test-models",
  SAVE_SECRETS: "scraply:save-secrets",
  IMPORT_ENV: "scraply:import-env",
  OPEN_DATA_FOLDER: "scraply:open-data-folder",
  GET_WORKSPACE: "scraply:get-workspace",
  CREATE_THREAD: "scraply:create-thread",
  SELECT_THREAD: "scraply:select-thread",
  SUBMIT_INTAKE: "scraply:submit-intake",
  GENERATE_BRIEF: "scraply:generate-brief",
  CONFIRM_BRIEF: "scraply:confirm-brief",
  SAVE_RUN_CONFIG: "scraply:save-run-config",
  START_RESEARCH: "scraply:start-research",
  LAUNCH_RESEARCH: "scraply:launch-research",
  SAVE_DRAFT: "scraply:save-draft",
  CANCEL_RESEARCH: "scraply:cancel-research",
  RESUME_RESEARCH: "scraply:resume-research",
  CANCEL_INCOMPLETE_RESEARCH: "scraply:cancel-incomplete-research",
  GENERATE_IDEAS: "scraply:generate-ideas",
  RATE_IDEA: "scraply:rate-idea",
  RENAME_THREAD: "scraply:rename-thread",
  DELETE_THREAD: "scraply:delete-thread",
  EXPORT_IDEAS: "scraply:export-ideas",
  CREATE_BRANCH: "scraply:create-branch",
  GET_REPORT: "scraply:get-report",
  BACKEND_EVENT: "scraply:backend-event",
} as const;
