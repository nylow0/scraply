import { describe, expect, test } from "bun:test";
import { isSetupComplete } from "../../src/backend/server";

const codexReady = { detected: true, compatible: true };
const codexUnavailable = { detected: false, compatible: false };

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
});
