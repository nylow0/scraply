import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { ResearchEngine } from "../../src/core/research-engine";
import { listPendingRuns } from "../../src/core/research-recovery";
import { DatabaseClient } from "../../src/db/client";
import { CostLedgerRepository } from "../../src/db/repositories/cost-ledger";
import { ResearchRunRepository } from "../../src/db/repositories/research-runs";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { ExaClient } from "../../src/providers/exa";
import type { StructuredModelClient } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import type { ResearchEvent } from "../../src/shared/ipc";
import { RunConfigSchema, type ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* SQLite WAL lock */ }
  }
});

describe("research hard limits", () => {
  test("resuming a two-hour-old run starts a fresh wall-clock attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-aged-resume-"));
    dirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const thread = new ThreadRepository(db).createThread();
    const config = RunConfigSchema.parse({
      ...DEFAULT_RUN_CONFIG,
      orchestratorProvider: "codex",
      workerProvider: "codex",
      ideaProvider: "codex",
      parallelism: 1,
      maxRunMinutes: 1,
    });
    const brief = makeProjectBrief({ title: "Aged resume", objective: "Resume safely" });
    const { runId } = new ResearchRunRepository(db).create(thread.id, brief, config);
    db.db.prepare("UPDATE research_runs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString(), runId);

    let searchStarted = false;
    let searchAborted = false;
    const exa = new ExaClient("test", async (_input, init) => new Promise<Response>((_resolve, reject) => {
      searchStarted = true;
      const signal = init?.signal;
      const abort = () => {
        searchAborted = true;
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }));
    const engine = new ResearchEngine({ db, exa, onEvent: () => {} });

    await engine.resumeRun(runId);
    await Bun.sleep(20);

    expect(searchStarted).toBe(true);
    expect(searchAborted).toBe(false);
    expect(engine.getActiveRunIds().has(runId)).toBe(true);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "running" });

    engine.cancelRun(runId);
    await Bun.sleep(10);
    db.close();
  });

  test("resuming preserves the durable Codex call budget and never refunds an interrupted call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-durable-calls-"));
    dirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const thread = new ThreadRepository(db).createThread();
    const config = RunConfigSchema.parse({
      ...DEFAULT_RUN_CONFIG,
      orchestratorProvider: "codex",
      workerProvider: "codex",
      ideaProvider: "codex",
      parallelism: 1,
      maxCodexCalls: 1,
      maxExaSearches: 1,
      maxRunMinutes: 1,
    });
    const brief = makeProjectBrief({ title: "Durable calls", objective: "Keep provider limits" });
    const { runId } = new ResearchRunRepository(db).create(thread.id, brief, config);
    const ledger = new CostLedgerRepository(db);
    const completed = ledger.reserve(runId, "previous-model-call", "codex", config.workerModel, 0);
    ledger.commit(completed.id);
    const orphaned = ledger.reserve(runId, "interrupted-model-call", "codex", config.workerModel, 0);

    const exa = new ExaClient("test", async () => new Response(JSON.stringify({
      results: [{ id: "source-1", url: "https://example.com/source", title: "Source", text: "Useful evidence." }],
    }), { status: 200 }));
    let modelCalls = 0;
    const model: StructuredModelClient = {
      async structuredCompletion<T>(_m: string, _s: string, _u: string, schema: z.ZodType<T>): Promise<T> {
        modelCalls++;
        return schema.parse({});
      },
    };
    const engine = new ResearchEngine({ db, exa, modelClients: { codex: model }, onEvent: () => {} });

    await engine.resumeRun(runId);
    let status = "running";
    for (let attempt = 0; attempt < 50; attempt++) {
      status = (db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId) as { status: string }).status;
      if (status === "failed") break;
      await Bun.sleep(10);
    }

    expect(status).toBe("failed");
    expect(modelCalls).toBe(0);
    // A call that was in flight when the process died still spent a provider call. Refunding it
    // would let a crash-resume loop exceed maxCodexCalls without bound.
    expect(ledger.countProviderCalls(runId, "codex")).toBe(2);
    expect(db.db.prepare("SELECT status, usage_json FROM cost_ledger WHERE id = ?").get(orphaned.id))
      .toEqual({
        status: "committed",
        usage_json: JSON.stringify({ uncertain: true, reason: "Reservation was in flight when the run stopped" }),
      });
    db.close();
  });

  test("wall-clock deadline aborts in-flight search and persists a typed timeout failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-deadline-"));
    dirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const thread = new ThreadRepository(db).createThread();
    let searchAborted = false;
    const exa = new ExaClient("test", async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => {
        searchAborted = true;
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }));
    const unusedModel: StructuredModelClient = {
      async structuredCompletion<T>(_m: string, _s: string, _u: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };
    const config = {
      ...RunConfigSchema.parse({
        ...DEFAULT_RUN_CONFIG,
        orchestratorProvider: "codex",
        workerProvider: "codex",
        ideaProvider: "codex",
        parallelism: 1,
      }),
      maxRunMinutes: 0.001,
    };
    const brief: ProjectBrief = makeProjectBrief({
      title: "Deadline",
      objective: "Timeout",
      context: "Verify immediate cancellation",
      desiredOutput: { type: "research-brief", notes: "Evidence" },
      successCriteria: ["Stops quickly"],
      evidenceRequirements: ["One search"],
      decisionToSupport: "Stop",
      deadline: "Now",
      availableEffort: "Low",
      ideaStyle: "safe",
    });
    const events: ResearchEvent[] = [];
    const engine = new ResearchEngine({
      db,
      exa,
      modelClients: { codex: unusedModel },
      onEvent: (event) => events.push(event),
    });
    const runId = await engine.startRun(thread.id, brief, config);
    expect(listPendingRuns(db, engine.getActiveRunIds())).toEqual([]);
    expect(listPendingRuns(db).map((pending) => pending.runId)).toEqual([runId]);

    let run: { status: string; completion_reason: string | null } | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      run = db.db.prepare("SELECT status, completion_reason FROM research_runs WHERE id = ?").get(runId) as typeof run;
      if (run?.status === "failed") break;
      await Bun.sleep(20);
    }
    expect(searchAborted).toBe(true);
    expect(run?.status).toBe("failed");
    expect(run?.completion_reason).toContain("wall-clock limit");
    const event = db.db.prepare(`
      SELECT payload_json FROM job_events WHERE run_id = ? AND type = 'run-failed' ORDER BY id DESC LIMIT 1
    `).get(runId) as { payload_json: string };
    expect(JSON.parse(event.payload_json).code).toBe("timeout");
    expect(events.filter((item) => item.type === "run-completed")).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "run-failed",
      runId,
      threadId: thread.id,
      error: "Research run wall-clock limit reached",
    });
    const storedThread = db.db.prepare("SELECT status FROM threads WHERE id = ?").get(thread.id) as { status: string };
    expect(storedThread.status).toBe("configuring");
    db.close();
  });

  test("active cancellation keeps run, thread, and live event state consistent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-cancel-"));
    dirs.push(dir);
    const db = new DatabaseClient(join(dir, "scraply.db"));
    const thread = new ThreadRepository(db).createThread();
    const exa = new ExaClient("test", async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }));
    const unusedModel: StructuredModelClient = {
      async structuredCompletion<T>(_m: string, _s: string, _u: string, schema: z.ZodType<T>): Promise<T> {
        return schema.parse({});
      },
    };
    const config = RunConfigSchema.parse({
      ...DEFAULT_RUN_CONFIG,
        orchestratorProvider: "codex",
        workerProvider: "codex",
        ideaProvider: "codex",
      parallelism: 1,
      maxRunMinutes: 1,
    });
    const brief: ProjectBrief = makeProjectBrief({
      title: "Cancellation",
      objective: "Cancellation",
      context: "Verify explicit cancellation",
      desiredOutput: { type: "research-brief", notes: "Evidence" },
      successCriteria: ["Stops cleanly"],
      evidenceRequirements: ["One search"],
      decisionToSupport: "Stop",
      deadline: "Now",
      availableEffort: "Low",
      ideaStyle: "safe",
    });
    const events: ResearchEvent[] = [];
    const engine = new ResearchEngine({
      db,
      exa,
      modelClients: { codex: unusedModel },
      onEvent: (event) => events.push(event),
    });
    const runId = await engine.startRun(thread.id, brief, config);
    await Bun.sleep(10);

    engine.cancelRun(runId);
    await Bun.sleep(20);

    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = ?").get(runId)).toEqual({ status: "cancelled" });
    expect(db.db.prepare("SELECT status FROM threads WHERE id = ?").get(thread.id)).toEqual({ status: "configuring" });
    expect(events.at(-1)).toEqual({ type: "run-cancelled", runId, threadId: thread.id });
    expect(engine.getActiveRunIds().has(runId)).toBe(false);
    db.close();
  });
});
