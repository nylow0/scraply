import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { ResearchEngine } from "../../src/core/research-engine";
import { DatabaseClient } from "../../src/db/client";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { ExaClient } from "../../src/providers/exa";
import type { StructuredModelClient } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { RunConfigSchema, type ProjectBrief } from "../../src/shared/schemas";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* SQLite WAL lock */ }
  }
});

describe("research hard limits", () => {
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
        orchestratorProvider: "opencode",
        workerProvider: "opencode",
        ideaProvider: "opencode",
        parallelism: 1,
      }),
      maxRunMinutes: 0.001,
    };
    const brief: ProjectBrief = {
      projectName: "Deadline",
      theme: "Timeout",
      description: "Verify immediate cancellation",
      desiredOutput: "Evidence",
      successDefinition: "Stops quickly",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "One search",
      finalDecision: "Stop",
      deadline: "Now",
      availableEffort: "Low",
      ideaStylePreference: "Safe",
    };
    const engine = new ResearchEngine({
      db,
      exa,
      modelClients: { opencode: unusedModel },
      onEvent: () => undefined,
    });
    const runId = await engine.startRun(thread.id, brief, config);

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
    db.close();
  });
});
