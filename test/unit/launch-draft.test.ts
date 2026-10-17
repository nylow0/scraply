import { expect, test } from "bun:test";
import { buildWorkflowLaunchDraft, launchDraftEstimates } from "../../src/shared/launch-draft";
import { DEFAULT_RUN_CONFIG, RunConfigSchema, type RunConfig } from "../../src/shared/schemas";
import { WorkflowLaunchDraftSchema, type WorkflowLaunchDraft } from "../../src/shared/workflow-contracts";

const scope = {
  title: "  Repair shops  ", audience: "  Shop operators ", domain: " Parts sourcing ",
  observations: " Keep communication history ", riskEvaluationCriteria: " Low setup effort ",
  offLimits: [" No hardware \n", "", "  \n No migration "],
};
const ideas = { model: { providerId: "openai-subscription", modelId: "gpt-6-astra" }, reasoningEffort: "high" };

test("matches the original form's complete serialized Vibe draft", () => {
  const draft = buildWorkflowLaunchDraft(scope, { ...DEFAULT_RUN_CONFIG, ideaCount: 5, knownProblem: " Keep this context " }, {
    mode: "vibe", ideas, automaticProblemCap: 2,
    limits: { maxModelCalls: 123, maxSearches: 4 },
    instructions: { research: " Research context ", ideas: " Generate carefully ", review: " Check evidence " },
  });
  // This literal records the pre-extraction form's field order, defaults, and normalization.
  const expected: WorkflowLaunchDraft = {
    contractVersion: 1, frameWorkflowVersion: 1, purpose: "discovery",
    mode: "vibe", brief: "Parts sourcing",
    scope: {
      title: "Repair shops", audience: "Shop operators", domain: "Parts sourcing",
      observations: "Keep communication history", riskEvaluationCriteria: "Low setup effort", offLimits: ["No hardware", "No migration"],
    },
    runConfig: {
      configVersion: 2, workflowVersion: 2, ideaCount: 5,
      model: { providerId: "openai-subscription", modelId: "gpt-6.1-sol" }, reasoningEffort: "medium", discoveryDepth: "standard",
      searchProvider: "exa", maxRunMinutes: 90, researchMode: "explore-market", knownProblem: "Keep this context", explorationPurpose: "auto",
    },
    ideas: { model: ideas.model, reasoningEffort: "high", reviewModel: ideas.model, reviewReasoningEffort: "high" },
    targets: { kind: "per-problem", ideaCount: 5, automaticProblemCap: 2 },
    limits: { enforced: false, maxMinutes: 90, maxModelCalls: 123, maxSearches: 4 },
    instructions: { research: "Research context", ideas: "Generate carefully", review: "Check evidence" },
  };
  expect(JSON.stringify(draft)).toBe(JSON.stringify(expected));
  expect(WorkflowLaunchDraftSchema.safeParse(draft).success).toBe(true);
});

test.each([
  ["explore-market", "vibe", true], ["explore-market", "babysit", false],
  ["known-problem", "vibe", false], ["known-problem", "babysit", false],
] as const)("preserves the %s / %s target and model rules", (researchMode, mode, hasCap) => {
  const draft = buildWorkflowLaunchDraft(scope, { ...DEFAULT_RUN_CONFIG, researchMode, knownProblem: " Approvals take too long " }, {
    ...(mode === "vibe" ? { mode, ideas } : { mode }), automaticProblemCap: 2,
  });
  expect(draft.purpose).toBe(researchMode === "known-problem" ? "known-problem" : "discovery");
  expect(draft.brief).toBe(researchMode === "known-problem" ? "Approvals take too long" : "Parts sourcing");
  expect(draft.scope.domain).toBe("Parts sourcing");
  expect(draft.targets).toEqual({ kind: "per-problem", ideaCount: 3, ...(hasCap ? { automaticProblemCap: 2 } : {}) });
  expect(draft.ideas).toEqual(mode === "vibe"
    ? { model: ideas.model, reasoningEffort: "high", reviewModel: ideas.model, reviewReasoningEffort: "high" } : undefined);
  expect(draft.limits).toEqual({ enforced: false, maxMinutes: 90,
    maxModelCalls: researchMode === "known-problem" ? 14 : 470, maxSearches: researchMode === "known-problem" ? 0 : 407 });
  expect(draft.instructions).toEqual({ research: "", ideas: "", review: "" });
});

test.each([
  ["quick", 1, 158, 68], ["quick", 2, 158, 128], ["quick", 3, 158, 188],
  ["standard", 1, 470, 167], ["standard", 2, 470, 287], ["standard", 3, 470, 407],
  ["deep", 1, 1214, 382], ["deep", 2, 1214, 590], ["deep", 3, 1214, 798],
] as const)("derives the form's %s depth estimates with %s languages", (depth, languageCount, maxModelCalls, maxSearches) => {
  expect(launchDraftEstimates("explore-market", depth, languageCount)).toEqual({ maxModelCalls, maxSearches });
  const draft = buildWorkflowLaunchDraft(scope, { ...DEFAULT_RUN_CONFIG, discoveryDepth: depth }, { mode: "babysit", languageCount });
  expect(draft.limits).toEqual({ enforced: false, maxMinutes: 90, maxModelCalls, maxSearches });
  expect(launchDraftEstimates("known-problem", depth, languageCount)).toEqual({ maxModelCalls: 14, maxSearches: 0 });
});

test("uses three languages by default, preserves projection clamping, and respects explicit zero searches", () => {
  expect(launchDraftEstimates("explore-market", "quick")).toEqual({ maxModelCalls: 158, maxSearches: 188 });
  expect(launchDraftEstimates("explore-market", "quick", 0)).toEqual({ maxModelCalls: 158, maxSearches: 68 });
  expect(launchDraftEstimates("explore-market", "quick", 8)).toEqual({ maxModelCalls: 158, maxSearches: 188 });
  const draft = buildWorkflowLaunchDraft(scope, { ...DEFAULT_RUN_CONFIG, maxRunMinutes: 30 }, {
    mode: "vibe", ideas, automaticProblemCap: null, languageCount: 1, limits: { maxSearches: 0 },
  });
  expect(draft.limits).toEqual({ enforced: false, maxMinutes: 30, maxModelCalls: 470, maxSearches: 0 });
  expect(draft.targets.automaticProblemCap).toBeUndefined();
});

test("keeps older saved defaults and historical models without carrying retired settings into a new run", () => {
  const config = RunConfigSchema.parse({
    model: "retired-worker-model", reasoningEffort: "retired-effort", discoveryDepth: "quick", maxRunMinutes: 30,
    audienceSourcePolicy: "communities", workflowVersion: 1,
  });
  const draft = buildWorkflowLaunchDraft({ ...scope, title: " ", riskEvaluationCriteria: undefined }, config, { mode: "babysit" });
  expect(draft.scope).toMatchObject({ title: "Parts sourcing", riskEvaluationCriteria: "" });
  expect(draft.runConfig).toEqual({
    configVersion: 2, workflowVersion: 2, ideaCount: 3,
    model: { providerId: "legacy-codex-cli", modelId: "retired-worker-model" }, reasoningEffort: "retired-effort",
    discoveryDepth: "quick", searchProvider: "exa", maxRunMinutes: 30,
    researchMode: "explore-market", knownProblem: "", explorationPurpose: "general-solutions",
  });
  expect(draft).not.toHaveProperty("ideaWorkflowVersion");
  expect(config.workflowVersion).toBe(1);
  expect(config.audienceSourcePolicy).toBe("communities");
});

test("keeps the saved purpose while new targets always use ideas per problem", () => {
  const config = { ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities" as const,
    opportunityExploration: { targetFamilies: 8, batchSize: 4, maxExpansionRounds: 2, maxRawCandidates: 16,
      maxModelCalls: 10, maxSearches: 6, allowExploratoryProblems: false } };
  const draft = buildWorkflowLaunchDraft(scope, config, { mode: "vibe", ideas });
  expect(draft.runConfig.explorationPurpose).toBe("startup-opportunities");
  expect(draft.runConfig).not.toHaveProperty("opportunityExploration");
  expect(draft.targets).toEqual({ kind: "per-problem", ideaCount: 3 });
  expect(config.opportunityExploration.targetFamilies).toBe(8);
  const olderConfig: RunConfig = { ...DEFAULT_RUN_CONFIG };
  delete olderConfig.explorationPurpose;
  expect(buildWorkflowLaunchDraft(scope, olderConfig, { mode: "babysit" }).runConfig.explorationPurpose).toBe("auto");
});

test("keeps explicit unavailable ideas choices and truncates a blank title from the active brief", () => {
  const knownProblem = `  ${"A long synthetic problem ".repeat(5)}  `;
  const unavailable = { model: { providerId: "openai-subscription", modelId: "retired-ideas-model" }, reasoningEffort: "retired-effort" };
  const draft = buildWorkflowLaunchDraft({ ...scope, title: " " }, { ...DEFAULT_RUN_CONFIG, researchMode: "known-problem", knownProblem }, {
    mode: "vibe", ideas: unavailable,
  });
  expect(draft.brief).toBe(knownProblem.trim());
  expect(draft.scope.title).toBe(knownProblem.trim().slice(0, 80));
  expect(draft.ideas).toEqual({ ...unavailable, reviewModel: unavailable.model, reviewReasoningEffort: unavailable.reasoningEffort });
  expect(scope.title).toBe("  Repair shops  ");
});

test("serializes model refs in the form's order regardless of saved object key order", () => {
  const model = { modelId: "retired-model", providerId: "openai-subscription" };
  const draft = buildWorkflowLaunchDraft(scope, { ...DEFAULT_RUN_CONFIG, model }, {
    mode: "vibe", ideas: { model, reasoningEffort: "high" },
  });
  const expected = '{"providerId":"openai-subscription","modelId":"retired-model"}';
  expect(JSON.stringify(draft.runConfig.model)).toBe(expected);
  expect(JSON.stringify(draft.ideas?.model)).toBe(expected);
  expect(JSON.stringify(draft.ideas?.reviewModel)).toBe(expected);
});
