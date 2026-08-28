import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { z } from "zod";
import {
  quoteAppearsVerbatim,
  type Phase1AblationResult,
} from "../src/core/discovery";
import {
  developmentProjection,
  type DevelopmentResult,
} from "../src/core/development";
import type { SearchOptions } from "../src/providers/search";
import type {
  StructuredCallOptions,
  StructuredModelClient,
} from "../src/providers/structured";
import type { Source } from "../src/shared/schemas";

/**
 * Both gates must run the bundled prompts, and `configurePromptPaths` only copies a bundled prompt
 * when the override is missing, so a stale override would silently win. The path is built here
 * rather than taken as an argument because the caller cannot then aim the delete somewhere else.
 */
export async function resetPromptCache(appDataDirectory: string): Promise<string> {
  const target = join(resolve(appDataDirectory), "scraply", "scraply", "prompts");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  return target;
}

export class CountingModelClient implements StructuredModelClient {
  calls = 0;

  constructor(private readonly delegate: StructuredModelClient) {}

  async structuredCompletion<T>(
    model: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    jsonSchema: object,
    options?: StructuredCallOptions,
  ): Promise<T> {
    this.calls += 1;
    return this.delegate.structuredCompletion(model, system, user, schema, jsonSchema, options);
  }
}

export class CountingSearchClient {
  searches = 0;

  constructor(
    private readonly delegate: { search(query: string, options?: SearchOptions): Promise<Source[]> },
  ) {}

  async search(query: string, options?: SearchOptions): Promise<Source[]> {
    this.searches += 1;
    return this.delegate.search(query, options);
  }
}

export interface Phase1ObjectiveChecks {
  armAProblemCount: number;
  armCProblemCount: number;
  everyArmAProblemCitesFactor: boolean;
  everyCitedQuotePassesVerbatimCheck: boolean;
  objectiveChecksPassed: boolean;
  humanOverlapReviewRequired: true;
}

export function phase1ObjectiveChecks(result: Phase1AblationResult): Phase1ObjectiveChecks {
  const everyArmAProblemCitesFactor = result.armA.problems.length > 0
    && result.armA.problems.every((problem) => problem.factors.length > 0);
  const everyCitedQuotePassesVerbatimCheck = result.armA.problems.every((problem) =>
    problem.factors.every((factor) => quoteAppearsVerbatim(factor.source.retrievedText, factor.quote))
  );
  return {
    armAProblemCount: result.armA.problems.length,
    armCProblemCount: result.armC.problems.length,
    everyArmAProblemCitesFactor,
    everyCitedQuotePassesVerbatimCheck,
    objectiveChecksPassed: everyArmAProblemCitesFactor && everyCitedQuotePassesVerbatimCheck,
    humanOverlapReviewRequired: true,
  };
}

export interface Phase2ObjectiveChecks {
  solutionCount: number;
  expectedModelCallsWithoutRetries: number;
  actualModelCalls: number;
  inferredSchemaRetries: number;
  everySolutionHasNegativeOutcome: boolean;
  everySolutionHasJudgedOutcomes: boolean;
  everySolutionHasRisks: boolean;
  everyMitigationLinksKnownRisks: boolean;
  everySolutionHasMitigationWithFailsIf: boolean;
  ideaVerdictPhrases: string[];
  objectiveChecksPassed: boolean;
  humanReadabilityReviewRequired: true;
}

/**
 * Only the literal phrasings below are detectable; "not viable", "looks viable" and "high risk"
 * all slip through. The scan therefore reports what it found and never decides the check — REWORK
 * §11 assigns the idea-verdict judgment to the human reading the artifact.
 */
const IDEA_VERDICT_SCAN = /(?:\bidea\s+(?:is\s+)?(?:blocked|high-risk|viable)\b|(?:\*\*)?(?:verdict|status):?(?:\*\*)?:?\s*(?:blocked|high-risk|viable))/gi;

export function phase2ObjectiveChecks(
  result: DevelopmentResult,
  markdown: string,
): Phase2ObjectiveChecks {
  const expectedModelCallsWithoutRetries = developmentProjection(result.solutions.length);
  const everySolutionHasNegativeOutcome = result.solutions.length > 0
    && result.solutions.every((solution) => solution.outcomes.some((outcome) => outcome.direction === "negative"));
  const everySolutionHasJudgedOutcomes = result.solutions.every((solution) =>
    solution.outcomes.length > 0
    && solution.outcomes.every((outcome) => typeof outcome.addressesCore === "boolean")
  );
  const everySolutionHasRisks = result.solutions.every((solution) => solution.risks.length > 0);
  const everyMitigationLinksKnownRisks = result.solutions.every((solution) => {
    const knownRiskIds = new Set(solution.risks.map((risk) => risk.id));
    return solution.mitigations.every((mitigation) =>
      mitigation.riskIds.length > 0 && mitigation.riskIds.every((riskId) => knownRiskIds.has(riskId))
    );
  });
  const everySolutionHasMitigationWithFailsIf = result.solutions.every((solution) =>
    solution.mitigations.length > 0
    && solution.mitigations.every((mitigation) => mitigation.failsIf.trim().length > 0)
  );
  const inferredSchemaRetries = Math.max(0, result.modelCalls - expectedModelCallsWithoutRetries);
  const ideaVerdictPhrases = [...markdown.matchAll(IDEA_VERDICT_SCAN)].map((match) => match[0]);
  const objectiveChecksPassed = result.solutions.length > 0
    && inferredSchemaRetries === 0
    && everySolutionHasNegativeOutcome
    && everySolutionHasJudgedOutcomes
    && everySolutionHasRisks
    && everyMitigationLinksKnownRisks
    && everySolutionHasMitigationWithFailsIf;
  return {
    solutionCount: result.solutions.length,
    expectedModelCallsWithoutRetries,
    actualModelCalls: result.modelCalls,
    inferredSchemaRetries,
    everySolutionHasNegativeOutcome,
    everySolutionHasJudgedOutcomes,
    everySolutionHasRisks,
    everyMitigationLinksKnownRisks,
    everySolutionHasMitigationWithFailsIf,
    ideaVerdictPhrases,
    objectiveChecksPassed,
    humanReadabilityReviewRequired: true,
  };
}

export function renderPhase1Review(checks: Phase1ObjectiveChecks): string {
  const status = checks.objectiveChecksPassed ? "passed" : "failed";
  return [
    "# Phase 1 gate review",
    "",
    `Automated evidence checks: **${status}**.`,
    "",
    `- [${checks.everyArmAProblemCitesFactor ? "x" : " "}] Every Arm A problem cites at least one harvested factor.`,
    `- [${checks.everyCitedQuotePassesVerbatimCheck ? "x" : " "}] Every cited quote passes the same normalized-verbatim check as discovery.`,
    "- [ ] Human: at least two Arm A problems do not appear in Arm C.",
    "",
    "Read `arm-a.md` and `arm-c.md` side by side. Similarity scoring and model grading are intentionally excluded.",
    "The Phase 1 gate is not complete until the human checkbox is reviewed.",
    "",
  ].join("\n");
}

export function renderPhase2Review(checks: Phase2ObjectiveChecks): string {
  const status = checks.objectiveChecksPassed ? "passed" : "failed";
  return [
    "# Phase 2 gate review",
    "",
    `Automated evidence checks: **${status}**.`,
    "",
    `- [${checks.inferredSchemaRetries === 0 ? "x" : " "}] Produced without an inferred schema retry.`,
    `- [${checks.everySolutionHasNegativeOutcome ? "x" : " "}] Every solution has at least one negative outcome.`,
    `- [${checks.everySolutionHasJudgedOutcomes ? "x" : " "}] Every outcome has an independent addressesCore judgment.`,
    `- [${checks.everySolutionHasRisks ? "x" : " "}] Every solution has word-valued risks.`,
    `- [${checks.everySolutionHasMitigationWithFailsIf && checks.everyMitigationLinksKnownRisks ? "x" : " "}] Mitigations link known risks and include failsIf.`,
    "- [ ] Human: the artifact does not pronounce the idea blocked, high-risk, or viable.",
    "- [ ] Human: the complete risk list can be read in under one minute.",
    "",
    checks.ideaVerdictPhrases.length > 0
      ? `A literal-phrase scan flagged ${checks.ideaVerdictPhrases.length} passage(s) for that first human line: `
        + `${checks.ideaVerdictPhrases.map((phrase) => `\`${phrase}\``).join(", ")}.`
      : "A literal-phrase scan found no verdict wording, which does not settle the first human line —"
        + " it misses phrasings such as \"not viable\", \"looks viable\", or \"high risk\".",
    "",
    `Measured model calls for this problem: **${checks.actualModelCalls}** (projection before retries: ${checks.expectedModelCallsWithoutRetries}).`,
    "The Phase 2 gate is not complete until both human checkboxes are reviewed.",
    "",
  ].join("\n");
}
