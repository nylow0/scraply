import type { z } from "zod";
import {
  WorkflowV2DecisionAnalysisOutputSchema,
  WorkflowV2FactorHarvestOutputSchema,
  WorkflowV2ProblemCandidatesOutputSchema,
  WorkflowV2ProblemKillOutputSchema,
  WorkflowV2QueryPlanOutputSchema,
  WorkflowV2SolutionsOutputSchema,
} from "../shared/structured-output-schemas";

export const WORKFLOW_VERSION_V2 = 2 as const;

export const WORKFLOW_V2_STAGE_IDS = [
  "query-plan",
  "factor-harvest",
  "problem-candidates",
  "problem-kill",
  "solutions",
  "decision-analysis",
] as const;

export type WorkflowV2StageId = typeof WORKFLOW_V2_STAGE_IDS[number];

export interface WorkflowV2StageDefinition {
  id: WorkflowV2StageId;
  promptFilename: `workflow-v2-${WorkflowV2StageId}.md`;
  promptRevision: 1;
  schemaRevision: 1;
  schema: z.ZodTypeAny;
  maxOutputTokens: number;
  deadlineMs: number;
}

export const WORKFLOW_V2_STAGE_REGISTRY = {
  "query-plan": {
    id: "query-plan",
    promptFilename: "workflow-v2-query-plan.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2QueryPlanOutputSchema,
    maxOutputTokens: 2_048,
    deadlineMs: 60_000,
  },
  "factor-harvest": {
    id: "factor-harvest",
    promptFilename: "workflow-v2-factor-harvest.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2FactorHarvestOutputSchema,
    maxOutputTokens: 4_096,
    deadlineMs: 120_000,
  },
  "problem-candidates": {
    id: "problem-candidates",
    promptFilename: "workflow-v2-problem-candidates.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2ProblemCandidatesOutputSchema,
    maxOutputTokens: 4_096,
    deadlineMs: 120_000,
  },
  "problem-kill": {
    id: "problem-kill",
    promptFilename: "workflow-v2-problem-kill.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2ProblemKillOutputSchema,
    maxOutputTokens: 2_048,
    deadlineMs: 120_000,
  },
  solutions: {
    id: "solutions",
    promptFilename: "workflow-v2-solutions.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2SolutionsOutputSchema,
    maxOutputTokens: 4_096,
    deadlineMs: 120_000,
  },
  "decision-analysis": {
    id: "decision-analysis",
    promptFilename: "workflow-v2-decision-analysis.md",
    promptRevision: 1,
    schemaRevision: 1,
    schema: WorkflowV2DecisionAnalysisOutputSchema,
    maxOutputTokens: 6_144,
    deadlineMs: 120_000,
  },
} as const satisfies Record<WorkflowV2StageId, WorkflowV2StageDefinition>;

export function getWorkflowV2Stage<TStageId extends WorkflowV2StageId>(stageId: TStageId) {
  return WORKFLOW_V2_STAGE_REGISTRY[stageId];
}

export function parseWorkflowV2StageOutput(
  stageId: WorkflowV2StageId,
  schemaRevision: number,
  value: unknown,
): unknown {
  if (schemaRevision !== 1) {
    throw new Error(`Unsupported ${stageId} schema revision: ${schemaRevision}`);
  }
  // Keep this revision switch when adding schemas. Saved checkpoints must keep using the schema
  // version that created them instead of the currently bundled stage definition.
  return WORKFLOW_V2_STAGE_REGISTRY[stageId].schema.parse(value);
}
