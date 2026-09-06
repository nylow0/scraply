import { describe, expect, test } from "bun:test";
import { isResearchModeReady, isSetupComplete } from "../../src/backend/server";
import { RunConfigSchema } from "../../src/shared/schemas";

const nativeReady = { available: true, connected: true };
const nativeUnavailable = { available: false, connected: false };
const nativeModel = { providerId: "openai-subscription", modelId: "gpt-test" };

describe("provider setup requirements", () => {
  test("backfills saved configs from before provider selection to Exa", () => {
    expect(RunConfigSchema.parse({
      model: "gpt-test",
      reasoningEffort: "medium",
      discoveryDepth: "standard",
      maxRunMinutes: 90,
    }).searchProvider).toBe("exa");
  });

  test("accepts Exa with a connected native account", () => {
    expect(isSetupComplete({ exa: { valid: true }, perplexity: { valid: false } }, nativeReady)).toBe(true);
  });

  test("accepts Perplexity without Exa", () => {
    expect(isSetupComplete({ exa: { valid: false }, perplexity: { valid: true } }, nativeReady)).toBe(true);
  });

  test("never completes setup without any search provider", () => {
    expect(isSetupComplete({ exa: { valid: false }, perplexity: { valid: false } }, nativeReady)).toBe(false);
  });

  test("requires a connected native account", () => {
    expect(isSetupComplete({ exa: { valid: true }, perplexity: { valid: false } }, nativeUnavailable)).toBe(false);
  });

  test("known-problem mode requires Native OpenAI but not search", () => {
    const search = { exa: { valid: false }, perplexity: { valid: false } };
    expect(isResearchModeReady({ researchMode: "known-problem", searchProvider: "perplexity", model: nativeModel }, search, nativeReady)).toBe(true);
    expect(isResearchModeReady({ researchMode: "known-problem", searchProvider: "exa", model: nativeModel }, search, nativeUnavailable)).toBe(false);
    expect(isResearchModeReady({ researchMode: "known-problem", searchProvider: "exa", model: { providerId: "legacy-codex-cli", modelId: "gpt-test" } }, search, nativeReady)).toBe(false);
  });

  test("explore-market mode requires the selected search provider", () => {
    const search = { exa: { valid: true }, perplexity: { valid: false } };
    expect(isResearchModeReady({ researchMode: "explore-market", searchProvider: "perplexity", model: nativeModel }, search, nativeReady)).toBe(false);
    expect(isResearchModeReady({ researchMode: "explore-market", searchProvider: "exa", model: nativeModel }, search, nativeReady)).toBe(true);
  });
});
