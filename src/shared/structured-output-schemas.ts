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
export const ProblemBriefFitSchema = z.enum(["direct", "partial", "unknown", "outside"]);
export const ProblemContraryEvidenceSchema = z.enum(["resolved", "unknown", "unresolved"]);
export type ProblemBriefFit = z.infer<typeof ProblemBriefFitSchema>;
export type ProblemContraryEvidence = z.infer<typeof ProblemContraryEvidenceSchema>;
const ProblemWorkflowKeySchema = z.string().trim().min(1).max(160).nullable();
export const OutcomeDirectionSchema = z.enum(["positive", "negative"]);
export const RiskLikelihoodSchema = z.enum(["rare", "possible", "likely"]);
export const RiskImpactSchema = z.enum(["≤3 days lost", "~2 weeks", "~2 months", "project ends"]);

export const ScopeSchema = z.object({
  title: z.string(),
  audience: z.string(),
  domain: z.string(),
  observations: z.string(),
  riskEvaluationCriteria: z.string().trim().max(4_000).optional(),
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
  queries: z.array(z.union([z.string(), z.object({
    query: z.string(), uncertainty: z.string(), intendedSourceType: z.string(),
  }).strict(), z.object({
    query: z.string(),
    intent: z.string(),
    uncertainty: z.string(),
    intendedSourceType: z.string(),
  }).strict()])),
}).strict();

export const FactorHarvestOutputSchema = z.object({
  factors: z.array(z.union([
    FactorSchema.omit({ harvestMode: true }),
    FactorSchema.omit({ harvestMode: true }).extend({ uncertainty: z.string() }).strict(),
    FactorSchema.omit({ harvestMode: true }).extend({
      uncertainty: z.string(),
      sourceRole: z.enum(["firsthand", "measured", "vendor", "recommendation", "illustration", "unknown"]),
      audienceFit: z.enum(["intended-buyer", "adjacent", "general", "unknown"]),
      independentSourceKey: z.string().nullable(),
      supportsDemand: z.boolean(),
      demandEvidenceUncertainty: z.string(),
    }).strict(),
  ])),
}).strict();

export const ProblemCandidatesOutputSchema = z.object({
  problems: z.array(z.union([ProblemSchema.pick({
    statement: true,
    whyItPersists: true,
    affected: true,
    scaleEstimate: true,
    scaleBasisFactorId: true,
    factorIds: true,
  }), ProblemSchema.pick({
    statement: true, whyItPersists: true, affected: true, scaleEstimate: true,
    scaleBasisFactorId: true, factorIds: true,
  }).extend({
    intendedBuyerEvidenceFactorIds: z.array(z.string()), evidenceGap: z.string().nullable(),
  }).strict()])),
}).strict();

const LegacyProblemKillOutputSchema = ProblemSchema.pick({
  verdict: true,
  verdictReason: true,
  verdictSourceIds: true,
}).extend({ verdict: ProblemVerdictSchema.exclude(["user-asserted"]) }).strict();

const ClassifiedProblemKillOutputSchema = ProblemSchema.pick({
  verdict: true, verdictReason: true, verdictSourceIds: true,
}).extend({
  verdict: ProblemVerdictSchema.exclude(["user-asserted"]),
  intendedBuyerEvidenceFactorIds: z.array(z.string()), evidenceGap: z.string().nullable(),
}).strict();

const ExplicitProblemKillOutputSchema = ClassifiedProblemKillOutputSchema.extend({
  briefFit: ProblemBriefFitSchema,
  contraryEvidence: ProblemContraryEvidenceSchema,
  workflowKey: ProblemWorkflowKeySchema,
}).strict();

export const ProblemKillOutputSchema = z.union([
  LegacyProblemKillOutputSchema,
  ClassifiedProblemKillOutputSchema,
  ExplicitProblemKillOutputSchema,
]);

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

export const OpportunityTypeSchema = z.enum([
  "startup-opportunity",
  "process-improvement",
  "incumbent-configuration",
]);

export const StartupGapAssessmentSchema = z.object({
  kind: z.enum(["evidenced", "hypothesis"]),
  description: WorkflowV2RequiredTextSchema,
  evidenceIds: z.array(WorkflowV2RequiredTextSchema),
}).strict();

export const StartupOpportunityDetailsSchema = z.object({
  opportunityType: OpportunityTypeSchema,
  payingCustomerSegment: WorkflowV2RequiredTextSchema,
  trigger: WorkflowV2RequiredTextSchema,
  existingSubstitute: WorkflowV2RequiredTextSchema,
  gapAssessment: StartupGapAssessmentSchema,
  smallestSellableWorkflow: WorkflowV2RequiredTextSchema,
  firstCustomerRoute: WorkflowV2RequiredTextSchema,
  disconfirmingDemandTest: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2QueryIntentSchema = z.enum([
  "firsthand-experience",
  "measured-behavior",
  "current-alternative",
  "buying-signal",
  "contrary-evidence",
]);

export const EvidenceSourceRoleSchema = z.enum([
  "firsthand",
  "measured",
  "vendor",
  "recommendation",
  "illustration",
  "unknown",
]);

export const EvidenceAudienceFitSchema = z.enum([
  "intended-buyer",
  "adjacent",
  "general",
  "unknown",
]);

const LegacyWorkflowV2QueryPlanItemSchema = z.object({
  query: WorkflowV2RequiredTextSchema,
  uncertainty: WorkflowV2RequiredTextSchema,
  intendedSourceType: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2QueryPlanItemSchema = z.object({
  query: WorkflowV2RequiredTextSchema,
  intent: WorkflowV2QueryIntentSchema,
  uncertainty: WorkflowV2RequiredTextSchema,
  intendedSourceType: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2QueryPlanOutputSchema = z.object({
  queries: z.array(z.union([LegacyWorkflowV2QueryPlanItemSchema, WorkflowV2QueryPlanItemSchema])),
}).strict();

const LegacyWorkflowV2FactorSchema = FactorSchema.omit({ harvestMode: true }).extend({
  subject: WorkflowV2RequiredTextSchema, behavior: WorkflowV2RequiredTextSchema,
  quote: WorkflowV2RequiredTextSchema, sourceId: WorkflowV2RequiredTextSchema,
  uncertainty: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2FactorSchema = FactorSchema.omit({ harvestMode: true }).extend({
  subject: WorkflowV2RequiredTextSchema,
  behavior: WorkflowV2RequiredTextSchema,
  quote: WorkflowV2RequiredTextSchema,
  sourceId: WorkflowV2RequiredTextSchema,
  uncertainty: WorkflowV2RequiredTextSchema,
  sourceRole: EvidenceSourceRoleSchema,
  audienceFit: EvidenceAudienceFitSchema,
  independentSourceKey: WorkflowV2RequiredTextSchema.nullable(),
  supportsDemand: z.boolean(),
  demandEvidenceUncertainty: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2FactorHarvestOutputSchema = z.object({
  factors: z.array(z.union([LegacyWorkflowV2FactorSchema, WorkflowV2FactorSchema])),
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
  intendedBuyerEvidenceFactorIds: z.array(WorkflowV2RequiredTextSchema),
  evidenceGap: WorkflowV2RequiredTextSchema.nullable(),
}).strict();

const LegacyWorkflowV2ProblemCandidateSchema = WorkflowV2ProblemCandidateSchema.omit({
  intendedBuyerEvidenceFactorIds: true, evidenceGap: true,
});

export const WorkflowV2ProblemCandidatesOutputSchema = z.object({
  problems: z.array(z.union([LegacyWorkflowV2ProblemCandidateSchema, WorkflowV2ProblemCandidateSchema])),
}).strict();

const LegacyWorkflowV2ProblemKillOutputSchema = ProblemSchema.pick({
  verdict: true, verdictReason: true, verdictSourceIds: true,
}).extend({
  verdict: ProblemVerdictSchema.exclude(["user-asserted"]),
  verdictReason: WorkflowV2RequiredTextSchema,
  verdictSourceIds: z.array(WorkflowV2RequiredTextSchema),
  unresolvedAssumptions: z.array(WorkflowV2RequiredTextSchema),
  wouldChangeConclusion: z.array(WorkflowV2RequiredTextSchema),
}).strict();

export const ClassifiedWorkflowV2ProblemKillOutputSchema = ProblemSchema.pick({
  verdict: true,
  verdictReason: true,
  verdictSourceIds: true,
}).extend({
  verdict: ProblemVerdictSchema.exclude(["user-asserted"]),
  verdictReason: WorkflowV2RequiredTextSchema,
  verdictSourceIds: z.array(WorkflowV2RequiredTextSchema),
  unresolvedAssumptions: z.array(WorkflowV2RequiredTextSchema),
  wouldChangeConclusion: z.array(WorkflowV2RequiredTextSchema),
  intendedBuyerEvidenceFactorIds: z.array(WorkflowV2RequiredTextSchema),
  evidenceGap: WorkflowV2RequiredTextSchema.nullable(),
}).strict();

export const ExplicitWorkflowV2ProblemKillOutputSchema = ClassifiedWorkflowV2ProblemKillOutputSchema.extend({
  briefFit: ProblemBriefFitSchema,
  contraryEvidence: ProblemContraryEvidenceSchema,
  workflowKey: ProblemWorkflowKeySchema,
}).strict();

export const WorkflowV2ProblemKillOutputSchema = z.union([
  LegacyWorkflowV2ProblemKillOutputSchema,
  ClassifiedWorkflowV2ProblemKillOutputSchema,
  ExplicitWorkflowV2ProblemKillOutputSchema,
]);

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

export const WorkflowV2StartupSolutionOptionSchema = WorkflowV2SolutionOptionSchema.extend({
  startupOpportunity: StartupOpportunityDetailsSchema,
}).strict();

export const WorkflowV2SolutionsOutputSchema = z.object({
  options: z.array(z.union([WorkflowV2StartupSolutionOptionSchema, WorkflowV2SolutionOptionSchema])),
}).strict();

export const WorkflowV2SolutionSetReviewOutputSchema = z.object({
  assessments: z.array(z.object({
    candidateId: WorkflowV2RequiredTextSchema,
    decision: z.enum(["distinct", "duplicate", "variant", "insufficient-evidence", "rejected"]),
    reason: WorkflowV2RequiredTextSchema,
    matchingSolutionId: WorkflowV2RequiredTextSchema.nullable(),
    citedEvidenceIds: z.array(WorkflowV2RequiredTextSchema),
  }).strict()),
}).strict();

export const WorkflowV2IdeaFollowUpOutputSchema = z.object({
  reply: WorkflowV2RequiredTextSchema,
  citedEvidenceIds: z.array(WorkflowV2RequiredTextSchema),
  assumptions: z.array(WorkflowV2RequiredTextSchema),
  changeSummary: WorkflowV2RequiredTextSchema.nullable(),
  candidate: z.union([WorkflowV2StartupSolutionOptionSchema, WorkflowV2SolutionOptionSchema]).nullable(),
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

export const WorkflowV2RiskEvaluationOutputSchema = z.object({
  risks: z.array(WorkflowV2DecisionRiskSchema),
  unknowns: z.array(WorkflowV2RequiredTextSchema),
}).strict();

export type WorkflowV2RiskEvaluation = z.infer<typeof WorkflowV2RiskEvaluationOutputSchema>;

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
  inconclusiveCriterion: WorkflowV2RequiredTextSchema,
}).strict();

export const WorkflowV2DecisionAnalysisDraftSchema = z.object({
  consequences: z.array(WorkflowV2ConsequenceSchema),
  proposedResponses: z.array(WorkflowV2ProposedResponseSchema),
  additionalUnknowns: z.array(WorkflowV2RequiredTextSchema),
  experiment: WorkflowV2ExperimentSchema.required(),
}).strict();

export const WorkflowV2DecisionAnalysisOutputSchema = z.object({
  consequences: z.array(WorkflowV2ConsequenceSchema),
  risks: z.array(WorkflowV2DecisionRiskSchema),
  proposedResponses: z.array(WorkflowV2ProposedResponseSchema),
  unknowns: z.array(WorkflowV2RequiredTextSchema),
  experiment: WorkflowV2ExperimentSchema,
}).strict();

const WorkflowV2LegacyDecisionAnalysisOutputSchema = WorkflowV2DecisionAnalysisOutputSchema.extend({
  experiment: WorkflowV2ExperimentSchema.omit({ inconclusiveCriterion: true }),
});

export const WorkflowV2CompatibleDecisionAnalysisOutputSchema = z.union([
  WorkflowV2DecisionAnalysisOutputSchema,
  WorkflowV2LegacyDecisionAnalysisOutputSchema.transform((analysis) => ({
    ...analysis,
    experiment: {
      ...analysis.experiment,
      inconclusiveCriterion: "The observations do not meet either the pass or fail criterion.",
    },
  })),
]);

export const WorkflowV2RiskReassessmentOutputSchema = z.object({
  affectedRisks: z.array(z.object({
    riskId: WorkflowV2RequiredTextSchema,
    effect: z.enum(["strengthened", "weakened"]),
    rationale: WorkflowV2RequiredTextSchema,
  }).strict()),
  newRisks: z.array(WorkflowV2DecisionRiskSchema),
  additionalUnknowns: z.array(WorkflowV2RequiredTextSchema),
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
  workflowV2SolutionSetReview: WorkflowV2SolutionSetReviewOutputSchema,
  workflowV2IdeaFollowUp: WorkflowV2IdeaFollowUpOutputSchema,
  workflowV2DecisionAnalysis: WorkflowV2DecisionAnalysisOutputSchema,
} as const satisfies Record<string, z.ZodType<unknown>>;

export type Scope = z.infer<typeof ScopeSchema>;
export type Factor = z.infer<typeof FactorSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type Solution = z.infer<typeof SolutionSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type ProposedMitigation = z.infer<typeof ProposedMitigationSchema>;
export type StartupOpportunityDetails = z.infer<typeof StartupOpportunityDetailsSchema>;
export type WorkflowV2SolutionOption = z.infer<typeof WorkflowV2SolutionOptionSchema> & {
  startupOpportunity?: StartupOpportunityDetails;
};
export type WorkflowV2IdeaFollowUp = z.infer<typeof WorkflowV2IdeaFollowUpOutputSchema>;
export type WorkflowV2DecisionAnalysis = z.infer<typeof WorkflowV2DecisionAnalysisOutputSchema>;
export type WorkflowV2DecisionAnalysisDraft = z.infer<typeof WorkflowV2DecisionAnalysisDraftSchema>;
export type WorkflowV2RiskReassessment = z.infer<typeof WorkflowV2RiskReassessmentOutputSchema>;
