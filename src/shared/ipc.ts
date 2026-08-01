import { z } from "zod";
import { NormalizedProjectBriefSchema } from "./brief-normalizer";
import {
  BranchContextSchema,
  IdeaSchema,
  MessageSchema,
  ModelRefSchema,
  ModelCatalogSchema,
  ProjectBriefV2Schema,
  RunConfigSchema,
  SourceDetailSchema as SharedSourceDetailSchema,
  ThreadSchema,
} from "./schemas";

export const BackendReadySchema = z.object({
  port: z.number().int().positive(),
  token: z.string().min(1),
});

const EntityIdSchema = z.string().trim().min(1).max(128);
const ShortTextSchema = z.string().trim().min(1).max(256);

export const AppErrorCodeSchema = z.enum([
  "validation_error",
  "unauthorized",
  "not_found",
  "conflict",
  "provider_timeout",
  "backend_unavailable",
  "secure_storage_unavailable",
  "internal_error",
]);

export const AppErrorPayloadSchema = z.object({
  code: AppErrorCodeSchema,
  message: z.string().min(1).max(512),
  reference: z.string().min(1).max(128).optional(),
});

export const ApiErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: AppErrorPayloadSchema,
});

export function ApiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }),
    ApiErrorResponseSchema,
  ]);
}

export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;
export type AppErrorPayload = z.infer<typeof AppErrorPayloadSchema>;

export const ValidationStateSchema = z.object({
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

export const CreateThreadRequestSchema = z.object({
  title: ShortTextSchema.optional(),
});

export const SelectThreadRequestSchema = z.object({ threadId: EntityIdSchema });
export const DeleteThreadRequestSchema = z.object({ threadId: EntityIdSchema });

export const SubmitIntakeAnswerSchema = z.object({
  threadId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string(),
  skipped: z.boolean().optional(),
});

export const StartBriefIntakeSchema = z.object({
  threadId: EntityIdSchema,
  text: z.string().trim().min(1).max(100_000),
}).strict();

export const BriefExtractionResponseSchema = z.object({
  brief: ProjectBriefV2Schema,
  missingFields: z.array(z.string().trim().min(1)),
  assumptions: z.array(z.string().trim().min(1)),
  contradictions: z.array(z.string().trim().min(1)),
}).strict();

export const ConfirmBriefSchema = z.object({
  threadId: z.string().min(1),
  brief: NormalizedProjectBriefSchema,
}).strict();

export const SaveRunConfigSchema = z.object({
  threadId: z.string().min(1),
  config: RunConfigSchema,
  presetName: z.string().optional(),
});

export const SaveFavoriteModelSchema = z.object({
  model: ModelRefSchema,
  favorite: z.boolean(),
});

export const StartResearchSchema = z.object({
  threadId: z.string().min(1),
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
  ideaId: EntityIdSchema,
  rating: z.number().int().min(1).max(5),
  notes: z.string().trim().max(2_000).optional(),
});

export const GenerateIdeasRequestSchema = z.object({
  runId: EntityIdSchema,
  allowPartial: z.boolean().default(false),
});
export const ExportIdeasRequestSchema = z.object({ threadId: EntityIdSchema });
export const CreateBranchRequestSchema = z.object({
  parentThreadId: EntityIdSchema,
  seedIdeaId: EntityIdSchema,
  seedIdeaTitle: ShortTextSchema,
  explorationAngle: z.string().trim().min(3).max(1_000),
  selectedClaimIds: z.array(EntityIdSchema).min(1).max(100).refine(
    (ids) => new Set(ids).size === ids.length,
    "Selected claim IDs must be unique",
  ),
});
export const GetReportDetailRequestSchema = z.object({ reportId: EntityIdSchema });
export const GetSourceDetailRequestSchema = z.object({ sourceId: EntityIdSchema });
export const GetIdeaDetailRequestSchema = z.object({ ideaId: EntityIdSchema });
export const OpenExternalUrlRequestSchema = z.object({ url: z.string().trim().min(1).max(2_048) });

export const ReportSummarySchema = z.object({
  id: EntityIdSchema,
  researchRunId: EntityIdSchema.nullable().optional(),
  streamId: z.string().max(128).nullable(),
  title: z.string().max(512),
});

export const IdeaGenerationCompletenessSchema = z.object({
  mode: z.enum(["complete", "partial"]),
  synthesisReportId: EntityIdSchema.nullable(),
  missingLenses: z.array(z.string()),
  gaps: z.array(z.string()),
});

export const IdeaGenerationResponseSchema = z.object({
  ideas: z.array(IdeaSchema),
  completeness: IdeaGenerationCompletenessSchema,
});

export const LatestResearchRunSchema = z.object({
  runId: EntityIdSchema,
  status: z.enum(["queued", "running", "partial", "completed", "failed", "cancelled"]),
  synthesisReportId: EntityIdSchema.nullable(),
  canGeneratePartialIdeas: z.boolean().default(false),
  missingLenses: z.array(z.string()),
  gaps: z.array(z.string()),
});

export const ReportDetailSchema = ReportSummarySchema.extend({
  html: z.string().max(2_000_000),
});

export const SourceDetailSchema = SharedSourceDetailSchema;
const NormalizedBranchContextSchema = BranchContextSchema.omit({ inheritedBriefSnapshot: true }).extend({
  inheritedBriefSnapshot: NormalizedProjectBriefSchema,
});

export const IdeaRatingResponseSchema = z.object({
  ideaId: EntityIdSchema,
  rating: z.number().int().min(1).max(5),
  notes: z.string().max(2_000).nullable().optional(),
  updatedAt: z.string().min(1).max(128),
});

export const WorkspaceStateSchema = z.object({
  validation: ValidationStateSchema,
  threads: z.array(ThreadSchema),
  activeThreadId: z.string().nullable(),
  messages: z.array(MessageSchema),
  brief: NormalizedProjectBriefSchema.nullable(),
  runConfig: RunConfigSchema.nullable(),
  branchContext: NormalizedBranchContextSchema.nullable(),
  models: z.array(z.string()),
  modelCatalog: ModelCatalogSchema,
  presets: z.array(z.object({ name: z.string(), config: RunConfigSchema })),
  ideas: z.array(IdeaSchema).default([]),
  reports: z.array(ReportSummarySchema).default([]),
  latestResearchRun: LatestResearchRunSchema.nullable().default(null),
  pendingRuns: z.array(PendingRunSchema).default([]),
});

export const ResearchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-started"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("stream-started"), runId: z.string(), threadId: z.string(), streamId: z.string() }),
  z.object({ type: z.literal("stream-progress"), runId: z.string(), threadId: z.string(), streamId: z.string(), message: z.string() }),
  z.object({ type: z.literal("stream-completed"), runId: z.string(), threadId: z.string(), streamId: z.string(), reportId: z.string() }),
  z.object({ type: z.literal("stream-failed"), runId: z.string(), threadId: z.string(), streamId: z.string(), error: z.string() }),
  z.object({ type: z.literal("follow-up-started"), runId: z.string(), threadId: z.string(), streamId: z.string(), round: z.number() }),
  z.object({ type: z.literal("coverage-review-started"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("coverage-review-completed"), runId: z.string(), threadId: z.string(), overallCoverage: z.number() }),
  z.object({ type: z.literal("synthesis-started"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("synthesis-completed"), runId: z.string(), threadId: z.string(), reportId: z.string() }),
  z.object({ type: z.literal("run-resumed"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("run-completed"), runId: z.string(), threadId: z.string(), partial: z.boolean() }),
  z.object({ type: z.literal("run-cancelled"), runId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("run-failed"), runId: z.string(), threadId: z.string(), error: z.string() }),
  z.object({
    type: z.literal("ideas-generated"),
    threadId: z.string(),
    runId: z.string(),
    ideas: z.array(IdeaSchema),
    completeness: IdeaGenerationCompletenessSchema,
  }),
]);

export type BackendReady = z.infer<typeof BackendReadySchema>;
export type ValidationState = z.infer<typeof ValidationStateSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type ResearchEvent = z.infer<typeof ResearchEventSchema>;
export type PendingRun = z.infer<typeof PendingRunSchema>;
export type ReportDetail = z.infer<typeof ReportDetailSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type IdeaRating = z.infer<typeof IdeaRatingResponseSchema>;
export type IdeaGenerationCompleteness = z.infer<typeof IdeaGenerationCompletenessSchema>;
export type IdeaGenerationResponse = z.infer<typeof IdeaGenerationResponseSchema>;
export type BriefExtractionResponse = z.infer<typeof BriefExtractionResponseSchema>;

export const IPC_CHANNELS = {
  GET_VALIDATION: "scraply:get-validation",
  RETRY_CONNECTION: "scraply:retry-connection",
  OPEN_DATA_FOLDER: "scraply:open-data-folder",
  OPEN_LOGS_FOLDER: "scraply:open-logs-folder",
  GET_WORKSPACE: "scraply:get-workspace",
  CREATE_THREAD: "scraply:create-thread",
  SELECT_THREAD: "scraply:select-thread",
  SUBMIT_INTAKE: "scraply:submit-intake",
  START_BRIEF_INTAKE: "scraply:start-brief-intake",
  CONFIRM_BRIEF: "scraply:confirm-brief",
  SAVE_RUN_CONFIG: "scraply:save-run-config",
  SAVE_FAVORITE_MODEL: "scraply:save-favorite-model",
  START_RESEARCH: "scraply:start-research",
  CANCEL_RESEARCH: "scraply:cancel-research",
  RESUME_RESEARCH: "scraply:resume-research",
  CANCEL_INCOMPLETE_RESEARCH: "scraply:cancel-incomplete-research",
  GENERATE_IDEAS: "scraply:generate-ideas",
  RATE_IDEA: "scraply:rate-idea",
  DELETE_THREAD: "scraply:delete-thread",
  EXPORT_IDEAS: "scraply:export-ideas",
  CREATE_BRANCH: "scraply:create-branch",
  GET_REPORT_DETAIL: "scraply:get-report-detail",
  GET_SOURCE_DETAIL: "scraply:get-source-detail",
  GET_IDEA_DETAIL: "scraply:get-idea-detail",
  OPEN_EXTERNAL_URL: "scraply:open-external-url",
  BACKEND_EVENT: "scraply:backend-event",
} as const;
