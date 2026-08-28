import { describe, expect, test } from "bun:test";
import { isResearchModeReady, isSetupComplete } from "../../src/backend/server";
import { RunConfigSchema } from "../../src/shared/schemas";

const codexReady = { detected: true, compatible: true, authenticated: true };
const codexUnavailable = { detected: false, compatible: false, authenticated: false };

describe("provider setup requirements", () => {
  test("backfills saved configs from before provider selection to Exa", () => {
    expect(RunConfigSchema.parse({
      model: "gpt-test",
      reasoningEffort: "medium",
      discoveryDepth: "standard",
      maxRunMinutes: 90,
    }).searchProvider).toBe("exa");
  });

  test("accepts Exa with compatible Codex", () => {
    expect(isSetupComplete({ exa: { valid: true }, perplexity: { valid: false } }, codexReady)).toBe(true);
  });

  test("accepts Perplexity without Exa", () => {
    expect(isSetupComplete({ exa: { valid: false }, perplexity: { valid: true } }, codexReady)).toBe(true);
  });

  test("never completes setup without any search provider", () => {
    expect(isSetupComplete({ exa: { valid: false }, perplexity: { valid: false } }, codexReady)).toBe(false);
  });

  test("requires a usable Codex installation", () => {
    expect(isSetupComplete({ exa: { valid: true }, perplexity: { valid: false } }, codexUnavailable)).toBe(false);
  });

  test("requires Codex authentication separately from compatibility", () => {
    expect(isSetupComplete({ exa: { valid: true }, perplexity: { valid: false } }, { detected: true, compatible: true, authenticated: false })).toBe(false);
  });

  test("known-problem mode requires Codex but not search", () => {
    const search = { exa: { valid: false }, perplexity: { valid: false } };
    expect(isResearchModeReady({ researchMode: "known-problem", searchProvider: "perplexity" }, search, codexReady)).toBe(true);
    expect(isResearchModeReady({ researchMode: "known-problem", searchProvider: "exa" }, search, codexUnavailable)).toBe(false);
  });

  test("explore-market mode requires the selected search provider", () => {
    const search = { exa: { valid: true }, perplexity: { valid: false } };
    expect(isResearchModeReady({ researchMode: "explore-market", searchProvider: "perplexity" }, search, codexReady)).toBe(false);
    expect(isResearchModeReady({ researchMode: "explore-market", searchProvider: "exa" }, search, codexReady)).toBe(true);
  });
});
