import { z } from "zod";
import { ScopeSchema, WorkflowV2CompatibleDecisionAnalysisOutputSchema, WorkflowV2RiskEvaluationOutputSchema, WorkflowV2RiskReassessmentOutputSchema } from "./structured-output-schemas";
import {
  MessageSchema,
  ModelCatalogSchema,
  ModelOptionSchema,
  ModelRefSchema,
  ReasoningEffortSchema,
  ExplorationPurposeSchema,
  RunConfigSchema,
  SourceDetailSchema as SharedSourceDetailSchema,
  ThreadSchema,
} from "./schemas";
import { OPENAI_SUBSCRIPTION_PROVIDER_ID } from "./schemas";

const EntityIdSchema = z.string().trim().min(1).max(128);
const ShortTextSchema = z.string().trim().min(1).max(256);

export const AppErrorCodeSchema = z.enum([
  "validation_error", "unauthorized", "not_found", "conflict", "provider_timeout",
  "backend_unavailable", "secure_storage_unavailable", "internal_error",
]);
export const AppErrorPayloadSchema = z.object({
  code: AppErrorCodeSchema,
  message: z.string().min(1).max(512),
  reference: z.string().min(1).max(128).optional(),
});
export const ApiErrorResponseSchema = z.object({ ok: z.literal(false), error: AppErrorPayloadSchema });
export function ApiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data: dataSchema }), ApiErrorResponseSchema]);
}

export const BackendReadySchema = z.object({ port: z.number().int().positive(), token: z.string().min(1) });
export const ValidationStateSchema = z.object({
  exa: z.object({ valid: z.boolean(), error: z.string().optional() }),
  perplexity: z.object({ valid: z.boolean(), error: z.string().optional() }),
  native: z.object({
    available: z.boolean(),
    connected: z.boolean(),
    version: z.string().optional(),
    accounts: z.array(z.object({
      providerId: z.string(), email: z.string().optional(), accountId: z.string().optional(), plan: z.string().optional(),
    }).strict()),
    error: z.string().optional(),
  }),
  setupComplete: z.boolean(),
});
export const HealthResponseSchema = z.object({ ok: z.boolean(), version: z.string(), persistenceCheck: z.string().optional() });

export const CreateThreadRequestSchema = z.object({ title: ShortTextSchema.optional() });
export const SelectThreadRequestSchema = z.object({ threadId: EntityIdSchema });
export const AppCommandSchema = z.enum(["new-research", "settings", "toggle-sidebar", "back", "forward", "export-research"]);
export const AppMenuRequestSchema = z.object({ menu: z.enum(["File", "Edit", "View", "Help"]), x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000) }).strict();
export const DiscardIdeaRequestSchema = z.object({ threadId: EntityIdSchema, ideaId: EntityIdSchema, discarded: z.boolean() }).strict();
export const ArchiveThreadRequestSchema = z.object({ threadId: EntityIdSchema, archived: z.boolean() }).strict();
export const GenerateTitleRequestSchema = z.object({
  context: z.string().trim().min(1).max(20000),
  model: ModelRefSchema,
  reasoningEffort: ReasoningEffortSchema,
}).strict();
export const GenerateTitleResultSchema = z.object({ title: z.string().trim().min(1).max(100) }).strict();
export const DeleteThreadRequestSchema = z.object({ threadId: EntityIdSchema });
export const SaveScopeSchema = z.object({ threadId: EntityIdSchema, scope: ScopeSchema }).strict();
export const SaveRunConfigSchema = z.object({ threadId: EntityIdSchema, config: RunConfigSchema, presetName: z.string().optional() });
export const SaveFavoriteModelSchema = z.object({ model: ModelRefSchema, favorite: z.boolean() });
export const StartResearchSchema = z.object({ threadId: EntityIdSchema });
export const CancelResearchSchema = z.object({ runId: EntityIdSchema });
export const ResumeResearchSchema = z.object({ runId: EntityIdSchema });
export const SelectOptionSchema = z.object({ threadId: EntityIdSchema, runId: EntityIdSchema, solutionId: EntityIdSchema }).strict();
export const SaveDecisionSchema = z.object({
  threadId: EntityIdSchema, solutionId: EntityIdSchema,
  userDecision: z.string().trim().max(8_000), observedResult: z.string().trim().max(8_000),
  experimentOutcome: z.enum(["not-run", "pass", "fail", "inconclusive"]).default("not-run"),
}).strict();
export const EvidenceFollowUpRequestSchema = z.object({
  threadId: EntityIdSchema, runId: EntityIdSchema,
  question: z.string().trim().min(1).max(500),
}).strict();
export const EvidenceReassessmentRequestSchema = z.object({
  threadId: EntityIdSchema, runId: EntityIdSchema,
}).strict();
export const SelectProblemsSchema = z.object({
  threadId: EntityIdSchema,
  problemIds: z.array(EntityIdSchema),
  userProblem: z.string().trim().max(2_000).nullable(),
  model: ModelRefSchema,
  reasoningEffort: ReasoningEffortSchema,
  explorationPurpose: ExplorationPurposeSchema.optional(),
}).strict();
export const ExportIdeasRequestSchema = z.object({ threadId: EntityIdSchema, format: z.enum(["markdown", "json"]).default("markdown") });
export const ExportResearchRequestSchema = z.object({ threadId: EntityIdSchema });
export const GetSourceDetailRequestSchema = z.object({ sourceId: EntityIdSchema });
export const GetIdeaDetailRequestSchema = z.object({ ideaId: EntityIdSchema });
export const OpenExternalUrlRequestSchema = z.object({ url: z.string().trim().min(1).max(2_048) });
export const NativeLoginStartSchema = z.object({
  providerId: z.literal(OPENAI_SUBSCRIPTION_PROVIDER_ID),
  method: z.enum(["browser", "device"]),
}).strict();
export const NativeLoginCompleteSchema = z.object({ loginId: EntityIdSchema }).strict();
export const NativeLoginCancelSchema = z.object({ loginId: EntityIdSchema, providerId: z.literal(OPENAI_SUBSCRIPTION_PROVIDER_ID) }).strict();
export const NativeProviderSchema = z.object({ providerId: z.literal(OPENAI_SUBSCRIPTION_PROVIDER_ID) }).strict();
export const NativeLoginLaunchSchema = z.discriminatedUnion("method", [
  z.object({ loginId: EntityIdSchema, providerId: EntityIdSchema, method: z.literal("browser"), authorizationUrl: z.string().url(), callbackPort: z.number().int().positive() }).strict(),
  z.object({ loginId: EntityIdSchema, providerId: EntityIdSchema, method: z.literal("device"), verificationUrl: z.string().url(), userCode: z.string().min(1) }).strict(),
  z.object({ loginId: EntityIdSchema, providerId: EntityIdSchema, method: z.literal("pkce"), authorizationUrl: z.string().url() }).strict(),
]);

export const PendingRunSchema = z.object({
  runId: EntityIdSchema,
  threadId: EntityIdSchema,
  threadTitle: z.string(),
  status: z.enum(["queued", "running"]),
  problemId: EntityIdSchema.nullable(),
  stage: z.enum(["queued", "searching", "extracting", "synthesizing-problems", "generating-options", "awaiting-option-selection", "evaluating-risk", "analyzing-option", "evidence-follow-up", "completed", "failed", "cancelled"]).optional(),
  modelState: z.enum(["waiting", "dispatched", "accepted"]).nullable().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  operationStartedAt: z.string().datetime().optional(),
  operationElapsedMs: z.number().int().nonnegative().optional(),
  lastSuccessfulCheckpoint: z.string().nullable().optional(),
  queuePosition: z.number().int().positive().optional(),
});
export const SourceDetailSchema = SharedSourceDetailSchema;

export const FactorViewSchema = z.object({
  id: EntityIdSchema,
  subject: z.string(), behavior: z.string(), quote: z.string(), sourceId: EntityIdSchema,
  sourceTitle: z.string(), sourceUrl: z.string().url(), harvestMode: z.enum(["domain", "audience"]),
  modelConfidence: z.number(), uncertainty: z.string().optional(),
  sourceRole: z.enum(["firsthand", "measured", "vendor", "recommendation", "illustration", "unknown"]).optional(),
  audienceFit: z.enum(["intended-buyer", "adjacent", "general", "unknown"]).optional(),
  independentSourceKey: z.string().nullable().optional(), supportsDemand: z.boolean().optional(),
  demandEvidenceUncertainty: z.string().optional(),
});
export const EvidenceFollowUpViewSchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  question: z.string(),
  sources: z.array(SourceDetailSchema),
  factors: z.array(FactorViewSchema),
  error: z.string().nullable(),
  reassessmentStatus: z.enum(["running", "completed", "failed"]).nullable(),
  riskReassessment: WorkflowV2RiskReassessmentOutputSchema.nullable(),
  reassessmentAnalysis: WorkflowV2CompatibleDecisionAnalysisOutputSchema.nullable(),
  reassessmentError: z.string().nullable(),
});
export const ProblemCandidateSchema = z.object({
  id: EntityIdSchema,
  statement: z.string(), whyItPersists: z.string(), affected: z.string(), scaleEstimate: z.string(),
  verdict: z.enum(["confirmed", "overstated", "already-solved", "insufficient-evidence", "attempted-and-failed", "user-asserted"]),
  verdictReason: z.string(), selected: z.boolean(), factors: z.array(FactorViewSchema),
  intendedBuyerEvidenceFactorIds: z.array(EntityIdSchema), evidenceGap: z.string().nullable(),
  singleHarvestModeWarning: z.boolean(),
});
export const RejectedProblemCandidateSchema = z.object({
  id: EntityIdSchema,
  statement: z.string(),
  reason: z.string(),
});
export const MitigationViewSchema = z.object({
  id: EntityIdSchema, approach: z.string(), cost: z.string(), failsIf: z.string(), riskIds: z.array(EntityIdSchema),
});
export const RiskViewSchema = z.object({
  id: EntityIdSchema, description: z.string(), likelihood: z.enum(["rare", "possible", "likely"]),
  impact: z.enum(["≤3 days lost", "~2 weeks", "~2 months", "project ends"]), sortKey: z.number().int(),
  mitigations: z.array(MitigationViewSchema),
});
export const OutcomeViewSchema = z.object({
  id: EntityIdSchema, description: z.string(), direction: z.enum(["positive", "negative"]),
  affects: z.string(), addressesCore: z.boolean(),
});
export const SolutionViewSchema = z.object({
  discarded: z.boolean().optional(),
  detailsLoaded: z.boolean().optional(),
  highestRisk: RiskViewSchema.omit({ mitigations: true }).nullable().optional(),
  outcomeCount: z.number().int().nonnegative().optional(), riskCount: z.number().int().nonnegative().optional(),
  projectEndingRiskCount: z.number().int().nonnegative().optional(),
  workflowVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  runId: EntityIdSchema.optional(), selected: z.boolean().optional(), selectable: z.boolean().optional(),
  evidenceFollowUpStatus: z.enum(["running", "completed", "failed"]).optional(),
  canRequestEvidenceFollowUp: z.boolean().optional(),
  canReassessEvidence: z.boolean().optional(),
  keyAssumption: z.string().optional(), whyCurrentApproachMaySuffice: z.string().optional(),
  startupOpportunity: z.object({
    opportunityType: z.enum(["startup-opportunity", "process-improvement", "incumbent-configuration"]),
    payingCustomerSegment: z.string(), trigger: z.string(), existingSubstitute: z.string(),
    gapAssessment: z.object({ kind: z.enum(["evidenced", "hypothesis"]), description: z.string(), evidenceIds: z.array(z.string()) }).strict(),
    smallestSellableWorkflow: z.string(), firstCustomerRoute: z.string(), disconfirmingDemandTest: z.string(),
  }).strict().optional(),
  unknowns: z.array(z.string()).optional(), supportingEvidenceIds: z.array(z.string()).optional(), contraryEvidenceIds: z.array(z.string()).optional(),
  contrarySources: z.array(z.object({ id: EntityIdSchema, title: z.string(), url: z.string().url(), text: z.string() })).optional(),
  decisionAnalysis: WorkflowV2CompatibleDecisionAnalysisOutputSchema.nullable().optional(),
  riskEvaluation: WorkflowV2RiskEvaluationOutputSchema.nullable().optional(),
  riskEvaluationCriteria: z.string().optional(),
  evidenceFollowUp: EvidenceFollowUpViewSchema.optional(),
  userDecision: z.string().nullable().optional(), observedResult: z.string().nullable().optional(),
  experimentOutcome: z.enum(["not-run", "pass", "fail", "inconclusive"]).optional(), detailRevision: z.string().optional(),
  id: EntityIdSchema, problemId: EntityIdSchema, problemStatement: z.string(), problemVerdict: ProblemCandidateSchema.shape.verdict,
  factors: z.array(FactorViewSchema),
  mechanism: z.string(), description: z.string(), respectsOffLimits: z.boolean(), respectsOffLimitsWhy: z.string(),
  outcomes: z.array(OutcomeViewSchema), risks: z.array(RiskViewSchema),
  confirmedCoreOutcomes: z.number().int().nonnegative(), unaddressedCatastrophicRisks: z.number().int().nonnegative(),
});
const UsageDimensionSchema = z.object({ known: z.number().int().nonnegative(), unknownAttempts: z.number().int().nonnegative() }).strict();
const UsageCostTotalSchema = z.object({ currency: z.string().min(1), amount: z.number().nonnegative() }).strict();
export const RunUsageSchema = z.object({
  schemaVersion: z.literal(1),
  availability: z.enum(["available", "unavailable"]),
  attemptCount: z.number().int().nonnegative(),
  unknownAttemptCount: z.number().int().nonnegative(),
  models: z.array(ModelRefSchema),
  tokens: z.object({ input: UsageDimensionSchema, output: UsageDimensionSchema, total: UsageDimensionSchema, cachedInput: UsageDimensionSchema, reasoning: UsageDimensionSchema }).strict(),
  latencyMs: UsageDimensionSchema,
  repairCount: UsageDimensionSchema,
  costs: z.object({
    status: z.enum(["reported", "not_reported", "unknown", "mixed"]),
    reported: z.array(UsageCostTotalSchema),
    reportedWithoutCurrencyAttempts: z.number().int().nonnegative(),
    reportedWithoutCurrencyAmounts: z.array(z.number().nonnegative()),
    notReportedAttempts: z.number().int().nonnegative(),
    unknownAttempts: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export const LatestResearchRunSchema = z.object({
  workflowVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  runConfig: RunConfigSchema.nullable().optional(),
  awaitingSelection: z.boolean().optional(), interrupted: z.boolean().optional(),
  canResume: z.boolean().optional(), resumeBlockedReason: z.string().optional(),
  runId: EntityIdSchema, status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  problemId: EntityIdSchema.nullable(), codexCalls: z.number().int().nonnegative(), searches: z.number().int().nonnegative(),
  projectedCodexCalls: z.number().int().nonnegative(), projectedSearches: z.number().int().nonnegative(),
  lastActivity: z.string().nullable(), completionReason: z.string().nullable().optional(), usage: RunUsageSchema.optional(),
  stage: PendingRunSchema.shape.stage,
  modelState: PendingRunSchema.shape.modelState,
  elapsedMs: PendingRunSchema.shape.elapsedMs,
  operationStartedAt: PendingRunSchema.shape.operationStartedAt,
  operationElapsedMs: PendingRunSchema.shape.operationElapsedMs,
  lastSuccessfulCheckpoint: PendingRunSchema.shape.lastSuccessfulCheckpoint,
  queuePosition: PendingRunSchema.shape.queuePosition,
});

export const WorkspaceStateSchema = z.object({
  validation: ValidationStateSchema,
  threads: z.array(ThreadSchema), activeThreadId: z.string().nullable(), messages: z.array(MessageSchema),
  scope: ScopeSchema.nullable(), runConfig: RunConfigSchema.nullable(), models: z.array(ModelRefSchema),
  modelOptions: z.array(ModelOptionSchema),
  modelCatalog: ModelCatalogSchema, presets: z.array(z.object({ name: z.string(), config: RunConfigSchema })),
  problemCandidates: z.array(ProblemCandidateSchema), rejectedProblemCandidates: z.array(RejectedProblemCandidateSchema),
  solutions: z.array(SolutionViewSchema),
  latestResearchRun: LatestResearchRunSchema.nullable(), pendingRuns: z.array(PendingRunSchema),
});

export const ResearchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-started"), runId: EntityIdSchema, threadId: EntityIdSchema, problemId: EntityIdSchema.nullable() }),
  z.object({ type: z.literal("run-progress"), runId: EntityIdSchema, threadId: EntityIdSchema, message: z.string(), codexCalls: z.number().int(), searches: z.number().int(), usage: RunUsageSchema.optional(),
    stage: PendingRunSchema.shape.stage, modelState: PendingRunSchema.shape.modelState,
    elapsedMs: PendingRunSchema.shape.elapsedMs, operationStartedAt: PendingRunSchema.shape.operationStartedAt,
    operationElapsedMs: PendingRunSchema.shape.operationElapsedMs, lastSuccessfulCheckpoint: PendingRunSchema.shape.lastSuccessfulCheckpoint }),
  z.object({ type: z.literal("run-resumed"), runId: EntityIdSchema, threadId: EntityIdSchema }),
  z.object({ type: z.literal("run-completed"), runId: EntityIdSchema, threadId: EntityIdSchema, problemId: EntityIdSchema.nullable() }),
  z.object({ type: z.literal("run-cancelled"), runId: EntityIdSchema, threadId: EntityIdSchema }),
  z.object({ type: z.literal("run-failed"), runId: EntityIdSchema, threadId: EntityIdSchema, error: z.string() }),
]);

export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;
export type AppErrorPayload = z.infer<typeof AppErrorPayloadSchema>;
export type BackendReady = z.infer<typeof BackendReadySchema>;
export type ValidationState = z.infer<typeof ValidationStateSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type NativeLoginStartResult =
  | { loginId: string; providerId: string; method: "browser" }
  | { loginId: string; providerId: string; method: "device"; verificationUrl: string; userCode: string };
export type NativeLoginCompleteResult = { pending: true } | { pending: false; workspace: WorkspaceState };
export type ResearchEvent = z.infer<typeof ResearchEventSchema>;
export type PendingRun = z.infer<typeof PendingRunSchema>;
export type SourceDetail = z.infer<typeof SharedSourceDetailSchema>;
export type FactorView = z.infer<typeof FactorViewSchema>;
export type ProblemCandidate = z.infer<typeof ProblemCandidateSchema>;
export type RejectedProblemCandidate = z.infer<typeof RejectedProblemCandidateSchema>;
export type SolutionView = z.infer<typeof SolutionViewSchema>;
export type RunUsage = z.infer<typeof RunUsageSchema>;

export const IPC_CHANNELS = {
  APP_COMMAND: "scraply:app-command", SHOW_APP_MENU: "scraply:show-app-menu", DISCARD_IDEA: "scraply:discard-idea",
  SELECT_OPTION: "scraply:select-option", SAVE_DECISION: "scraply:save-decision", EVIDENCE_FOLLOW_UP: "scraply:evidence-follow-up",
  EVIDENCE_REASSESSMENT: "scraply:evidence-reassessment",
  GET_VALIDATION: "scraply:get-validation", RETRY_CONNECTION: "scraply:retry-connection",
  OPEN_DATA_FOLDER: "scraply:open-data-folder", OPEN_LOGS_FOLDER: "scraply:open-logs-folder",
  GET_WORKSPACE: "scraply:get-workspace", CREATE_THREAD: "scraply:create-thread", SELECT_THREAD: "scraply:select-thread",
  ARCHIVE_THREAD: "scraply:archive-thread", GENERATE_TITLE: "scraply:generate-title",
  DELETE_THREAD: "scraply:delete-thread", SAVE_SCOPE: "scraply:save-scope", SAVE_RUN_CONFIG: "scraply:save-run-config",
  SAVE_FAVORITE_MODEL: "scraply:save-favorite-model", START_RESEARCH: "scraply:start-research",
  CANCEL_RESEARCH: "scraply:cancel-research", RESUME_RESEARCH: "scraply:resume-research",
  SELECT_PROBLEMS: "scraply:select-problems", EXPORT_RESEARCH: "scraply:export-research", EXPORT_IDEAS: "scraply:export-ideas",
  GET_SOURCE_DETAIL: "scraply:get-source-detail", GET_IDEA_DETAIL: "scraply:get-idea-detail",
  NATIVE_LOGIN_START: "scraply:native-login-start", NATIVE_LOGIN_COMPLETE: "scraply:native-login-complete",
  NATIVE_LOGIN_CANCEL: "scraply:native-login-cancel",
  NATIVE_ACCOUNT_REFRESH: "scraply:native-account-refresh", NATIVE_LOGOUT: "scraply:native-logout",
  OPEN_EXTERNAL_URL: "scraply:open-external-url", BACKEND_EVENT: "scraply:backend-event",
} as const;
