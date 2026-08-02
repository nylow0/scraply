import { z } from "zod";
import { DEFAULT_RUN_CONFIG } from "./intake";
import { RunConfigSchema, type RunConfig } from "./schemas";

const LegacyRunConfigSchema = RunConfigSchema.extend({
  orchestratorProvider: z.enum(["opencode", "codex"]),
  workerProvider: z.enum(["opencode", "codex"]).default("codex"),
  ideaProvider: z.enum(["opencode", "codex"]),
});

export function parseAndNormalizeRunConfig(value: unknown): RunConfig {
  const current = RunConfigSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = LegacyRunConfigSchema.parse(value);
  return RunConfigSchema.parse({
    ...legacy,
    orchestratorProvider: "codex",
    orchestratorModel: legacy.orchestratorProvider === "opencode"
      ? DEFAULT_RUN_CONFIG.orchestratorModel
      : legacy.orchestratorModel,
    workerProvider: "codex",
    workerModel: legacy.workerProvider === "opencode"
      ? DEFAULT_RUN_CONFIG.workerModel
      : legacy.workerModel,
    ideaProvider: "codex",
    ideaModel: legacy.ideaProvider === "opencode"
      ? DEFAULT_RUN_CONFIG.ideaModel
      : legacy.ideaModel,
  });
}
