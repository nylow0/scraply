import { describe, expect, test } from "bun:test";
import { isSetupComplete } from "../../src/backend/server";

const codexReady = { detected: true, compatible: true };
const codexUnavailable = { detected: false, compatible: false };

describe("provider setup requirements", () => {
  test("accepts Exa with compatible Codex so OpenCode remains optional", () => {
    expect(isSetupComplete({ valid: true }, codexReady, { valid: false })).toBe(true);
  });

  test("accepts Exa with OpenCode when Codex is unavailable", () => {
    expect(isSetupComplete({ valid: true }, codexUnavailable, { valid: true })).toBe(true);
  });

  test("never completes setup without Exa research access", () => {
    expect(isSetupComplete({ valid: false }, codexReady, { valid: true })).toBe(false);
  });

  test("requires at least one usable model provider", () => {
    expect(isSetupComplete({ valid: true }, codexUnavailable, { valid: false })).toBe(false);
  });
});
