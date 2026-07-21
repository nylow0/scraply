import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt } from "../../src/core/prompts";

const promptDir = join(process.cwd(), "prompts");
const testPromptPath = join(promptDir, "unit-test-prompt.md");

afterEach(() => {
  if (existsSync(testPromptPath)) rmSync(testPromptPath, { force: true });
});

describe("prompt loader", () => {
  test("loads editable prompt files from the project prompts folder", () => {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(testPromptPath, "Editable prompt from disk.\n", "utf8");

    expect(loadPrompt("unit-test-prompt", "fallback prompt")).toBe("Editable prompt from disk.");
  });

  test("falls back when a prompt file is missing", () => {
    expect(loadPrompt("missing-unit-test-prompt", "fallback prompt")).toBe("fallback prompt");
  });
});
