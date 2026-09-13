import { describe, expect, test } from "bun:test";
import { RunConfigSchema } from "../../src/shared/schemas";

describe("run configuration compatibility", () => {
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
      researchMode: "explore-market",
      knownProblem: "",
    });
  });
});
