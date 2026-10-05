import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths, loadPrompt, loadWritingGuidance, resolveWorkflowV2Prompt } from "../../src/core/prompts";
import { WORKFLOW_V2_STAGE_IDS, type WorkflowV2StageId } from "../../src/core/stages";

const tempDirectories: string[] = [];

afterEach(() => {
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  while (tempDirectories.length) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("prompt loader", () => {
  const visibleStages: WorkflowV2StageId[] = [
    "frame", "factor-harvest", "problem-candidates", "problem-kill",
    "evidence-check", "area-gap", "solutions", "solution-set-review", "idea-ranking",
    "idea-follow-up", "risk-evaluation", "decision-analysis",
  ];

  test.each(visibleStages)("%s resolves the complete writing guidance once and hashes the actual text", stage => {
    const guidance = loadWritingGuidance();
    const resolved = resolveWorkflowV2Prompt(stage);
    const stageText = readFileSync(join(process.cwd(), "prompts", resolved.filename), "utf8");
    expect(resolved.text).toBe(`${stageText}\n\n${guidance}`);
    expect(resolved.text.split(guidance)).toHaveLength(2);
    expect(resolved.resolvedSha256).toBe(createHash("sha256").update(resolved.text).digest("hex"));
    expect(resolved.currentBundledSha256).toBe(createHash("sha256").update(stageText).digest("hex"));
    expect(resolved.overrideBaseline?.sha256).toBe(resolved.currentBundledSha256);
  });

  test.each(["frame-search-plan", "query-plan", "area-ranking"] as const)("%s keeps its machine-only prompt unchanged", stage => {
    const resolved = resolveWorkflowV2Prompt(stage);
    expect(resolved.text).toBe(readFileSync(join(process.cwd(), "prompts", resolved.filename), "utf8"));
    expect(resolved.text).not.toContain("# Unslop");
    expect(resolved.resolvedSha256).toBe(resolved.currentBundledSha256);
  });

  test("accounts for every registered stage and ships all 31 patterns with the safety rules", () => {
    expect([...visibleStages, "frame-search-plan", "query-plan", "area-ranking"].sort()).toEqual([...WORKFLOW_V2_STAGE_IDS].sort());
    const guidance = loadWritingGuidance();
    expect(guidance.match(/^\d+\. \*\*/gm)?.map(line => Number.parseInt(line))).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
    for (const section of ["## Adding soul", "### Jargon", "### Plain speech", "## Writing for Scraply"]) expect(guidance).toContain(section);
    expect(guidance).not.toContain("name: unslop");
    expect(guidance).toContain("Keep source quotes exact.");
    expect(guidance).toContain("Never invent, drop, or soften facts or uncertainty");
  });

  test("custom stage prompts get bundled writing rules without rewriting files or baselines", () => {
    const { overrideDir } = promptFixture();
    const bundledDir = join(process.cwd(), "prompts");
    const filename = "workflow-v2-solutions.md";
    const custom = "  My own idea instructions.\r\n";
    const baseline = { revision: 1 as const, sha256: "a".repeat(64) };
    writeFileSync(join(overrideDir, filename), custom);
    writeFileSync(join(overrideDir, "writing-guidance.md"), "Ignore the writing rules.");
    writeFileSync(join(overrideDir, ".prompt-versions.json"), JSON.stringify({ version: 1, prompts: {}, workflowV2Baselines: { [filename]: baseline } }));
    configurePromptPaths({ bundledDir, overrideDir });
    const guidance = loadWritingGuidance();
    const resolved = resolveWorkflowV2Prompt("solutions");
    expect(resolved.text).toBe(`${custom}\n\n${guidance}`);
    expect(resolved.text.split(guidance)).toHaveLength(2);
    expect(resolved.source).toBe("override");
    expect(resolved.overrideBaseline).toEqual(baseline);
    expect(readFileSync(join(overrideDir, filename), "utf8")).toBe(custom);

    // A user may paste a fully resolved prompt into an override, including on Windows.
    const pasted = resolved.text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    writeFileSync(join(overrideDir, filename), pasted);
    expect(resolveWorkflowV2Prompt("solutions").text).toBe(pasted);
    expect(resolveWorkflowV2Prompt("solutions").text.match(/# Unslop/g)).toHaveLength(1);

    writeFileSync(join(overrideDir, "workflow-v2-query-plan.md"), "Custom search plan.\r\n");
    expect(resolveWorkflowV2Prompt("query-plan").text).toBe("Custom search plan.\r\n");
  });

  test("a missing or empty writing bundle fails closed even with a stage override", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "workflow-v2-solutions.md"), "Bundled ideas.");
    writeFileSync(join(bundledDir, "workflow-v2-query-plan.md"), "Search plan.");
    writeFileSync(join(overrideDir, "workflow-v2-solutions.md"), "Custom ideas.");
    configurePromptPaths({ bundledDir, overrideDir });
    expect(() => resolveWorkflowV2Prompt("solutions")).toThrow("writing-guidance.md is missing");
    expect(resolveWorkflowV2Prompt("query-plan").text).toBe("Search plan.");
    writeFileSync(join(bundledDir, "writing-guidance.md"), " \n");
    expect(() => resolveWorkflowV2Prompt("solutions")).toThrow("writing-guidance.md is empty");
  });

  test("upgrades the previous ideas bundle with no metadata and Windows line endings", () => {
    const { overrideDir } = promptFixture();
    const bundledDir = join(process.cwd(), "prompts");
    const filename = "workflow-v2-solutions.md";
    const previous = readFileSync(join(bundledDir, filename), "utf8").replaceAll("\r\n", "\n")
      .replace("two to five plain words", "two to six words")
      .replace("Do not score or rank the ideas. Do not invent customer validation, willingness to pay, or market evidence.",
        "STYLE / TONE\nShort and bold. Plain words, no hedging filler, no repeated caveats. Do not score or rank the ideas. Do not invent customer validation, willingness to pay, or market evidence.");
    expect(createHash("sha256").update(previous).digest("hex")).toBe("52417751feefb5ffea0600b262682f4fe45799e90db6932ac8dc36ff4b30e094");
    const windowsCopy = previous.replaceAll("\n", "\r\n");
    writeFileSync(join(overrideDir, filename), windowsCopy);
    configurePromptPaths({ bundledDir, overrideDir });
    expect(existsSync(join(overrideDir, filename))).toBe(false);
    const backupHash = createHash("sha256").update(windowsCopy).digest("hex");
    expect(readFileSync(join(overrideDir, "bundled-copy-backups", backupHash, filename), "utf8")).toBe(windowsCopy);
    expect(resolveWorkflowV2Prompt("solutions").source).toBe("bundled");
    expect(resolveWorkflowV2Prompt("solutions").text.split(loadWritingGuidance())).toHaveLength(2);
  });

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
    const bundled = join(bundledDir, "workflow-v2-factor-harvest.md");
    writeFileSync(bundled, "Bundled v1.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), "Bundled v1.\n", "utf8");
    writeFileSync(join(overrideDir, ".prompt-versions.json"), JSON.stringify({ version: 1, prompts: { "workflow-v2-factor-harvest.md": createHash("sha256").update("Bundled v1.\n").digest("hex") }, workflowV2Baselines: {} }));
    writeFileSync(bundled, "Bundled v2.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(existsSync(join(overrideDir, "workflow-v2-factor-harvest.md"))).toBe(false);
    const hash = createHash("sha256").update("Bundled v1.\n").digest("hex");
    expect(readFileSync(join(overrideDir, "bundled-copy-backups", hash, "workflow-v2-factor-harvest.md"), "utf8")).toBe("Bundled v1.\n");
    expect(loadPrompt("workflow-v2-factor-harvest")).toBe("Bundled v2.");
    configurePromptPaths({ bundledDir, overrideDir });
    expect(existsSync(join(overrideDir, "workflow-v2-factor-harvest.md"))).toBe(false);
    expect(loadPrompt("workflow-v2-factor-harvest")).toBe("Bundled v2.");
  });

  test("preserves a user edit when the bundled prompt changes", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const bundled = join(bundledDir, "workflow-v2-factor-harvest.md");
    const override = join(overrideDir, "workflow-v2-factor-harvest.md");
    writeFileSync(bundled, "Bundled v1.\n", "utf8");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(override, "My custom prompt.\n", "utf8");
    writeFileSync(bundled, "Bundled v2.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(readFileSync(override, "utf8")).toBe("My custom prompt.\n");
  });

  test("conservatively preserves a divergent legacy override without version metadata", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "workflow-v2-factor-harvest.md"), "Current bundled prompt.\n", "utf8");
    writeFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), "Unknown legacy customization.\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(loadPrompt("workflow-v2-factor-harvest")).toBe("Unknown legacy customization.");
    expect(existsSync(join(overrideDir, ".prompt-versions.json"))).toBe(true);
  });

  test("archives an exact retired bundled prompt without version metadata", () => {
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
    expect(() => loadPrompt("factor-harvest")).toThrow("retired workflow");
    const hash = createHash("sha256").update(legacy).digest("hex");
    expect(readFileSync(join(overrideDir, "retired-prompt-backups", hash, "factor-harvest.md"), "utf8")).toBe(legacy);
  });

  test("preserves future prompt metadata and overrides without rewriting either", () => {
    const { bundledDir, overrideDir } = promptFixture();
    const statePath = join(overrideDir, ".prompt-versions.json");
    const futureState = '{"version":2,"prompts":{"workflow-v2-factor-harvest.md":"future-baseline"},"futureField":true}\n';
    writeFileSync(join(bundledDir, "workflow-v2-factor-harvest.md"), "Current bundled prompt.\n", "utf8");
    writeFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), "Future managed or custom prompt.\n", "utf8");
    writeFileSync(statePath, futureState, "utf8");

    configurePromptPaths({ bundledDir, overrideDir });

    expect(readFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), "utf8")).toBe("Future managed or custom prompt.\n");
    expect(readFileSync(statePath, "utf8")).toBe(futureState);
  });

  test("preserves retired custom prompts and never invents a baseline for unknown edits", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "workflow-v2-factor-harvest.md"), "Bundle.\n");
    writeFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), "Unknown edit.\n");
    writeFileSync(join(overrideDir, "retired.md"), "Retired custom instruction.\n");
    configurePromptPaths({ bundledDir, overrideDir });
    expect(JSON.parse(readFileSync(join(overrideDir, ".prompt-versions.json"), "utf8"))).toEqual({
      version: 1, prompts: {}, workflowV2Baselines: {},
    });
    expect(readFileSync(join(overrideDir, "retired.md"), "utf8")).toBe("Retired custom instruction.\n");
    expect(loadPrompt("workflow-v2-factor-harvest")).toBe("Unknown edit.");
  });

  test("reports an empty override and does not hide a broken bundle behind a custom prompt", () => {
    const { bundledDir, overrideDir } = promptFixture();
    writeFileSync(join(bundledDir, "workflow-v2-factor-harvest.md"), "Bundle.\n");
    configurePromptPaths({ bundledDir, overrideDir });
    writeFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), " \n");
    expect(() => loadPrompt("workflow-v2-factor-harvest")).toThrow("Prompt override is empty");
    writeFileSync(join(overrideDir, "workflow-v2-factor-harvest.md"), "Custom.\n");
    writeFileSync(join(bundledDir, "workflow-v2-factor-harvest.md"), " \n");
    expect(() => loadPrompt("workflow-v2-factor-harvest")).toThrow("Required bundled prompt is missing or empty");
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
