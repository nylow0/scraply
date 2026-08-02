import { describe, expect, test } from "bun:test";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { parseAndNormalizeRunConfig } from "../../src/shared/run-config-normalizer";

describe("run configuration compatibility", () => {
  test("maps persisted OpenCode selections to usable Codex defaults", () => {
    const normalized = parseAndNormalizeRunConfig({
      ...DEFAULT_RUN_CONFIG,
      orchestratorProvider: "opencode",
      orchestratorModel: "legacy-orchestrator",
      workerProvider: "opencode",
      workerModel: "legacy-worker",
      ideaProvider: "opencode",
      ideaModel: "legacy-idea",
    });

    expect(normalized).toMatchObject({
      orchestratorProvider: "codex",
      orchestratorModel: DEFAULT_RUN_CONFIG.orchestratorModel,
      workerProvider: "codex",
      workerModel: DEFAULT_RUN_CONFIG.workerModel,
      ideaProvider: "codex",
      ideaModel: DEFAULT_RUN_CONFIG.ideaModel,
    });
  });

  test("preserves current Codex selections", () => {
    expect(parseAndNormalizeRunConfig(DEFAULT_RUN_CONFIG)).toEqual(DEFAULT_RUN_CONFIG);
  });
});
