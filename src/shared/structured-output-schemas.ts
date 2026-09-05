import { z } from "zod";

export const HarvestModeSchema = z.enum(["domain", "audience"]);
export const ProblemVerdictSchema = z.enum([
  "confirmed",
  "overstated",
  "already-solved",
  "insufficient-evidence",
  "attempted-and-failed",
  "user-asserted",
]);
export const OutcomeDirectionSchema = z.enum(["positive", "negative"]);
export const RiskLikelihoodSchema = z.enum(["rare", "possible", "likely"]);
export const RiskImpactSchema = z.enum(["≤3 days lost", "~2 weeks", "~2 months", "project ends"]);

export const ScopeSchema = z.object({
  title: z.string(),
  audience: z.string(),
  domain: z.string(),
  observations: z.string(),
  offLimits: z.array(z.string()),
}).strict();

export const FactorSchema = z.object({
  subject: z.string(),
  behavior: z.string(),
  quote: z.string(),
  sourceId: z.string(),
  harvestMode: HarvestModeSchema,
  modelConfidence: z.number(),
}).strict();

export const ProblemSchema = z.object({
  statement: z.string(),
  whyItPersists: z.string(),
  affected: z.string(),
  scaleEstimate: z.string(),
  scaleBasisFactorId: z.string().nullable(),
  factorIds: z.array(z.string()),
  verdict: ProblemVerdictSchema,
  verdictReason: z.string(),
  verdictSourceIds: z.array(z.string()),
}).strict();

export const SolutionSchema = z.object({
  problemId: z.string(),
  mechanism: z.string(),
  description: z.string(),
  respectsOffLimits: z.boolean(),
  respectsOffLimitsWhy: z.string(),
}).strict();

export const OutcomeSchema = z.object({
  solutionId: z.string(),
  description: z.string(),
  direction: OutcomeDirectionSchema,
  affects: z.string(),
  addressesCore: z.boolean(),
}).strict();

export const RiskSchema = z.object({
  solutionId: z.string(),
  description: z.string(),
  likelihood: RiskLikelihoodSchema,
  impact: RiskImpactSchema,
  sortKey: z.number(),
}).strict();

export const ProposedMitigationSchema = z.object({
  solutionId: z.string(),
  riskIds: z.array(z.string()),
  approach: z.string(),
  cost: z.string(),
  failsIf: z.string(),
}).strict();

export const QueryPlanOutputSchema = z.object({
  queries: z.array(z.string()),
}).strict();

export const FactorHarvestOutputSchema = z.object({
  factors: z.array(FactorSchema.omit({ harvestMode: true })),
}).strict();

export const ProblemCandidatesOutputSchema = z.object({
  problems: z.array(ProblemSchema.pick({
    statement: true,
    whyItPersists: true,
    affected: true,
    scaleEstimate: true,
    scaleBasisFactorId: true,
    factorIds: true,
  })),
}).strict();

export const ProblemKillOutputSchema = ProblemSchema.pick({
  verdict: true,
  verdictReason: true,
  verdictSourceIds: true,
}).extend({
  verdict: ProblemVerdictSchema.exclude(["user-asserted"]),
}).strict();

export const SolutionsOutputSchema = z.object({
  solutions: z.array(SolutionSchema.omit({ problemId: true })),
}).strict();

export const OutcomesOutputSchema = z.object({
  outcomes: z.array(OutcomeSchema.omit({ solutionId: true, addressesCore: true })),
}).strict();

export const OutcomeJudgeOutputSchema = z.object({
  judgments: z.array(z.object({
    outcomeId: z.string(),
    addressesCore: z.boolean(),
  }).strict()),
}).strict();

export const RisksOutputSchema = z.object({
  risks: z.array(RiskSchema.pick({ description: true })),
}).strict();

export const RiskScoreOutputSchema = z.object({
  scores: z.array(z.object({
    riskId: z.string(),
    likelihood: RiskLikelihoodSchema,
    impact: RiskImpactSchema,
  }).strict()),
}).strict();

export const MitigationsOutputSchema = z.object({
  mitigations: z.array(ProposedMitigationSchema.omit({ solutionId: true })),
}).strict();

const WorkflowV2RequiredTextSchema = z.string().trim().min(1);

export const WorkflowV2QueryPlanItemSchema = z.object({
  query: WorkflowV2RequiredTextSchema,
  uncertainty: WorkflowV2RequiredTextSchema,
  intendedSourceType: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2QueryPlanOutputSchema = z.object({
  queries: z.array(WorkflowV2QueryPlanItemSchema),
}).strict();

export const WorkflowV2FactorSchema = FactorSchema.omit({ harvestMode: true }).extend({
  subject: WorkflowV2RequiredTextSchema,
  behavior: WorkflowV2RequiredTextSchema,
  quote: WorkflowV2RequiredTextSchema,
  sourceId: WorkflowV2RequiredTextSchema,
  uncertainty: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2FactorHarvestOutputSchema = z.object({
  factors: z.array(WorkflowV2FactorSchema),
}).strict();

export const WorkflowV2ProblemCandidateSchema = ProblemSchema.pick({
  statement: true,
  whyItPersists: true,
  affected: true,
  scaleEstimate: true,
  scaleBasisFactorId: true,
  factorIds: true,
}).extend({
  statement: WorkflowV2RequiredTextSchema,
  whyItPersists: WorkflowV2RequiredTextSchema,
  affected: WorkflowV2RequiredTextSchema,
  scaleEstimate: WorkflowV2RequiredTextSchema,
  factorIds: z.array(WorkflowV2RequiredTextSchema),
  alternativeExplanations: z.array(WorkflowV2RequiredTextSchema),
  unknowns: z.array(WorkflowV2RequiredTextSchema),
}).strict();

export const WorkflowV2ProblemCandidatesOutputSchema = z.object({
  problems: z.array(WorkflowV2ProblemCandidateSchema),
}).strict();

export const WorkflowV2ProblemKillOutputSchema = ProblemSchema.pick({
  verdict: true,
  verdictReason: true,
  verdictSourceIds: true,
}).extend({
  verdict: ProblemVerdictSchema.exclude(["user-asserted"]),
  verdictReason: WorkflowV2RequiredTextSchema,
  verdictSourceIds: z.array(WorkflowV2RequiredTextSchema),
  unresolvedAssumptions: z.array(WorkflowV2RequiredTextSchema),
  wouldChangeConclusion: z.array(WorkflowV2RequiredTextSchema),
}).strict();

export const WorkflowV2SolutionOptionSchema = z.object({
  mechanism: WorkflowV2RequiredTextSchema,
  description: WorkflowV2RequiredTextSchema,
  keyAssumption: WorkflowV2RequiredTextSchema,
  whyCurrentApproachMaySuffice: WorkflowV2RequiredTextSchema,
  supportingEvidenceIds: z.array(WorkflowV2RequiredTextSchema),
  contraryEvidenceIds: z.array(WorkflowV2RequiredTextSchema),
  unknowns: z.array(WorkflowV2RequiredTextSchema),
  respectsOffLimits: z.boolean(),
  respectsOffLimitsWhy: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2SolutionsOutputSchema = z.object({
  options: z.array(WorkflowV2SolutionOptionSchema),
}).strict();

export const WorkflowV2ConsequenceSchema = z.object({
  description: WorkflowV2RequiredTextSchema,
  direction: OutcomeDirectionSchema,
  affects: WorkflowV2RequiredTextSchema,
  rationale: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2DecisionRiskSchema = z.object({
  riskId: WorkflowV2RequiredTextSchema,
  description: WorkflowV2RequiredTextSchema,
  whyDecisive: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2ProposedResponseSchema = z.object({
  riskIds: z.array(WorkflowV2RequiredTextSchema),
  approach: WorkflowV2RequiredTextSchema,
  cost: WorkflowV2RequiredTextSchema,
  failsIf: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2ExperimentSchema = z.object({
  question: WorkflowV2RequiredTextSchema,
  method: WorkflowV2RequiredTextSchema,
  cost: WorkflowV2RequiredTextSchema,
  passCriterion: WorkflowV2RequiredTextSchema,
  failCriterion: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2DecisionAnalysisOutputSchema = z.object({
  consequences: z.array(WorkflowV2ConsequenceSchema),
  risks: z.array(WorkflowV2DecisionRiskSchema),
  proposedResponses: z.array(WorkflowV2ProposedResponseSchema),
  unknowns: z.array(WorkflowV2RequiredTextSchema),
  experiment: WorkflowV2ExperimentSchema,
}).strict();

export const STRUCTURED_OUTPUT_SCHEMAS = {
  queryPlan: QueryPlanOutputSchema,
  factorHarvest: FactorHarvestOutputSchema,
  problemCandidates: ProblemCandidatesOutputSchema,
  problemKill: ProblemKillOutputSchema,
  solutions: SolutionsOutputSchema,
  outcomes: OutcomesOutputSchema,
  outcomeJudge: OutcomeJudgeOutputSchema,
  risks: RisksOutputSchema,
  riskScore: RiskScoreOutputSchema,
  mitigations: MitigationsOutputSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export const WORKFLOW_V2_STRUCTURED_OUTPUT_SCHEMAS = {
  workflowV2QueryPlan: WorkflowV2QueryPlanOutputSchema,
  workflowV2FactorHarvest: WorkflowV2FactorHarvestOutputSchema,
  workflowV2ProblemCandidates: WorkflowV2ProblemCandidatesOutputSchema,
  workflowV2ProblemKill: WorkflowV2ProblemKillOutputSchema,
  workflowV2Solutions: WorkflowV2SolutionsOutputSchema,
  workflowV2DecisionAnalysis: WorkflowV2DecisionAnalysisOutputSchema,
} as const satisfies Record<string, z.ZodType<unknown>>;

export type Scope = z.infer<typeof ScopeSchema>;
export type Factor = z.infer<typeof FactorSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type Solution = z.infer<typeof SolutionSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type ProposedMitigation = z.infer<typeof ProposedMitigationSchema>;
export type WorkflowV2SolutionOption = z.infer<typeof WorkflowV2SolutionOptionSchema>;
export type WorkflowV2DecisionAnalysis = z.infer<typeof WorkflowV2DecisionAnalysisOutputSchema>;
