import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths, loadPrompt } from "../../src/core/prompts";

const tempDirectories: string[] = [];

afterEach(() => {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  while (tempDirectories.length) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("prompt loader", () => {
  test("loads deliberate overrides without copying bundled prompts", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "editable.md"), "Bundled prompt.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    expect(existsSync(join(overrideDir, "editable.md"))).toBe(false);
    expect(loadPrompt("editable")).toBe("Bundled prompt.");
    writeFileSync(join(overrideDir, "editable.md"), "Editable prompt from disk.\n", "utf8");

    expect(loadPrompt("editable")).toBe("Editable prompt from disk.");
    expect(() => loadPrompt("missing")).toThrow("Required bundled prompt is missing or empty");
  });

  test("backs up an untouched managed copy and uses the upgraded bundle across relaunch", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const bundled = join(bundledDir, "factor.md");
    writeFileSync(bundled, "Bundled v1.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(join(overrideDir, "factor.md"), "Bundled v1.\n", "utf8");
    writeFileSync(bundled, "Bundled v2.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(existsSync(join(overrideDir, "factor.md"))).toBe(false);
    const hash = createHash("sha256").update("Bundled v1.\n").digest("hex");
    expect(readFileSync(join(overrideDir, "bundled-copy-backups", hash, "factor.md"), "utf8")).toBe("Bundled v1.\n");
    expect(loadPrompt("factor")).toBe("Bundled v2.");
    configurePromptPaths({ bundledDir, overrideDir });
    expect(existsSync(join(overrideDir, "factor.md"))).toBe(false);
    expect(loadPrompt("factor")).toBe("Bundled v2.");
  });

  test("preserves a user edit when the bundled prompt changes", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const bundled = join(bundledDir, "factor.md");
    const override = join(overrideDir, "factor.md");
    writeFileSync(bundled, "Bundled v1.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(override, "My custom prompt.\n", "utf8");
    writeFileSync(bundled, "Bundled v2.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(readFileSync(override, "utf8")).toBe("My custom prompt.\n");
  });

  test("conservatively preserves a divergent legacy override without version metadata", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "factor.md"), "Current bundled prompt.\n", "utf8");
    writeFileSync(join(overrideDir, "factor.md"), "Unknown legacy customization.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(loadPrompt("factor")).toBe("Unknown legacy customization.");
    expect(existsSync(join(overrideDir, ".prompt-versions.json"))).toBe(true);
  });

  test("upgrades an exact legacy bundled prompt without version metadata", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const current = "Current bundled prompt.\n";
    const legacy = [
      "Extract concrete observations from the supplied source corpus for the stated harvest mode.",
      "Each factor should name who or what is acting and express one observable behavior as one verb clause.",
      "Copy a short supporting quote exactly from one supplied source.",
      "Keep separate observations separate, including corroboration from different sources.",
      "Return confidence as your uncertainty about whether the quote supports the observation.",
      "",
    ].join("\r\n");
    writeFileSync(join(bundledDir, "factor-harvest.md"), current, "utf8");
    writeFileSync(join(overrideDir, "factor-harvest.md"), legacy, "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(existsSync(join(overrideDir, "factor-harvest.md"))).toBe(false);
    expect(loadPrompt("factor-harvest")).toBe(current.trim());
    const hash = createHash("sha256").update(legacy).digest("hex");
    expect(readFileSync(join(overrideDir, "bundled-copy-backups", hash, "factor-harvest.md"), "utf8")).toBe(legacy);
  });

  test("preserves future prompt metadata and overrides without rewriting either", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const statePath = join(overrideDir, ".prompt-versions.json");
    const futureState = '{"version":2,"prompts":{"factor.md":"future-baseline"},"futureField":true}\n';
    writeFileSync(join(bundledDir, "factor.md"), "Current bundled prompt.\n", "utf8");
    writeFileSync(join(overrideDir, "factor.md"), "Future managed or custom prompt.\n", "utf8");
    writeFileSync(statePath, futureState, "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(readFileSync(join(overrideDir, "factor.md"), "utf8")).toBe("Future managed or custom prompt.\n");
    expect(readFileSync(statePath, "utf8")).toBe(futureState);
  });

  test("preserves retired custom prompts and never invents a baseline for unknown edits", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "factor.md"), "Bundle.\n");
    writeFileSync(join(overrideDir, "factor.md"), "Unknown edit.\n");
    writeFileSync(join(overrideDir, "retired.md"), "Retired custom instruction.\n");
    configurePromptPaths({ bundledDir, overrideDir });
    expect(JSON.parse(readFileSync(join(overrideDir, ".prompt-versions.json"), "utf8"))).toEqual({
      version: 1, prompts: {}, workflowV2Baselines: {},
    });
    expect(readFileSync(join(overrideDir, "retired.md"), "utf8")).toBe("Retired custom instruction.\n");
    expect(loadPrompt("factor")).toBe("Unknown edit.");
  });

  test("reports an empty override and does not hide a broken bundle behind a custom prompt", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "factor.md"), "Bundle.\n");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(join(overrideDir, "factor.md"), " \n");
    expect(() => loadPrompt("factor")).toThrow("Prompt override is empty");
    writeFileSync(join(overrideDir, "factor.md"), "Custom.\n");
    writeFileSync(join(bundledDir, "factor.md"), " \n");
    expect(() => loadPrompt("factor")).toThrow("Required bundled prompt is missing or empty");
    expect(() => loadPrompt("../factor")).toThrow("Invalid prompt name");
  });
});

function promptFixture(): { bundledDir: string; overrideDir: string } {
  const root = mkdtempSync(join(tmpdir(), "scraply-prompts-"));
  tempDirectories.push(root);
  const bundledDir = join(root, "bundled");
  const overrideDir = join(root, "overrides");
  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  return { bundledDir, overrideDir };
}
