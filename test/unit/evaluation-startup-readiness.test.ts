import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { evaluationBackend, evaluationMatrix, loadEvaluationBriefs } from "../../scripts/eval-research";
import { IPC_CHANNELS, WorkspaceStateSchema } from "../../src/shared/ipc";

const item = evaluationMatrix(loadEvaluationBriefs(join(import.meta.dir, "../eval/briefs")), "acceptance")[0]!;
const readyWorkspace = WorkspaceStateSchema.parse({
  validation: { native: { available: true, connected: true, accounts: [], version: "fixture" },
    exa: { valid: true }, perplexity: { valid: false, checking: true }, setupComplete: true },
  modelOptions: [{ ...item.brief.runSettings.model, displayName: "Fixture model", defaultReasoningEffort: "xhigh",
    reasoningEfforts: [{ id: "xhigh", description: "Extra high" }] }],
  threads: [], activeThreadId: null, messages: [], scope: null, runConfig: null, models: [],
  modelCatalog: { models: [], favorites: [] }, presets: [], problemCandidates: [], rejectedProblemCandidates: [], solutions: [],
  latestResearchRun: null, pendingRuns: [], researchRequests: [], researchFindings: [],
});
const pendingWorkspace = { ...readyWorkspace, modelOptions: [], validation: { ...readyWorkspace.validation,
  native: { available: false, connected: false, accounts: [], error: "Checking native runtime" }, exa: { valid: false, checking: true } } };
type Workspace = z.infer<typeof WorkspaceStateSchema>;

function fixture(workspaces: Workspace[]) {
  const build = resolve(import.meta.dir, "../../build");
  mkdirSync(build, { recursive: true });
  const directory = mkdtempSync(join(build, "readiness-test-"));
  const databasePath = join(directory, "scraply.db");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
  database.close();
  const channels: string[] = [];
  let reads = 0, elapsed = 0;
  const invoke: Parameters<typeof evaluationBackend>[0] = async (channel, schema) => {
    channels.push(channel);
    if (channel === IPC_CHANNELS.GET_WORKSPACE) return schema.parse(workspaces[Math.min(reads++, workspaces.length - 1)]);
    if (channel === IPC_CHANNELS.CREATE_THREAD) return schema.parse({ workspace: { ...readyWorkspace, activeThreadId: "created-after-ready" } });
    throw new Error(`Unexpected admission or mutation: ${channel}`);
  };
  return { channels,
    backend: evaluationBackend(invoke, databasePath, "unused", { now: () => elapsed, async wait(ms) {
      expect(channels.every(channel => channel === IPC_CHANNELS.GET_WORKSPACE)).toBe(true);
      expect(ms).toBeLessThanOrEqual(500);
      elapsed += ms;
    } }),
    elapsed: () => elapsed,
    cleanup() {
      const location = relative(build, directory);
      if (!location || location.startsWith("..") || resolve(build, location) !== directory) throw new Error("Fixture cleanup escaped build.");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("evaluation startup readiness", () => {
  test.each(["Checking native runtime", "Native runtime is starting"])("waits through %s for native, catalog and fixture-selected Exa before creating a project", async error => {
    const checkingSearch = { ...readyWorkspace, validation: { ...readyWorkspace.validation, exa: { valid: false, checking: true } } };
    const run = fixture([{ ...pendingWorkspace, validation: { ...pendingWorkspace.validation,
      native: { ...pendingWorkspace.validation.native, error } } }, checkingSearch, readyWorkspace]);
    try {
      expect(await run.backend.create(item)).toBe("created-after-ready");
      expect(run.channels).toEqual([IPC_CHANNELS.GET_WORKSPACE, IPC_CHANNELS.GET_WORKSPACE, IPC_CHANNELS.GET_WORKSPACE, IPC_CHANNELS.CREATE_THREAD]);
      expect(run.elapsed()).toBe(1000);
    } finally { run.cleanup(); }
  });

  test("a finite 45-second readiness timeout never creates or admits work", async () => {
    const run = fixture([pendingWorkspace]);
    try {
      await expect(run.backend.create(item)).rejects.toThrow("within 45 seconds");
      expect(run.elapsed()).toBe(45_000);
      expect(run.channels.length).toBe(90);
      expect(new Set(run.channels)).toEqual(new Set([IPC_CHANNELS.GET_WORKSPACE]));
    } finally { run.cleanup(); }
  });

  test("settled invalid Exa credentials fail without polling or using Perplexity", async () => {
    const run = fixture([{ ...readyWorkspace, validation: { ...readyWorkspace.validation,
      exa: { valid: false, error: "invalid fixture key" }, perplexity: { valid: true } } }]);
    try {
      await expect(run.backend.create(item)).rejects.toThrow("Exa credentials must be connected");
      expect(run.channels).toEqual([IPC_CHANNELS.GET_WORKSPACE]);
      expect(run.elapsed()).toBe(0);
    } finally { run.cleanup(); }
  });

  test("settled disconnected native credentials fail without admission", async () => {
    const run = fixture([{ ...readyWorkspace, validation: { ...readyWorkspace.validation,
      native: { available: true, connected: false, accounts: [], error: "fixture account disconnected" } } }]);
    try {
      await expect(run.backend.create(item)).rejects.toThrow("OpenAI credentials must be connected");
      expect(run.channels).toEqual([IPC_CHANNELS.GET_WORKSPACE]);
    } finally { run.cleanup(); }
  });

  test.each([
    { models: [], message: "is unavailable" },
    { models: [{ ...readyWorkspace.modelOptions[0]!, reasoningEfforts: [{ id: "low" as const, description: "Low" }] }], message: "does not support xhigh" },
  ])("unsupported model capabilities fail before project creation: $message", async ({ models, message }) => {
    const run = fixture([{ ...readyWorkspace, modelOptions: WorkspaceStateSchema.shape.modelOptions.parse(models) }]);
    try {
      await expect(run.backend.create(item)).rejects.toThrow(message);
      expect(run.channels).toEqual([IPC_CHANNELS.GET_WORKSPACE]);
      expect(run.elapsed()).toBe(0);
    } finally { run.cleanup(); }
  });
});
