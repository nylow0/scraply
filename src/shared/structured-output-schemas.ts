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

export type Scope = z.infer<typeof ScopeSchema>;
export type Factor = z.infer<typeof FactorSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type Solution = z.infer<typeof SolutionSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type ProposedMitigation = z.infer<typeof ProposedMitigationSchema>;
