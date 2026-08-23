import { describe, expect, test } from "bun:test";
import { isResearchModeReady, isSetupComplete } from "../../src/backend/server";

const codexReady = { detected: true, compatible: true, authenticated: true };
const codexUnavailable = { detected: false, compatible: false, authenticated: false };

describe("provider setup requirements", () => {
  test("accepts Exa with compatible Codex", () => {
    expect(isSetupComplete({ valid: true }, codexReady)).toBe(true);
  });

  test("never completes setup without Exa research access", () => {
    expect(isSetupComplete({ valid: false }, codexReady)).toBe(false);
  });

  test("requires a usable Codex installation", () => {
    expect(isSetupComplete({ valid: true }, codexUnavailable)).toBe(false);
  });

  test("requires Codex authentication separately from compatibility", () => {
    expect(isSetupComplete({ valid: true }, { detected: true, compatible: true, authenticated: false })).toBe(false);
  });

  test("known-problem mode requires Codex but not Exa", () => {
    expect(isResearchModeReady("known-problem", { valid: false }, codexReady)).toBe(true);
    expect(isResearchModeReady("known-problem", { valid: true }, codexUnavailable)).toBe(false);
  });

  test("explore-market mode requires both providers", () => {
    expect(isResearchModeReady("explore-market", { valid: false }, codexReady)).toBe(false);
    expect(isResearchModeReady("explore-market", { valid: true }, codexReady)).toBe(true);
  });
});
