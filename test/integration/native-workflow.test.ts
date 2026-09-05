import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseClient } from "../../src/db/client";
import { WorkspaceStateSchema, type WorkspaceState } from "../../src/shared/ipc";
import { GenerationStartPayloadSchema } from "../../src/shared/runtime-protocol";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { NATIVE_WORKFLOW_MODEL as model, UNTRUSTED_WORKFLOW_TEXT as untrusted, startNativeWorkflowBackend } from "../fixtures/native-workflow-backend";

const statement = "Repair shops cannot reliably predict parts arrival times.";
const scope = {
  title: "Native workflow fixture", audience: "Repair shops", domain: "Parts delivery",
  observations: untrusted, offLimits: ["Holding inventory"],
};
const fixtures: Array<{ directory: string; close(): Promise<void> }> = [];

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.close();
    try { rmSync(item.directory, { recursive: true, force: true }); }
    catch { /* Bun can retain the SQLite WAL handle until the test process exits on Windows. */ }
  }
});

describe("native v1 research workflow through the production backend", () => {
  test("discovers, selects an adverse premise, develops, exports, and reopens without replay", async () => {
    const item = await fixture();
    const threadId = await item.createThread("explore-market");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const discovered = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "problems-ready");
    expect(discovered.problemCandidates).toHaveLength(1);
    expect(discovered.problemCandidates[0]?.verdict).toBe("overstated");
    expect(discovered.problemCandidates[0]?.verdictReason).toContain("disagrees");
    expect(discovered.problemCandidates[0]?.factors).toHaveLength(4);
    expect(item.searches).toHaveLength(7);

    await item.post("/research/select-problems", { threadId, problemIds: [discovered.problemCandidates[0]!.id], userProblem: null }, WorkspaceStateSchema);
    const developed = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(developed.solutions).toHaveLength(3);
    for (const solution of developed.solutions) {
      expect(solution.outcomes).toHaveLength(4);
      expect(solution.risks).toHaveLength(2);
      expect(solution.risks.some((risk) => risk.impact === "project ends")).toBe(true);
      expect(solution.risks.every((risk) => risk.mitigations.length === 1)).toBe(true);
    }

    const exported = await item.post("/research/export", { threadId }, z.object({ content: z.string() }));
    const research = z.object({
      sources: z.array(z.object({ id: z.string(), text: z.string() })),
      factors: z.array(z.object({ sourceId: z.string(), quote: z.string() })),
      researchRun: z.object({ config: z.object({ model: z.object({ providerId: z.string() }) }) }),
    }).parse(JSON.parse(exported.content));
    for (const factor of research.factors) {
      expect(research.sources.find((source) => source.id === factor.sourceId)?.text).toContain(factor.quote);
    }
    expect(research.researchRun.config.model.providerId).toBe(model.providerId);
    const ideas = await item.post("/ideas/export", { threadId, format: "json" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(JSON.parse(ideas.files[0]!.content)).toHaveLength(3);

    const requests = item.requests();
    expect(requests).toHaveLength(20); // Six discovery generations plus the unchanged fourteen-call v1 development.
    expect(requests.filter((request) => request.workOrder.stage === "solutions")).toHaveLength(1);
    for (const request of requests) {
      expect(request.repairPolicy).toBe("one_retry");
      expect(JSON.stringify(request.workOrder)).not.toContain(untrusted);
      expect(request.maxOutputTokens).toBeLessThanOrEqual(8192);
      const promptName = request.workOrder.stage.split(":")[0]!;
      expect(request.workOrder.instruction.startsWith(readFileSync(join(process.cwd(), "prompts", `${promptName}.md`), "utf8").trim())).toBe(true);
    }
    expect(requests.some((request) => JSON.stringify(request.evidence).includes(untrusted))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("synthetic-credential");
    expect(exported.content).not.toContain("synthetic-credential");
    expect(ideas.files[0]?.content).not.toContain("synthetic-credential");
    item.assertAccounting(20);
    expect(item.processIds()).toHaveLength(1);

    await item.restart();
    const reopened = await item.workspace();
    expect(reopened.solutions).toEqual(developed.solutions);
    expect(reopened.problemCandidates).toEqual(developed.problemCandidates);
    const replay = await item.raw("/research/resume", { runId });
    expect(replay.status).toBe(409);
    expect(item.requests()).toHaveLength(20);
    item.assertAccounting(20);
    const validation = await item.post("/validation", undefined, z.object({ native: z.object({ connected: z.boolean() }) }));
    expect(validation.native.connected).toBe(true);
    expect(item.processIds()).toHaveLength(2);
  }, 20_000);

  test("completes a known problem with neither Exa nor Codex available", async () => {
    const item = await fixture({ searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const state = await item.waitFor((value) => value.threads.find((thread) => thread.id === threadId)?.status === "solutions-ready");
    expect(state.validation.codex.detected).toBe(false);
    expect(state.validation.exa.valid).toBe(false);
    expect(state.solutions).toHaveLength(3);
    expect(item.searches).toHaveLength(0);
    expect(item.requests()).toHaveLength(14);
    item.assertAccounting(14);
    const exported = await item.post("/ideas/export", { threadId, format: "markdown" }, z.object({ files: z.array(z.object({ content: z.string() })) }));
    expect(exported.files[0]?.content).toContain("Supplier reliability ledger");
  }, 15_000);

  test("cancels an accepted generation and preserves unknown usage after reopening", async () => {
    const item = await fixture({ mode: "workflow-cancel", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    await item.waitForAttempt("accepted");
    await item.post("/research/cancel", { runId }, z.object({ workspace: WorkspaceStateSchema }));
    await item.waitForAttempt("cancelled");
    expect(item.operations()).toContain("generation.cancel");
    expect(item.requests()).toHaveLength(1);
    await item.restart();
    expect((await item.workspace()).solutions).toHaveLength(0);
    expect((await item.raw("/research/resume", { runId })).status).toBe(409);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE generation_attempt_id IS NOT NULL").all())
        .toEqual([{ status: "committed", committed_usd: null }]);
    } finally { db.close(); }
    expect(item.requests()).toHaveLength(1);
  }, 15_000);

  test("retains partial results after pipe loss and never automatically replays ambiguous work", async () => {
    const item = await fixture({ mode: "workflow-crash", searchEnabled: false });
    const threadId = await item.createThread("known-problem");
    const { runId } = await item.post("/research/start", { threadId }, z.object({ runId: z.string() }));
    const failed = await item.waitFor((state) => state.threads.find((thread) => thread.id === threadId)?.status === "failed");
    expect(failed.solutions).toHaveLength(0); // Incomplete v1 runs are retained in SQLite, not presented as finished solutions.
    expect(item.requests()).toHaveLength(2);
    await item.restart();
    expect((await item.workspace()).solutions).toEqual(failed.solutions);
    expect((await item.raw("/research/resume", { runId })).status).toBe(409);
    expect(item.requests()).toHaveLength(2);
    const db = new DatabaseClient(item.dbPath);
    try {
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM solutions WHERE research_run_id = ?").get(runId)).toEqual({ count: 3 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM outcomes").get()).toEqual({ count: 0 });
      expect(db.db.prepare("SELECT status FROM generation_attempts ORDER BY created_at, rowid").all())
        .toEqual([{ status: "completed" }, { status: "interrupted" }]);
      expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }, 15_000);
});

async function fixture({ mode = "workflow", searchEnabled = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-workflow-"));
  const dbPath = join(directory, "scraply.db");
  const capture = join(directory, "requests.jsonl");
  const pids = join(directory, "pids.txt");
  const operationsCapture = join(directory, "operations.txt");
  const searches: unknown[] = [];
  let backend: Awaited<ReturnType<typeof startNativeWorkflowBackend>>;
  let closed = true;
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

  async function open() {
    backend = await startNativeWorkflowBackend(directory, { mode, searchEnabled, searches });
    closed = false;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await backend.close();
  }
  async function raw(path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${backend.port}${path}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const response = await raw(path, body);
    const result: unknown = await response.json();
    if (response.status !== 200) throw new Error(`${path}: ${JSON.stringify(result)}`);
    return schema.parse(z.object({ data: z.unknown() }).parse(result).data);
  }
  async function workspace() { return post("/workspace", undefined, WorkspaceStateSchema); }
  const item = {
    directory, dbPath, searches, raw, post, workspace, close,
    operations: () => lines(operationsCapture), processIds: () => lines(pids),
    requests: () => lines(capture).map((line) => z.object({ payload: GenerationStartPayloadSchema }).parse(JSON.parse(line)).payload),
    async restart() { await close(); await open(); },
    async createThread(researchMode: "explore-market" | "known-problem") {
      const created = await post("/threads", { title: scope.title }, z.object({ thread: z.object({ id: z.string() }) }));
      const threadId = created.thread.id;
      await post("/scope", { threadId, scope }, WorkspaceStateSchema);
      await post("/run-config", { threadId, config: { ...DEFAULT_RUN_CONFIG, model, discoveryDepth: "quick", researchMode, knownProblem: researchMode === "known-problem" ? statement : "" } }, WorkspaceStateSchema);
      return threadId;
    },
    async waitFor(predicate: (state: WorkspaceState) => boolean) {
      const deadline = Date.now() + 8_000;
      let state = await workspace();
      while (!predicate(state) && Date.now() < deadline) {
        if (state.threads.find((thread) => thread.id === state.activeThreadId)?.status === "failed") {
          throw new Error(`Workflow failed: ${JSON.stringify(state.latestResearchRun)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await workspace();
      }
      expect(predicate(state)).toBe(true);
      return state;
    },
    async waitForAttempt(status: string) {
      const db = new DatabaseClient(dbPath);
      try {
        const deadline = Date.now() + 5_000;
        while (!db.db.prepare("SELECT 1 FROM generation_attempts WHERE status = ?").get(status)) {
          if (Date.now() >= deadline) throw new Error(`No generation reached ${status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { db.close(); }
    },
    assertAccounting(count: number) {
      const db = new DatabaseClient(dbPath);
      try {
        const attempts = db.db.prepare("SELECT status, runtime_prompt_sha256, request_sha256 FROM generation_attempts").all() as Array<{ status: string; runtime_prompt_sha256: string; request_sha256: string }>;
        expect(attempts).toHaveLength(count);
        expect(attempts.every((attempt) => attempt.status === "completed" && attempt.runtime_prompt_sha256.length === 64 && attempt.request_sha256.length === 64)).toBe(true);
        const costs = db.db.prepare("SELECT status, committed_usd FROM cost_ledger WHERE generation_attempt_id IS NOT NULL").all();
        expect(costs).toHaveLength(count);
        expect(costs).toEqual(Array.from({ length: count }, () => ({ status: "committed", committed_usd: null })));
        expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
    },
  };
  fixtures.push(item);
  await open();
  return item;
}
