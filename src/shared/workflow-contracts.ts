import { z } from "zod";
import { ScopeSchema } from "./structured-output-schemas";
import { ModelRefSchema, ReasoningEffortSchema, RunConfigSchema } from "./schemas";

const IdSchema = z.string().trim().min(1).max(128);
const TextSchema = z.string().trim().min(1).max(20_000);
const ResearchQuestionSchema = z.string().trim().min(1).max(500);
const NonnegativeCountSchema = z.number().int().nonnegative();
const ModelChoiceSchema = z.object({ model: ModelRefSchema, reasoningEffort: ReasoningEffortSchema }).strict();

export const WorkflowModeSchema = z.enum(["babysit", "vibe"]);
export const WorkflowPurposeSchema = z.enum(["discovery", "known-problem", "research-followup", "idea-turn"]);
export const WorkflowStateSchema = z.enum(["running", "waiting-for-review", "pause-requested", "paused", "stop-requested", "finished"]);
export const WorkflowOutcomeSchema = z.enum(["target-met", "partial", "no-qualifying-ideas", "failed", "cancelled", "needs-attention"]);
export const WorkflowTargetSchema = z.object({
  kind: z.enum(["per-problem", "project"]),
  ideaCount: z.number().int().min(1).max(20),
  distinctBusinessCount: z.number().int().positive().optional(),
  automaticProblemCap: z.number().int().min(1).max(20).optional(),
}).strict();
export const WorkflowLimitsSchema = z.object({
  maxMinutes: z.number().int().min(1).max(240),
  maxModelCalls: z.number().int().positive(),
  maxSearches: NonnegativeCountSchema,
}).strict();
export const WorkflowInstructionsSchema = z.object({
  research: z.string().max(20_000).optional(),
  ideas: z.string().max(20_000).optional(),
  review: z.string().max(20_000).optional(),
}).strict();

/** A preview normalizes this editable draft into the immutable launch contract. */
export const WorkflowLaunchDraftSchema = z.object({
  contractVersion: z.literal(1),
  purpose: WorkflowPurposeSchema,
  mode: WorkflowModeSchema,
  brief: TextSchema,
  scope: ScopeSchema,
  runConfig: RunConfigSchema,
  ideas: ModelChoiceSchema.extend({ reviewModel: ModelRefSchema.optional(), reviewReasoningEffort: ReasoningEffortSchema.optional() }).strict().optional(),
  targets: WorkflowTargetSchema,
  limits: WorkflowLimitsSchema,
  instructions: WorkflowInstructionsSchema.default({}),
}).strict();
export const WorkflowLaunchContractSchema = WorkflowLaunchDraftSchema.extend({
  resolvedInstructions: z.object({ research: z.string(), ideas: z.string(), review: z.string() }).strict(),
  instructionHashes: z.object({ research: z.string().min(1), ideas: z.string().min(1), review: z.string().min(1) }).strict(),
}).strict();

export const WorkflowBudgetExtensionSchema = z.object({
  additionalModelCalls: NonnegativeCountSchema,
  additionalSearches: NonnegativeCountSchema,
  additionalMinutes: NonnegativeCountSchema,
}).strict().refine((value) => value.additionalModelCalls + value.additionalSearches + value.additionalMinutes > 0, "Increase at least one limit.");
export const PreviewWorkflowRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("launch"), threadId: IdSchema, draft: WorkflowLaunchDraftSchema }).strict(),
  z.object({ type: z.literal("budget-extension"), threadId: IdSchema, sessionId: IdSchema, expectedRevision: NonnegativeCountSchema, extension: WorkflowBudgetExtensionSchema }).strict(),
]);
export const WorkflowFieldErrorSchema = z.object({ path: z.array(z.string()), code: z.string(), message: z.string() }).strict();
export const PreviewWorkflowResultSchema = z.object({
  type: z.enum(["launch", "budget-extension"]),
  proposal: z.union([WorkflowLaunchContractSchema, WorkflowBudgetExtensionSchema]),
  previewHash: z.string().min(1),
  capabilityFingerprint: z.string().min(1),
  minimumWork: z.object({ modelCalls: NonnegativeCountSchema, searches: NonnegativeCountSchema }).strict(),
  upperLimits: WorkflowLimitsSchema,
  fieldErrors: z.array(WorkflowFieldErrorSchema),
  expiresAt: z.string().datetime(),
}).strict();
export const StartWorkflowRequestSchema = z.object({
  threadId: IdSchema,
  clientCommandId: IdSchema,
  contract: WorkflowLaunchContractSchema,
  previewHash: z.string().min(1),
  capabilityFingerprint: z.string().min(1),
  previewExpiresAt: z.string().datetime(),
}).strict();

export const WorkflowCountsSchema = z.object({
  requested: NonnegativeCountSchema,
  attempted: NonnegativeCountSchema,
  validated: NonnegativeCountSchema,
  accepted: NonnegativeCountSchema,
  duplicate: NonnegativeCountSchema,
  unresolved: NonnegativeCountSchema,
  failed: NonnegativeCountSchema,
  missing: NonnegativeCountSchema,
  existing: NonnegativeCountSchema,
  addedBySession: NonnegativeCountSchema,
  total: NonnegativeCountSchema,
}).strict();
export const WorkflowBudgetStatusSchema = z.object({
  modelCalls: z.object({ limit: NonnegativeCountSchema, spent: NonnegativeCountSchema, reserved: NonnegativeCountSchema, uncertain: NonnegativeCountSchema }).strict(),
  searches: z.object({ limit: NonnegativeCountSchema, spent: NonnegativeCountSchema, reserved: NonnegativeCountSchema, uncertain: NonnegativeCountSchema }).strict(),
  remainingMs: NonnegativeCountSchema,
}).strict();
export const WorkflowSummarySchema = z.object({
  sessionId: IdSchema,
  threadId: IdSchema,
  purpose: WorkflowPurposeSchema,
  mode: WorkflowModeSchema,
  targetKind: z.enum(["per-problem", "project"]),
  state: WorkflowStateSchema,
  outcome: WorkflowOutcomeSchema.nullable(),
  revision: NonnegativeCountSchema,
  activeSnapshotId: IdSchema.nullable(),
  selectedProblemIds: z.array(IdSchema),
  counts: WorkflowCountsSchema,
  limits: WorkflowLimitsSchema,
  budget: WorkflowBudgetStatusSchema,
  currentStage: z.string().nullable(),
  stopReason: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
}).strict();
export const WorkflowTaskSchema = z.object({
  id: IdSchema,
  terminalAttemptId: IdSchema.optional(),
  parentItemId: IdSchema.nullable(),
  kind: z.string().min(1),
  scopeKey: z.string().min(1),
  state: z.enum(["planned", "ready", "running", "succeeded", "failed", "cancelled", "skipped", "unknown"]),
  question: z.string().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
}).strict();
export const GetWorkflowRequestSchema = z.object({ sessionId: IdSchema, cursor: z.string().max(512).optional() }).strict();
export const WorkflowDetailSchema = z.object({ summary: WorkflowSummarySchema, tasks: z.array(WorkflowTaskSchema), nextCursor: z.string().nullable() }).strict();
export const WorkflowAdmissionReceiptSchema = z.object({ sessionId: IdSchema, revision: NonnegativeCountSchema, summary: WorkflowSummarySchema }).strict();

export const WorkflowActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request-research"), kind: z.enum(["new-question", "redo", "reevaluate"]), question: ResearchQuestionSchema,
    baseSnapshotId: IdSchema.optional(), targetFindingId: IdSchema.optional(), targetRequestId: IdSchema.optional(),
    model: ModelRefSchema, reasoningEffort: ReasoningEffortSchema,
    allowance: z.object({ maxModelCalls: z.number().int().positive(), maxSearches: NonnegativeCountSchema, maxMinutes: z.number().int().positive() }).strict(),
    angles: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
    instructions: z.string().trim().max(20_000).optional(),
  }).strict(),
  z.object({ type: z.literal("apply-research"), baseSnapshotId: IdSchema.optional(), includedRequestIds: z.array(IdSchema), replacements: z.array(z.object({ oldFindingId: IdSchema, newFindingId: IdSchema }).strict()) }).strict(),
  z.object({ type: z.literal("generate-ideas"), snapshotId: IdSchema, problemIds: z.array(IdSchema).min(1), model: ModelRefSchema, reasoningEffort: ReasoningEffortSchema, reviewModel: ModelRefSchema.optional(), reviewReasoningEffort: ReasoningEffortSchema.optional(), target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("per-problem"), count: z.number().int().min(1).max(20) }).strict(),
    z.object({ kind: z.literal("project"), count: z.number().int().min(1).max(30) }).strict(),
  ]) }).strict(),
  z.object({ type: z.literal("pause"), reason: z.string().max(1_000).optional() }).strict(),
  z.object({ type: z.literal("resume"), reason: z.string().max(1_000).optional() }).strict(),
  z.object({ type: z.literal("stop"), reason: z.string().max(1_000).optional() }).strict(),
  z.object({ type: z.literal("retry-task"), taskId: IdSchema, expectedTerminalAttemptId: IdSchema, acknowledgeUnknownCompletion: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("extend-budget"), previewHash: z.string().min(1), capabilityFingerprint: z.string().min(1), previewExpiresAt: z.string().datetime(), extension: WorkflowBudgetExtensionSchema }).strict(),
  z.object({ type: z.literal("select-version"), rootSolutionId: IdSchema, solutionId: IdSchema }).strict(),
]).superRefine((value, ctx) => {
  if (value.type !== "request-research") return;
  if (value.kind !== "new-question" && !value.targetFindingId) ctx.addIssue({ code: "custom", path: ["targetFindingId"], message: "Choose the finding to revisit." });
  if (value.kind === "new-question" && value.targetFindingId) ctx.addIssue({ code: "custom", path: ["targetFindingId"], message: "Use redo to replace a finding." });
  if (value.kind === "reevaluate" && value.allowance.maxSearches !== 0) ctx.addIssue({ code: "custom", path: ["allowance", "maxSearches"], message: "Reevaluation cannot search." });
});
export const CommandWorkflowRequestSchema = z.object({
  threadId: IdSchema, sessionId: IdSchema, clientCommandId: IdSchema, expectedRevision: NonnegativeCountSchema, action: WorkflowActionSchema,
}).strict();

export const IdeaTurnIntentSchema = z.enum(["explain", "explore-directions", "rethink"]);
export const GetIdeaConversationRequestSchema = z.object({ ideaId: IdSchema, branchId: IdSchema.optional(), cursor: z.string().max(512).optional() }).strict();
export const SelectIdeaVersionRequestSchema = z.object({ threadId: IdSchema, rootSolutionId: IdSchema, solutionId: IdSchema }).strict();
export const IdeaVersionSchema = z.object({
  solutionId: IdSchema, parentSolutionId: IdSchema.nullable(), versionNumber: z.number().int().positive(),
  evidenceSnapshotId: IdSchema.nullable(), changeSummary: z.string().nullable(),
  mechanism: z.string(), description: z.string(),
  reviewFreshness: z.enum(["current", "stale", "unreviewed"]), model: ModelRefSchema.nullable(), reasoningEffort: ReasoningEffortSchema.nullable(),
}).strict();
export const IdeaConversationTurnSchema = z.object({
  id: IdSchema, branchId: IdSchema, branchSequence: z.number().int().positive(), parentTurnId: IdSchema.nullable(),
  baseSolutionId: IdSchema, intent: IdeaTurnIntentSchema, userText: z.string(),
  state: z.enum(["pending", "running", "completed", "failed", "cancelled", "unknown"]),
  model: ModelRefSchema, reasoningEffort: ReasoningEffortSchema,
  assistant: z.object({ text: z.string(), citedEvidenceIds: z.array(IdSchema), assumptions: z.array(z.string()), changeSummary: z.string().nullable(), generatedSolutionId: IdSchema.nullable() }).strict().nullable(),
  error: z.string().nullable(), createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
}).strict();
export const IdeaConversationSchema = z.object({
  rootSolutionId: IdSchema, selectedVersionId: IdSchema, defaultModel: ModelRefSchema.nullable(),
  versions: z.array(IdeaVersionSchema),
  branches: z.array(z.object({ branchId: IdSchema, headTurnId: IdSchema.nullable(), turnCount: NonnegativeCountSchema }).strict()),
  turns: z.array(IdeaConversationTurnSchema), nextCursor: z.string().nullable(),
}).strict();
export const SubmitIdeaTurnRequestSchema = z.object({
  threadId: IdSchema, rootSolutionId: IdSchema, baseSolutionId: IdSchema, branchId: IdSchema.optional(),
  expectedHeadTurnId: IdSchema.nullable(), parentTurnId: IdSchema.nullable(), clientMessageId: IdSchema,
  intent: IdeaTurnIntentSchema, text: z.string().trim().min(1).max(4_000), evidenceSnapshotId: IdSchema.optional(),
  model: ModelRefSchema, reasoningEffort: ReasoningEffortSchema,
  allowance: z.object({ maxModelCalls: z.number().int().min(1).max(2), maxMinutes: z.number().int().min(1).max(30) }).strict(),
  branchFromEarlier: z.boolean().optional(),
}).strict();
export const SubmitIdeaTurnResultSchema = WorkflowAdmissionReceiptSchema.extend({ turnId: IdSchema }).strict();

export type WorkflowLaunchDraft = z.infer<typeof WorkflowLaunchDraftSchema>;
export type WorkflowLaunchContract = z.infer<typeof WorkflowLaunchContractSchema>;
export type WorkflowAction = z.infer<typeof WorkflowActionSchema>;
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;
export type WorkflowAdmissionReceipt = z.infer<typeof WorkflowAdmissionReceiptSchema>;
export type IdeaConversation = z.infer<typeof IdeaConversationSchema>;
export type SubmitIdeaTurnRequest = z.infer<typeof SubmitIdeaTurnRequestSchema>;
