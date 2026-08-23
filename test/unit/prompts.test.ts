import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths, loadPrompt } from "../../src/core/prompts";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("prompt loader", () => {
  test("loads overrides and falls back when a prompt is missing", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "editable.md"), "Bundled prompt.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(join(overrideDir, "editable.md"), "Editable prompt from disk.\n", "utf8");

    expect(loadPrompt("editable", "fallback prompt")).toBe("Editable prompt from disk.");
    expect(loadPrompt("missing", "fallback prompt")).toBe("fallback prompt");
  });

  test("upgrades an untouched managed override when the bundled prompt changes", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const bundled = join(bundledDir, "factor.md");
    writeFileSync(bundled, "Bundled v1.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(bundled, "Bundled v2.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(readFileSync(join(overrideDir, "factor.md"), "utf8")).toBe("Bundled v2.\n");
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

    expect(loadPrompt("factor", "fallback")).toBe("Unknown legacy customization.");
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

    expect(readFileSync(join(overrideDir, "factor-harvest.md"), "utf8")).toBe(current);
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
