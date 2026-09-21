import { describe, expect, test } from "bun:test";
import { DEFAULT_RUN_CONFIG, RunConfigSchema } from "../../src/shared/schemas";
import { DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG } from "../../src/shared/opportunity-exploration";

describe("run configuration compatibility", () => {
  test("keeps existing projects out of target exploration unless explicitly selected", () => {
    expect(RunConfigSchema.parse(DEFAULT_RUN_CONFIG).opportunityExploration).toBeUndefined();
    expect(RunConfigSchema.safeParse({ ...DEFAULT_RUN_CONFIG, opportunityExploration: DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG }).success).toBe(false);
    const config = RunConfigSchema.parse({ ...DEFAULT_RUN_CONFIG, explorationPurpose: "startup-opportunities", opportunityExploration: DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG });
    expect(config.opportunityExploration?.targetFamilies).toBe(30);
    expect(config.ideaCount).toBe(DEFAULT_RUN_CONFIG.ideaCount);
  });
  test("normalizes legacy configurations for historical attribution", () => {
    expect(RunConfigSchema.parse({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      discoveryDepth: "standard",
      maxRunMinutes: 90,
    })).toEqual({
      configVersion: 2,
      model: { providerId: "legacy-codex-cli", modelId: "gpt-5.6-luna" },
      reasoningEffort: "medium",
      discoveryDepth: "standard",
      maxRunMinutes: 90,
      searchProvider: "exa",
      explorationPurpose: "general-solutions",
      researchMode: "explore-market",
      knownProblem: "",
    });
  });
});
