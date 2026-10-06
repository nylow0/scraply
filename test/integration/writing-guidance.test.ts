import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths, loadWritingGuidance, resolveWorkflowV2Prompt, type ResolvedWorkflowV2Prompt } from "../../src/core/prompts";
import { WORKFLOW_V2_STAGE_IDS } from "../../src/core/stages";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { DatabaseClient } from "../../src/db/client";
import type { StructuredModelClient } from "../../src/providers/structured";
import { sha256 } from "../../src/shared/content-identity";
import { deriveJsonSchema } from "../../src/shared/json-schema";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { ProblemCandidatesOutputSchema } from "../../src/shared/structured-output-schemas";

const directories: string[] = [];
const bundledDir = join(import.meta.dir, "../../prompts");

afterEach(() => {
  configurePromptPaths({ bundledDir, overrideDir: null });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scraply-writing-"));
  directories.push(directory);
  const path = join(directory, "scraply.db");
  const db = new DatabaseClient(path);
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Writing','configuring',?,?)").run(now, now);
  db.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,created_at,updated_at) VALUES ('run','thread','running',?,2,?,?)")
    .run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  configurePromptPaths({ bundledDir, overrideDir: null });
  return { db, path, directory };
}

test.each(["legacy", "saved-guidance"] as const)("a saved %s run reuses its completed stage after reopening with the new bundle", async kind => {
  const { db, path } = fixture();
  const savedGuidance = kind === "legacy" ? "" : "Writing rules saved before the bundle changed.";
  const originalText = `  Original problem instructions.\r\nKeep the original uncertainty.\r\n${savedGuidance}`;
  const oldPrompts = Object.fromEntries(WORKFLOW_V2_STAGE_IDS.map(stage => {
    const current = resolveWorkflowV2Prompt(stage);
    const text = stage === "problem-candidates" ? originalText : `Original ${stage} instructions.`;
    return [stage, { ...current, text, resolvedSha256: sha256(text) }];
  }));
  db.db.prepare("INSERT INTO workflow_snapshots VALUES ('run','prompts',?)").run(JSON.stringify(oldPrompts));
  if (savedGuidance) db.db.prepare("INSERT INTO workflow_snapshots VALUES ('run','writing-guidance',?)").run(JSON.stringify(savedGuidance));
  db.close();
  const reopened = new DatabaseClient(path);
  try {
    const workflow = new WorkflowExecution(reopened, "run");
    expect(workflow.resolvePrompt("problem-candidates").text).toBe(originalText);
    expect(workflow.resolvePrompt("problem-candidates").resolvedSha256).toBe(sha256(originalText));
    expect(workflow.read<Record<string, ResolvedWorkflowV2Prompt>>("prompts")).toEqual(oldPrompts);
    expect(workflow.read<string>("writing-guidance")).toBe(savedGuidance || null);
    let calls = 0;
    const model: StructuredModelClient = { async structuredCompletion(request) {
      calls += 1;
      expect(request.workOrder.instruction).toBe(originalText);
      expect(request.workOrder.instruction).not.toContain("# Unslop");
      return { output: request.schema.parse({ problems: [] }), metadata: {
        model: request.model, usage: { status: "unknown" }, latencyMs: 1,
        repairCount: 0, providerRequestIds: [], attempts: [],
        prompt: { id: "scraply.stage-worker.v1", sha256: sha256("offline compiler") },
      } };
    } };
    const schema = ProblemCandidatesOutputSchema;
    const request = {
      generationId: "offline-old-run", stage: "problem-candidates", model: { providerId: "fixture", modelId: "fixture" },
      reasoningEffort: "low" as const, workOrder: { stage: "problem-candidates", instruction: "Fresh instructions must not leak in.",
        goal: "Find problems", inputs: {}, definitionOfDone: [] }, evidence: [],
      schema, jsonSchema: deriveJsonSchema(schema), repairPolicy: "disabled" as const,
    };
    const first = await workflow.discoveryClient(model).structuredCompletion(request);
    expect(calls).toBe(1);
    const resumeDb = new DatabaseClient(path);
    try {
      const resumed = new WorkflowExecution(resumeDb, "run");
      const reused = await resumed.discoveryClient({
        async structuredCompletion() { throw new Error("Completed stage must not dispatch again"); },
      }).structuredCompletion({ ...request, generationId: "offline-resumed-run" });
      expect(reused.output).toEqual(first.output);
      expect(calls).toBe(1);
    } finally { resumeDb.close(); }
  } finally { reopened.close(); }
});

test("a new run freezes full stage prompts and inline guidance across bundle and override changes", () => {
  const { db, path, directory } = fixture();
  const localBundle = join(directory, "bundle");
  cpSync(bundledDir, localBundle, { recursive: true });
  const overrideDir = join(directory, "overrides");
  configurePromptPaths({ bundledDir: localBundle, overrideDir });
  writeFileSync(join(overrideDir, "workflow-v2-solutions.md"), "Custom idea instructions.\r\n");
  const guidance = loadWritingGuidance();
  const before = new WorkflowExecution(db, "run");
  const prompts = before.read<Record<string, ResolvedWorkflowV2Prompt>>("prompts");
  const text = before.resolvePrompt("solutions").text;
  expect(text).toBe(`Custom idea instructions.\r\n\n\n${guidance}`);
  expect(before.read<string>("writing-guidance")).toBe(guidance);
  writeFileSync(join(localBundle, "writing-guidance.md"), "Future writing rules.");
  writeFileSync(join(overrideDir, "workflow-v2-solutions.md"), "Future custom instructions.");
  expect(resolveWorkflowV2Prompt("solutions").text).toContain("Future writing rules.");
  db.close();
  const reopened = new DatabaseClient(path);
  try {
    const resumed = new WorkflowExecution(reopened, "run");
    expect(resumed.read<Record<string, ResolvedWorkflowV2Prompt>>("prompts")).toEqual(prompts);
    expect(resumed.resolvePrompt("solutions").text).toBe(text);
    expect(resumed.read<string>("writing-guidance")).toBe(guidance);
    expect(readFileSync(join(overrideDir, "workflow-v2-solutions.md"), "utf8")).toBe("Future custom instructions.");
  } finally { reopened.close(); }
});
