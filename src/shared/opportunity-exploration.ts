import { z } from "zod";
import { FocusedDemandTestSchema } from "./focused-experiment";
import { WorkflowV2StartupSolutionOptionSchema } from "./structured-output-schemas";

export const DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG = {
  targetFamilies: 30,
  batchSize: 5,
  maxExpansionRounds: 2,
  maxRawCandidates: 60,
  maxModelCalls: 12,
  maxSearches: 6,
  allowExploratoryProblems: false,
} as const;

export const OpportunityExplorationConfigSchema = z.object({
  targetFamilies: z.number().int().min(2).max(30),
  batchSize: z.number().int().min(4).max(6),
  maxExpansionRounds: z.number().int().min(0).max(2),
  maxRawCandidates: z.number().int().min(1).max(60),
  maxModelCalls: z.number().int().min(1).max(40),
  maxSearches: z.number().int().min(0).max(20),
  allowExploratoryProblems: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.maxRawCandidates < value.targetFamilies) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxRawCandidates"],
      message: "Raw candidate limit must be at least the family target.",
    });
  }
  if (value.maxRawCandidates > value.targetFamilies * 2) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxRawCandidates"],
      message: "Raw candidate limit cannot exceed twice the family target.",
    });
  }
});

export const OpportunityExplorationStatusSchema = z.enum([
  "mapping-coverage",
  "searching-gap",
  "generating-batch",
  "reviewing-batch",
  "target-reached",
  "useful-partial",
  "budget-exhausted",
  "paused",
  "failed",
]);

export const OpportunityTerminalStatusSchema = z.enum([
  "target-reached",
  "useful-partial",
  "budget-exhausted",
  "paused",
  "failed",
]);

export const OpportunityCoverageGapSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  dimension: z.enum(["buyer", "workflow", "trigger", "problem", "evidence"]),
  evidenceNeeded: z.string().trim().min(1).max(1_000).nullable(),
  searchQuery: z.string().trim().min(1).max(500).nullable(),
  mapExhausted: z.boolean(),
  candidateOrigin: z.enum(["evidence-only", "exploratory-allowed"]),
  status: z.enum(["named", "search-needed", "ready", "covered", "exhausted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const OpportunityCoverageMapOutputSchema = z.object({
  gaps: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    dimension: z.enum(["buyer", "workflow", "trigger", "problem", "evidence"]),
    evidenceNeeded: z.string().trim().min(1).max(1_000).nullable(),
    searchQuery: z.string().trim().min(1).max(500).nullable(),
    mapExhausted: z.boolean(),
    candidateOrigin: z.enum(["evidence-only", "exploratory-allowed"]),
  }).strict()).max(5),
  noUsefulGapReason: z.string().trim().min(1).max(1_000).nullable(),
}).strict();

export const OpportunityExpansionOutputSchema = z.object({
  problemHypothesis: z.object({
    statement: z.string().trim().min(1).max(2_000),
    whyItPersists: z.string().trim().min(1).max(2_000),
    affected: z.string().trim().min(1).max(1_000),
    scaleEstimate: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(z.string().trim().min(1).max(128)).max(50),
    evidenceGap: z.string().trim().min(1).max(1_000).nullable(),
  }).strict(),
  options: z.array(WorkflowV2StartupSolutionOptionSchema.extend({
    focusedDemandTest: FocusedDemandTestSchema,
  }).strict()).max(6),
}).strict();

const OpportunityProblemEvidenceOriginSchema = z.object({
  kind: z.literal("problem-evidence"),
  problemId: z.string().trim().min(1).max(128),
  evidenceIds: z.array(z.string().trim().min(1).max(128)).max(100),
  evidenceGap: z.string().trim().min(1).max(1_000).nullable(),
}).strict();

const OpportunityExploratoryOriginSchema = z.object({
  kind: z.literal("exploratory-hypothesis"),
  coverageGapId: z.string().trim().min(1).max(128),
  evidenceIds: z.tuple([]),
  disclosure: z.string().trim().min(1).max(500),
}).strict();

export const OpportunityCandidateOriginSchema = z.discriminatedUnion("kind", [
  OpportunityProblemEvidenceOriginSchema,
  OpportunityExploratoryOriginSchema,
]);

export const OpportunityExplorationUsageSchema = z.object({
  modelCalls: z.number().int().nonnegative(),
  searches: z.number().int().nonnegative(),
  rawCandidates: z.number().int().nonnegative(),
  expansionRounds: z.number().int().nonnegative(),
}).strict();

export const OpportunityExplorationCountsSchema = z.object({
  acceptedFamilies: z.number().int().nonnegative(),
  variants: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  unreviewed: z.number().int().nonnegative(),
}).strict();

export const OpportunityBatchStatusSchema = z.enum([
  "planned",
  "generating",
  "awaiting-review",
  "reviewing",
  "reviewed",
  "failed",
  "unknown-dispatch",
]);

export const OpportunityExplorationBatchSchema = z.object({
  id: z.string().trim().min(1).max(128),
  ordinal: z.number().int().positive(),
  coverageGapId: z.string().trim().min(1).max(128).nullable(),
  requestedCandidates: z.number().int().min(1).max(6),
  savedCandidateIds: z.array(z.string().trim().min(1).max(128)).max(6),
  status: OpportunityBatchStatusSchema,
  acceptedFamiliesBefore: z.number().int().nonnegative(),
  acceptedFamiliesAfter: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const OpportunityExplorationProgressSchema = z.object({
  threadId: z.string().trim().min(1).max(128),
  config: OpportunityExplorationConfigSchema,
  status: OpportunityExplorationStatusSchema,
  stopReason: z.string().trim().min(1).max(1_000).nullable(),
  usage: OpportunityExplorationUsageSchema,
  counts: OpportunityExplorationCountsSchema,
  originCounts: z.object({
    problemEvidence: z.number().int().nonnegative(),
    exploratoryHypotheses: z.number().int().nonnegative(),
  }).strict(),
  gaps: z.array(OpportunityCoverageGapSchema).max(50),
  batches: z.array(OpportunityExplorationBatchSchema).max(20),
  activeGapId: z.string().trim().min(1).max(128).nullable(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const OpportunityBudgetExtensionSchema = z.object({
  additionalModelCalls: z.number().int().min(0).max(20),
  additionalSearches: z.number().int().min(0).max(10),
}).strict().refine((value) => Object.values(value).some((amount) => amount > 0), {
  message: "A budget extension must increase at least one limit.",
});

export const OpportunityBudgetExtensionPreviewSchema = z.object({
  current: OpportunityExplorationConfigSchema,
  proposed: OpportunityExplorationConfigSchema,
  nextGap: OpportunityCoverageGapSchema.nullable(),
  estimatedAdditionalCalls: z.object({
    modelCalls: z.number().int().nonnegative(),
    searches: z.number().int().nonnegative(),
  }).strict(),
  summary: z.string().trim().min(1).max(500),
}).strict();

export const OpportunityExplorationExportSchema = z.object({
  schemaVersion: z.literal(1),
  progress: OpportunityExplorationProgressSchema,
  origins: z.array(z.object({
    candidateId: z.string().min(1),
    batchId: z.string().min(1).nullable(),
    origin: OpportunityCandidateOriginSchema,
    createdAt: z.string().datetime(),
  }).strict()),
  attempts: z.array(z.object({
    id: z.string().min(1),
    stageKey: z.string().min(1),
    stageName: z.string().min(1),
    status: z.enum(["prepared", "dispatched", "completed", "failed", "unknown-dispatch"]),
    input: z.unknown(),
    model: z.unknown(),
    promptVersion: z.string(),
    promptText: z.string(),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    preparedAt: z.string().datetime(),
    dispatchedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  }).strict()),
  budgetExtensions: z.array(z.object({
    id: z.string().min(1),
    previousConfig: OpportunityExplorationConfigSchema,
    proposedConfig: OpportunityExplorationConfigSchema,
    preview: OpportunityBudgetExtensionPreviewSchema,
    createdAt: z.string().datetime(),
  }).strict()),
}).strict();

export type OpportunityExplorationConfig = z.infer<typeof OpportunityExplorationConfigSchema>;
export type OpportunityExplorationStatus = z.infer<typeof OpportunityExplorationStatusSchema>;
export type OpportunityTerminalStatus = z.infer<typeof OpportunityTerminalStatusSchema>;
export type OpportunityCoverageGap = z.infer<typeof OpportunityCoverageGapSchema>;
export type OpportunityCoverageMapOutput = z.infer<typeof OpportunityCoverageMapOutputSchema>;
export type OpportunityExpansionOutput = z.infer<typeof OpportunityExpansionOutputSchema>;
export type OpportunityCandidateOrigin = z.infer<typeof OpportunityCandidateOriginSchema>;
export type OpportunityExplorationUsage = z.infer<typeof OpportunityExplorationUsageSchema>;
export type OpportunityExplorationCounts = z.infer<typeof OpportunityExplorationCountsSchema>;
export type OpportunityExplorationBatch = z.infer<typeof OpportunityExplorationBatchSchema>;
export type OpportunityExplorationProgress = z.infer<typeof OpportunityExplorationProgressSchema>;
export type OpportunityBudgetExtension = z.infer<typeof OpportunityBudgetExtensionSchema>;
export type OpportunityBudgetExtensionPreview = z.infer<typeof OpportunityBudgetExtensionPreviewSchema>;
export type OpportunityExplorationExport = z.infer<typeof OpportunityExplorationExportSchema>;
