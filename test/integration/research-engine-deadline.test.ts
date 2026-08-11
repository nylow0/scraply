import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchEngine } from "../../src/core/research-engine";
import { DatabaseClient } from "../../src/db/client";
import type { ExaClient } from "../../src/providers/exa";
import type { StructuredModelClient } from "../../src/providers/structured";
import type { ResearchEvent } from "../../src/shared/ipc";
import type { RunConfig } from "../../src/shared/schemas";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    try {
      rmSync(tempDirectories.pop()!, { recursive: true, force: true });
    } catch {
      // Windows can retain a SQLite WAL handle briefly.
    }
  }
});

describe("research engine deadlines", () => {
  test("fails and releases a run when its provider never settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-deadline-"));
    tempDirectories.push(directory);
    const db = new DatabaseClient(join(directory, "scraply.db"));
    const events: ResearchEvent[] = [];
    const neverSettles = <T>(): Promise<T> => new Promise(() => undefined);
    const modelClient: StructuredModelClient = {
      structuredCompletion: () => neverSettles(),
    };
    const exa = { search: () => neverSettles() } as unknown as ExaClient;

    try {
      const now = new Date().toISOString();
      db.db.prepare(`
        INSERT INTO threads (id, title, status, created_at, updated_at)
        VALUES ('thread-1', 'Deadline', 'configuring', ?, ?)
      `).run(now, now);
      const config: RunConfig = {
        model: "test-model",
        discoveryDepth: "quick",
        maxRunMinutes: 0.001,
      };
      const engine = new ResearchEngine({ db, modelClients: { codex: modelClient }, exa, onEvent: (event) => events.push(event) });
      const runId = await engine.startDiscovery("thread-1", {
        title: "Deadline",
        audience: "Operators",
        domain: "Operations",
        observations: "Provider calls can hang",
        offLimits: [],
      }, config);

      await waitFor(() => !engine.getActiveRunIds().has(runId));

      const run = db.db.prepare("SELECT status, cancelled, completion_reason FROM research_runs WHERE id = ?")
        .get(runId) as { status: string; cancelled: number; completion_reason: string | null };
      const thread = db.db.prepare("SELECT status FROM threads WHERE id = 'thread-1'").get() as { status: string };
      expect(run).toEqual({
        status: "failed",
        cancelled: 0,
        completion_reason: "Run attempt exceeded its hang-detection deadline",
      });
      expect(thread.status).toBe("failed");
      expect(db.db.prepare("SELECT status FROM cost_ledger WHERE research_run_id = ?").all(runId))
        .toEqual([{ status: "committed" }]);
      expect(events.filter((event) => event.type === "run-failed")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const expiresAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error("Timed out waiting for the run deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
