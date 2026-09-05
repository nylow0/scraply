import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RuntimeClient } from "../../src/providers/runtime";
import { harvestFactors } from "../../src/core/discovery";
import { DatabaseClient } from "../../src/db/client";
import { ResearchEngine } from "../../src/core/research-engine";
import type { RunConfig } from "../../src/shared/schemas";

const fixtureScript = join(import.meta.dir, "..", "fixtures", "runtime-child.cjs");
const scratchDirectories: string[] = [];
const clients: RuntimeClient[] = [];

function client(mode: string, overrides: {
  requestTimeoutMs?: number; controlTimeoutMs?: number; terminalGraceMs?: number; environment?: NodeJS.ProcessEnv;
} = {}) {
  const executablePath = process.execPath;
  const { environment, ...timings } = overrides;
  const runtime = new RuntimeClient({
    executablePath,
    argumentPrefix: [fixtureScript],
    artifact: {
      version: "0.1.0",
      sourceCommit: "ab9fcfc859ee19fff8dfd4c05c854ab5d145baf8",
      sha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"),
    },
    appVersion: "0.3.0-test",
    environment: { ...process.env, SCRAPLY_RUNTIME_CHILD_MODE: mode, ...environment },
    ...timings,
  });
  clients.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((runtime) => runtime.close()));
  for (const directory of scratchDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { /* Bun can retain a SQLite WAL handle briefly on Windows. */ }
  }
});

describe("persistent native runtime client", () => {
  test("handles split UTF-8, coalesced frames, and only the correlated terminal event", async () => {
    const runtime = client("normal");
    expect((await runtime.listModels("openai-subscription"))[0]?.displayName).toBe("Modèle");

    const result = await runtime.structuredCompletion({
      generationId: "generation-one",
      stage: "fixture",
      deadlineMs: 1_000,
      model: { providerId: "openai-subscription", modelId: "gpt-fixture" },
      reasoningEffort: "medium",
      workOrder: { stage: "fixture", instruction: "Return the answer.", goal: "Exercise framing.", definitionOfDone: ["One answer"] },
      evidence: [{ sourceId: "fixture-source", content: "untrusted evidence" }],
      schema: z.object({ answer: z.string() }).strict(),
      jsonSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
      repairPolicy: "one_retry",
    });

    expect(result.output).toEqual({ answer: "right" });
    expect(result.metadata.attempts[0]?.providerCompletion).toBe("confirmed");
  });

  test("kills a runtime that acknowledges cancellation without a terminal event", async () => {
    const runtime = client("hang-cancel", { requestTimeoutMs: 1_000, controlTimeoutMs: 50, terminalGraceMs: 50 });
    const abort = new AbortController();
    const completion = runtime.structuredCompletion({
      generationId: "generation-cancel",
      stage: "fixture",
      deadlineMs: 500,
      model: { providerId: "openai-subscription", modelId: "gpt-fixture" },
      reasoningEffort: "medium",
      workOrder: { stage: "fixture", instruction: "Wait.", goal: "Exercise cancellation.", definitionOfDone: ["A terminal event"] },
      evidence: [], schema: z.object({ answer: z.string() }), jsonSchema: { type: "object" },
      repairPolicy: "one_retry",
      onAccepted: () => abort.abort(), signal: abort.signal,
    });
    await expect(completion).rejects.toThrow("cancellation terminal metadata");
  });

  test("bounds hung shutdown and rejects a response whose operation does not match", async () => {
    const hung = client("hang-shutdown", { controlTimeoutMs: 50 });
    await hung.start();
    const started = Date.now();
    await hung.close();
    expect(Date.now() - started).toBeLessThan(1_000);

    const mismatched = client("wrong-operation", { requestTimeoutMs: 1_000 });
    await expect(mismatched.listModels("openai-subscription")).rejects.toThrow("operation did not match");
    expect(await mismatched.listAccounts()).toEqual([]);
  });

  test("rejects invalid UTF-8 and can start a clean replacement process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-runtime-client-"));
    scratchDirectories.push(directory);
    const runtime = client("malformed-once", {
      requestTimeoutMs: 1_000,
      environment: { SCRAPLY_RUNTIME_MARKER: join(directory, "malformed-seen") },
    });
    await expect(runtime.start()).rejects.toThrow("invalid protocol message");
    expect(await runtime.listAccounts()).toEqual([]);
  });

  test("keeps hostile research text in evidence in the exact native request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-runtime-capture-"));
    scratchDirectories.push(directory);
    const capturePath = join(directory, "requests.jsonl");
    const corpus = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "research-baseline", "corpus.json"), "utf8")) as {
      sources: Array<{ id: string; url: string; title: string; text: string }>;
      scenarios: { adversarialSourceText: { untrustedQuote: string } };
    };
    const adversarial = corpus.sources.find((source) => source.id === "source-adversarial-text");
    if (!adversarial) throw new Error("Adversarial source fixture is missing");
    const runtime = client("normal", { environment: { SCRAPLY_RUNTIME_CAPTURE: capturePath } });

    await harvestFactors({ title: "Repair reliability", audience: "Repair shops", domain: "Parts delivery", observations: "", offLimits: [] }, {
      model: { providerId: "openai-subscription", modelId: "gpt-fixture" }, reasoningEffort: "medium", depth: "quick",
      modelClient: runtime,
      search: { async search() { return [adversarial]; } },
    });

    const requests = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      payload: { workOrder: unknown; evidence?: unknown };
    });
    const harvest = requests.find((request) => JSON.stringify(request.payload.workOrder).includes("factor-harvest"));
    if (!harvest) throw new Error("Factor harvest request was not captured");
    expect(JSON.stringify(harvest.payload.evidence)).toContain(corpus.scenarios.adversarialSourceText.untrustedQuote);
    expect(JSON.stringify(harvest.payload.workOrder)).not.toContain(corpus.scenarios.adversarialSourceText.untrustedQuote);
    expect(JSON.stringify(harvest.payload)).not.toContain("AGENTS.md");
    expect(JSON.stringify(harvest.payload)).not.toContain("SKILL.md");
  });

  test("cancels a second project in the queue without dispatching or reserving it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraply-runtime-queue-"));
    scratchDirectories.push(directory);
    const capturePath = join(directory, "requests.jsonl");
    const db = new DatabaseClient(join(directory, "queue.db"));
    const runtime = client("hang-cancel", {
      requestTimeoutMs: 1_000, controlTimeoutMs: 50, terminalGraceMs: 50,
      environment: { SCRAPLY_RUNTIME_CAPTURE: capturePath },
    });
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'configuring', ?, ?)")
      .run("thread-one", "One", now, now);
    db.db.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'configuring', ?, ?)")
      .run("thread-two", "Two", now, now);
    const config: RunConfig = {
      configVersion: 2, model: { providerId: "openai-subscription", modelId: "gpt-fixture" }, reasoningEffort: "medium",
      discoveryDepth: "quick", maxRunMinutes: 1, researchMode: "known-problem", knownProblem: "Parts arrive late.", searchProvider: "exa",
    };
    const engine = new ResearchEngine({ db, modelClients: { "openai-subscription": runtime }, onEvent: () => undefined });
    try {
      const first = await engine.startKnownProblem("thread-one", { title: "One", audience: "", domain: "", observations: "", offLimits: [] }, config.knownProblem, config);
      const second = await engine.startKnownProblem("thread-two", { title: "Two", audience: "", domain: "", observations: "", offLimits: [] }, config.knownProblem, config);
      await waitUntil(() => existsSync(capturePath) && readFileSync(capturePath, "utf8").trim().length > 0);
      expect(readFileSync(capturePath, "utf8").trim().split("\n")).toHaveLength(1);

      engine.cancelRun(second);
      await waitUntil(() => (db.db.prepare("SELECT status FROM generation_attempts WHERE research_run_id = ?").get(second) as { status?: string } | undefined)?.status === "cancelled");
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger WHERE research_run_id = ?").get(second)).toEqual({ count: 0 });
      expect(readFileSync(capturePath, "utf8").trim().split("\n")).toHaveLength(1);

      engine.cancelRun(first);
      await engine.shutdown();
    } finally { db.close(); }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime fixture state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
