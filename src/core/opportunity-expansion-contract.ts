import { z } from "zod";
import { OpportunityGoalExpansionOutputSchema, OpportunityLegacyExpansionOutputSchema, type OpportunityExpansionOutput } from "../shared/opportunity-exploration";
import type { ResearchFrame } from "../shared/research-frame";
import { GoalFitFields, assertGoalFit } from "../shared/solution-goal-fit";

export const OPPORTUNITY_GOAL_EXPANSION_INSTRUCTION = "Use the approved market-opportunity frame. Every option needs a wider problem with citable scale evidence or unknown scale, a slice within the approved constraints, exactly one citable fit per success criterion, and a measurable firstTest of kind demand-test. Preserve startupOpportunity and the focusedDemandTest. Treat missing evidence as unknown. Do not accept or rank these candidates here.";

/** The caller freezes this revision, frame, and instruction in its durable attempt before dispatch. */
export function opportunityExpansionContract(frame?: ResearchFrame) {
  if (frame && frame.goalKind !== "market-opportunity") throw new Error("This expansion creates startup families. Use ordinary idea generation for the approved goal.");
  return frame ? {
    schemaRevision: 2 as const,
    promptVersion: "opportunity-expansion-v2",
    schema: OpportunityGoalExpansionOutputSchema,
    instruction: OPPORTUNITY_GOAL_EXPANSION_INSTRUCTION,
    frame,
  } : {
    schemaRevision: 1 as const,
    promptVersion: "opportunity-expansion-v1",
    schema: OpportunityLegacyExpansionOutputSchema,
    instruction: "",
  };
}

/** Missing revision markers are older saved contracts and keep the legacy parser. */
export function parseOpportunityExpansionOutput(value: unknown, contract: {
  schemaRevision?: number;
  frame?: ResearchFrame;
  evidenceSourceIds?: readonly string[];
} = {}): OpportunityExpansionOutput {
  const revision = contract.schemaRevision ?? 1;
  if (revision === 1) return OpportunityLegacyExpansionOutputSchema.parse(value);
  if (revision !== 2 || !contract.frame) throw new Error("A goal-aware opportunity expansion needs its saved frame and schema revision");
  const prepared = opportunityExpansionContract(contract.frame);
  const output = prepared.schema.parse(value);
  for (const option of output.options) assertGoalFit(z.object(GoalFitFields).parse(option), contract.frame, contract.evidenceSourceIds ?? []);
  return output;
}
