import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  EvaluationMetricsSchema, evaluationDraft, evaluationMarkdown, evaluationMatrix, loadEvaluationBriefs,
  median, runEvaluation, summarizeEvaluation, type EvaluationBackend, type EvaluationRow,
} from "../../scripts/eval-research";
import { WorkflowDetailSchema } from "../../src/shared/workflow-contracts";

const briefs = loadEvaluationBriefs(join(import.meta.dir, "../eval/briefs"));

function row(key: string): EvaluationRow {
  return { key, briefId: "genius", depth: "quick", repeat: 1, threadId: null, sessionId: null, runId: null,
    status: "planned", outcome: null, stopReason: null, metrics: null };
}

function detail(sessionId: string, finished: boolean) {
  return WorkflowDetailSchema.parse({
    summary: { sessionId, threadId: sessionId, purpose: "discovery", mode: "vibe", targetKind: "per-problem", state: finished ? "finished" : "running",
      outcome: finished ? "no-qualifying-ideas" : null, revision: 1, activeSnapshotId: null, selectedProblemIds: [],
      counts: { requested: 1, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 1, existing: 0, addedBySession: 0, total: 0 },
      limits: { enforced: false, maxMinutes: 240, maxModelCalls: 50, maxSearches: 20 },
      budget: { modelCalls: { limit: 50, spent: 3, reserved: 0, uncertain: 0 }, searches: { limit: 20, spent: 2, reserved: 0, uncertain: 0 }, remainingMs: 1000 },
      currentStage: finished ? null : "factor-harvest", stopReason: finished ? "No confirmed problem met the evidence rule." : null,
      startedAt: "2026-09-30T00:00:00.000Z", finishedAt: finished ? "2026-09-30T00:01:00.000Z" : null }, tasks: [], nextCursor: null,
  });
}

function metrics() {
  return EvaluationMetricsSchema.parse({
    factors: 4, totalSources: 4, evidenceMix: { firsthand: 1, measured: 1, vendor: 2 }, sourceMix: { forum: 1, web: 3 },
    qualifyingPerAssessedCandidate: 1, candidateFunnel: { total: 3, assessed: 2, confirmed: 0, insufficient: 2, dropped: 0, notAssessed: 1 },
    coverage: { kind: "phases", groups: [{ id: "domain", confirmed: 0 }] }, acceptedIdeas: 0, modelCalls: 3, searches: 2, wallTimeMs: 60_000, interruptions: 0,
  });
}

describe("research evaluation", () => {
  test("baseline contains two quick repeats per brief and only the three selected standard cases", () => {
    expect(briefs.map(brief => brief.id).sort()).toEqual(["bakery", "bookkeepers", "clinics", "developer-tools", "dorm-kitchen", "educators", "genius", "repair-shops"]);
    const matrix = evaluationMatrix(briefs, "baseline");
    expect(matrix.length).toBe(19);
    expect(evaluationMatrix(briefs, "acceptance").filter(item => item.depth === "deep").map(item => item.brief.id).sort()).toEqual(["clinics", "genius"]);
    for (const brief of briefs) expect(matrix.filter(item => item.brief.id === brief.id && item.depth === "quick").length).toBe(2);
    expect(matrix.filter(item => item.depth === "standard").map(item => item.brief.id).sort())
      .toEqual(briefs.filter(brief => ["genius", "bookkeepers", "dorm-kitchen"].includes(brief.id)).map(brief => brief.id).sort());
    for (const item of matrix) {
      const draft = evaluationDraft(item);
      expect(draft.mode).toBe("vibe");
      expect(draft.scope).toEqual(item.brief.scope);
      expect(draft.limits.enforced).toBe(false);
    }
  });

  test("offline backend launches every matrix case, observes progress and writes a terminal report row", async () => {
    const matrix = evaluationMatrix(briefs, "baseline");
    const manifest = { schemaVersion: 1 as const, origin: "offline-fixture" as const, appCommit: "fixture", fixtureSha256: "fixture", matrix: "baseline" as const,
      createdAt: "2026-09-30T00:00:00.000Z", profile: "fixture", rows: matrix.map(item => ({ ...row(item.key), briefId: item.brief.id, depth: item.depth, repeat: item.repeat })) };
    const launches: string[] = [];
    const polled = new Set<string>();
    let savedLaunching = false;
    let waits = 0;
    const backend: EvaluationBackend = {
      async create(item) { return item.key; },
      async preview(_threadId, draft) {
        return { type: "launch", proposal: { ...draft, resolvedInstructions: { research: "", ideas: "", review: "" },
          instructionHashes: { research: "fixture", ideas: "fixture", review: "fixture" } }, previewHash: "fixture", capabilityFingerprint: "fixture",
          minimumWork: { modelCalls: 1, searches: 1 }, upperLimits: draft.limits, fieldErrors: [], expiresAt: "2026-10-01T00:00:00.000Z" };
      },
      async start(threadId) {
        expect(savedLaunching).toBe(true);
        launches.push(threadId);
        return { sessionId: threadId, revision: 1, summary: detail(threadId, false).summary };
      },
      async detail(sessionId) { const finished = polled.has(sessionId); polled.add(sessionId); return detail(sessionId, finished); },
      async measure(sessionId) { return { runId: sessionId, metrics: metrics() }; },
    };
    await runEvaluation(matrix, manifest, backend, value => { savedLaunching = value.rows.some(row => row.status === "launching"); }, async () => { waits++; });
    expect(launches).toEqual(matrix.map(item => item.key));
    expect(waits).toBe(matrix.length);
    expect(manifest.rows.every(row => row.status === "finished" && row.sessionId && row.metrics)).toBe(true);
    expect(evaluationMarkdown(manifest)).toContain("Origin: offline-fixture");
    await runEvaluation(matrix, manifest, backend, () => {}, async () => {});
    expect(launches.length).toBe(matrix.length);
    manifest.rows[0]!.status = "planned";
    manifest.rows[0]!.sessionId = null;
    await runEvaluation(matrix, manifest, backend, () => {}, async () => {}, () => true);
    expect(launches.length).toBe(matrix.length);
  });

  test("an uncertain admission is never automatically replayed", async () => {
    const matrix = evaluationMatrix([briefs[0]!], "quick");
    const manifest = { schemaVersion: 1 as const, origin: "offline-fixture" as const, appCommit: "fixture", fixtureSha256: "fixture", matrix: "quick" as const,
      createdAt: "2026-09-30T00:00:00.000Z", profile: "fixture", rows: matrix.map(item => ({ ...row(item.key), status: "launching" as const })) };
    const backend = {} as EvaluationBackend;
    await expect(runEvaluation(matrix, manifest, backend, () => {})).rejects.toThrow("No automatic replay");
  });

  test("hand-built counts preserve denominators, medians, failed outcomes and unknown old coverage", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE observations(role TEXT); INSERT INTO observations VALUES ('firsthand'),('measured'),('vendor'),('vendor');");
      const evidenceMix = Object.fromEntries((db.query("SELECT role, count(*) AS count FROM observations GROUP BY role").all() as Array<{ role: string; count: number }>).map(value => [value.role, value.count]));
      const first = { ...row("a"), status: "finished" as const, outcome: "no-qualifying-ideas", metrics: { ...metrics(), evidenceMix } };
      const second = { ...row("b"), status: "finished" as const, outcome: "failed", metrics: { ...metrics(), candidateFunnel: { ...metrics().candidateFunnel, confirmed: 2 }, modelCalls: 5 } };
      const summary = summarizeEvaluation([first, second])[0]!;
      expect(summary.medianConfirmed).toBe(1);
      expect(summary.medianFirsthandMeasuredShare).toBe(0.5);
      expect(summary.medianVendorAdviceIllustrationShare).toBe(0.5);
      expect(summary.medianCommunitySourceShare).toBe(0.25);
      expect(summary.medianModelCalls).toBe(4);
      expect(summary.medianConfirmedAreas).toBeNull();
      expect(summary.medianMustHaveFailures).toBeNull();
      expect(summary.failedRuns).toBe(1);
      expect(summary.zeroIdeaRuns).toBe(2);
      expect(summarizeEvaluation([{ ...first, status: "running" }])[0]!.medianConfirmed).toBeNull();
      expect(median([null, null])).toBeNull();
      expect(median([0, null, 2])).toBe(1);
    } finally { db.close(); }
  });
});
