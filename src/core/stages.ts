import type { ZodType } from "zod";
import {
  WorkflowV2DecisionAnalysisOutputSchema,
  WorkflowV2CompatibleDecisionAnalysisOutputSchema,
  WorkflowV2FactorHarvestOutputSchema,
  WorkflowV2ProblemCandidatesOutputSchema,
  WorkflowV2ProblemKillOutputSchema,
  ExplicitWorkflowV2ProblemKillOutputSchema,
  WorkflowV2QueryPlanOutputSchema,
  WorkflowV2RiskEvaluationOutputSchema,
  WorkflowV2SolutionsOutputSchema,
  WorkflowV2SolutionSetReviewOutputSchema,
  WorkflowV2IdeaFollowUpOutputSchema,
  type WorkflowV2DecisionAnalysis,
  type WorkflowV2SolutionOption,
} from "../shared/structured-output-schemas";
import { MAX_IDEA_COUNT } from "../shared/schemas";
import { FrameSearchPlanSchema, ResearchFrameOutputSchema, ResearchAreaRankingSchema } from "../shared/research-frame";

export const WORKFLOW_VERSION_V2 = 2 as const;

export const WORKFLOW_V2_STAGE_IDS = [
  "frame-search-plan",
  "frame",
  "area-ranking",
  "query-plan",
  "factor-harvest",
  "problem-candidates",
  "problem-kill",
  "solutions",
  "solution-set-review",
  "idea-follow-up",
  "risk-evaluation",
  "decision-analysis",
] as const;

export type WorkflowV2StageId = typeof WORKFLOW_V2_STAGE_IDS[number];

export interface WorkflowV2StageDefinition {
  id: WorkflowV2StageId;
  promptFilename: `workflow-v2-${WorkflowV2StageId}.md` | "workflow-v2-frame-search.md";
  promptRevision: 1;
  schemaRevision: 1;
  schema: ZodType<unknown>;
  maxOutputTokens: number;
}

export const WORKFLOW_V2_STAGE_REGISTRY = {
  "frame-search-plan": {
    id: "frame-search-plan", promptFilename: "workflow-v2-frame-search.md",
    promptRevision: 1, schemaRevision: 1, schema: FrameSearchPlanSchema, maxOutputTokens: 2_048,
  },
  frame: {
    id: "frame", promptFilename: "workflow-v2-frame.md",
    promptRevision: 1, schemaRevision: 1, schema: ResearchFrameOutputSchema, maxOutputTokens: 8_192,
  },
  "area-ranking": {
    id: "area-ranking", promptFilename: "workflow-v2-area-ranking.md",
    promptRevision: 1, schemaRevision: 1, schema: ResearchAreaRankingSchema, maxOutputTokens: 4_096,
  },
  "query-plan": {
    id: "query-plan",
    promptFilename: "workflow-v2-query-plan.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2QueryPlanOutputSchema,
    maxOutputTokens: 2_048,
  },
  "factor-harvest": {
    id: "factor-harvest",
    promptFilename: "workflow-v2-factor-harvest.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2FactorHarvestOutputSchema,
    maxOutputTokens: 4_096,
  },
  "problem-candidates": {
    id: "problem-candidates",
    promptFilename: "workflow-v2-problem-candidates.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2ProblemCandidatesOutputSchema,
    maxOutputTokens: 4_096,
  },
  "problem-kill": {
    id: "problem-kill",
    promptFilename: "workflow-v2-problem-kill.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: ExplicitWorkflowV2ProblemKillOutputSchema,
    maxOutputTokens: 2_048,
  },
  solutions: {
    id: "solutions",
    promptFilename: "workflow-v2-solutions.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2SolutionsOutputSchema,
    maxOutputTokens: 4_096,
  },
  "solution-set-review": {
    id: "solution-set-review",
    promptFilename: "workflow-v2-solution-set-review.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2SolutionSetReviewOutputSchema,
    maxOutputTokens: 4_096,
  },
  "idea-follow-up": {
    id: "idea-follow-up",
    promptFilename: "workflow-v2-idea-follow-up.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2IdeaFollowUpOutputSchema,
    maxOutputTokens: 4_096,
  },
  "decision-analysis": {
    id: "decision-analysis",
    promptFilename: "workflow-v2-decision-analysis.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2DecisionAnalysisOutputSchema,
    maxOutputTokens: 6_144,
  },
  "risk-evaluation": {
    id: "risk-evaluation",
    promptFilename: "workflow-v2-risk-evaluation.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2RiskEvaluationOutputSchema,
    maxOutputTokens: 4_096,
  },
} as const satisfies Record<WorkflowV2StageId, WorkflowV2StageDefinition>;

export function getWorkflowV2Stage<TStageId extends WorkflowV2StageId>(stageId: TStageId) {
  return WORKFLOW_V2_STAGE_REGISTRY[stageId];
}

export function parseWorkflowV2StageOutput(
  stageId: WorkflowV2StageId,
  schemaRevision: number,
  value: unknown,
  evidence: readonly WorkflowV2CategorizedEvidence[] = [],
): unknown {
  if (schemaRevision !== 1) {
    throw new Error(`Unsupported ${stageId} schema revision: ${schemaRevision}`);
  }
  // Keep this revision switch when adding schemas. Saved checkpoints must keep using the schema
  // version that created them instead of the currently bundled stage definition.
  const output = stageId === "decision-analysis"
    ? WorkflowV2CompatibleDecisionAnalysisOutputSchema.parse(value)
    : stageId === "problem-kill"
      ? WorkflowV2ProblemKillOutputSchema.parse(value)
    : WORKFLOW_V2_STAGE_REGISTRY[stageId].schema.parse(value);
  assertWorkflowV2StageOutputSemantics(stageId, output, evidence);
  return output;
}

export interface WorkflowV2CategorizedEvidence {
  sourceId: string;
  content: unknown;
}

export function assertWorkflowV2SolutionsSemantics(
  output: { options: WorkflowV2SolutionOption[] },
  evidence: readonly WorkflowV2CategorizedEvidence[] = [],
  ideaCount = MAX_IDEA_COUNT,
): void {
  if (output.options.length > ideaCount) {
    throw new Error(`The solutions stage returned more than ${ideaCount} options`);
  }
  const categories = evidenceCategories(evidence);
  // Discovery roles describe the problem, while a gap search is an unclassified lead.
  // All saved sources may be cited if an option explains their actual relevance.
  const suppliedIds = new Set([...categories.supporting, ...categories.contrary, ...categories.gapSearch]);
  for (const option of output.options) {
    const gapEvidenceIds = option.startupOpportunity?.gapAssessment.evidenceIds ?? [];
    if ([...option.supportingEvidenceIds, ...option.contraryEvidenceIds, ...gapEvidenceIds].some((id) => !suppliedIds.has(id))) {
      throw new Error("A v2 solution option referenced an unknown evidence source ID");
    }
    const gap = option.startupOpportunity?.gapAssessment;
    if (gap?.kind === "evidenced" && gap.evidenceIds.length === 0) {
      throw new Error("An evidenced startup gap must cite at least one supplied evidence source");
    }
  }
}

export function assertWorkflowV2DecisionAnalysisSemantics(
  analysis: WorkflowV2DecisionAnalysis,
): void {
  const riskIds = new Set<string>();
  for (const risk of analysis.risks) {
    if (riskIds.has(risk.riskId)) {
      throw new Error(`Duplicate decision risk ID: ${risk.riskId}`);
    }
    riskIds.add(risk.riskId);
  }
  for (const response of analysis.proposedResponses) {
    if (response.riskIds.length === 0 || response.riskIds.some((riskId) => !riskIds.has(riskId))) {
      throw new Error("A proposed response linked an empty or unknown risk set");
    }
  }
}

function assertWorkflowV2StageOutputSemantics(
  stageId: WorkflowV2StageId,
  output: unknown,
  evidence: readonly WorkflowV2CategorizedEvidence[],
): void {
  if (stageId === "solutions") {
    assertWorkflowV2SolutionsSemantics(
      output as { options: WorkflowV2SolutionOption[] },
      evidence,
    );
  } else if (stageId === "decision-analysis") {
    assertWorkflowV2DecisionAnalysisSemantics(output as WorkflowV2DecisionAnalysis);
  }
}

function evidenceCategories(evidence: readonly WorkflowV2CategorizedEvidence[]) {
  const supporting = new Set<string>();
  const contrary = new Set<string>();
  const gapSearch = new Set<string>();
  for (const item of evidence) {
    if (!item.content || typeof item.content !== "object" || Array.isArray(item.content)) continue;
    const categories = (item.content as Record<string, unknown>).categories;
    if (!Array.isArray(categories)) continue;
    if (categories.includes("supporting")) supporting.add(item.sourceId);
    if (categories.includes("contrary")) contrary.add(item.sourceId);
    if (categories.includes("gap-search")) gapSearch.add(item.sourceId);
  }
  return { supporting, contrary, gapSearch };
}
