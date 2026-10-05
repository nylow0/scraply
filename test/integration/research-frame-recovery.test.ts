import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths } from "../../src/core/prompts";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { ResearchEngine } from "../../src/core/research-engine";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { DatabaseClient } from "../../src/db/client";
import type { StructuredModelClient } from "../../src/providers/structured";
import type { ResearchFrame } from "../../src/shared/research-frame";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { sha256 } from "../../src/shared/content-identity";

const model = { providerId: "test", modelId: "test" };
const source = { id: "saved-source", url: "https://source.example/rules", title: "Bank rules", text: "Bank rules apply in priority order." };
const scope = { title: "Bookkeeping", domain: "Bank rules", audience: "Bookkeepers", observations: "", offLimits: [] };
const frame: ResearchFrame = { goal: "Improve reconciliation", goalKind: "process-improvement",
  contextFacts: [{ fact: source.text, sourceIds: [source.id] }],
  successCriteria: [{ id: "rules", name: "Use existing rules", weight: "must", howJudged: "Inspect the existing rule workflow", basis: [source.id] }],
  constraints: [{ text: "Work alongside bank rules", kind: "scope", basis: [source.id] }],
  languages: ["en"], exclusions: [], openQuestions: [],
  areas: [{ id: "matching", name: "Matching exceptions", whyRelevant: "A reconciliation workflow", affectedPeople: "Bookkeepers",
    venues: [{ name: "Bookkeeping community", kind: "community" }], exampleProblems: [], included: true, priority: 1 }] };
const metadata = { model, usage: { status: "unknown" as const }, latencyMs: 1, repairCount: 0,
  providerRequestIds: [], attempts: [], prompt: { id: "fixture", sha256: "a".repeat(64) } };

test.each(["empty", "saved-candidate", "pending-candidates"] as const)(
  "a pre-investigator framed run resumes its frozen path with %s research", async checkpoint => {
    const fixture = recoveryFixture();
    const { db, workflow } = fixture;
    const calls: string[] = [];
    const errors: string[] = [];
    const provider: StructuredModelClient = { async structuredCompletion(request) {
      calls.push(request.stage);
      expect(request.stage.startsWith("problem-candidates:")).toBe(true);
      expect(request.workOrder.instruction).toStartWith("Frozen pre-investigator prompt\n");
      request.onDispatched?.();
      return { output: request.schema.parse({ problems: [] }), metadata };
    } };
    const engine = new ResearchEngine({ db, modelClients: { test: provider }, searchClients: {},
      onEvent(event) { if (event.type === "run-failed") errors.push(event.error); } });
    try {
      const stages = ["frame-search-plan", "frame", "area-ranking", "query-plan", "factor-harvest", "problem-candidates",
        "problem-kill", "solutions", "solution-set-review", "idea-follow-up", "risk-evaluation", "decision-analysis"] as const;
      const frozen = Object.fromEntries(stages.map(stage => {
        const prompt = workflow.resolvePrompt(stage);
        const text = `Frozen pre-investigator prompt\n${prompt.text}`;
        return [stage, { ...prompt, text, resolvedSha256: sha256(text) }];
      }));
      db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = 'frame-run' AND snapshot_key = 'prompts'")
        .run(JSON.stringify(frozen));
      for (const key of ["bounded-follow-up-harvest", "parallel-research", "labeled-factors", "medium-reads", "medium-synthesis"]) {
        db.db.prepare("DELETE FROM workflow_snapshots WHERE research_run_id = 'frame-run' AND snapshot_key = ?").run(key);
      }
      db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = 'frame-run' AND snapshot_key = 'source-routes'")
        .run('{"version":1}');
      workflow.save("frame-workflow", { version: 1 });
      const savedPrompts = db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = 'frame-run' AND snapshot_key = 'prompts'").get();
      db.db.prepare("UPDATE research_runs SET config_json = ? WHERE id = 'frame-run'")
        .run(JSON.stringify({ ...DEFAULT_RUN_CONFIG, model }));
      const discovery = new DiscoveryRepository(db);
      discovery.persistScope("frame-run", scope);
      const frames = new ResearchFrameRepository(db);
      const savedFrame = frames.createDraft({ threadId: "project", runId: "frame-run", frame, sources: [source], knownProblem: false });
      frames.approve(savedFrame.id, "project", frame);
      const area = frame.areas[0]!;
      const harvestedSource = { ...source, canonicalUrl: source.url, providerSourceId: source.id, retrievedText: source.text,
        author: null, publishedAt: null, contentHash: sha256(source.text), retrievedAt: new Date().toISOString() };
      const factor = { id: "old-factor", sourceId: source.id, source: harvestedSource, subject: "Bookkeeper", behavior: "Applies bank rules",
        quote: source.text, harvestMode: "domain" as const, modelConfidence: 0.8, uncertainty: null, sourceRole: "firsthand" as const,
        audienceFit: "intended-buyer" as const, independentSourceKey: "bookkeeper", supportsDemand: false, demandEvidenceUncertainty: null };
      discovery.persistFactors("frame-run", [harvestedSource], [factor]);
      workflow.save(`frame-scan:${area.id}`, { areaId: area.id, qualifyingFacts: 1, sources: [harvestedSource], factors: [factor] });
      workflow.save("frame-selected-areas", [area]);
      workflow.save(`area:${area.id}:harvest`, { sources: [harvestedSource], factors: [factor] });
      if (checkpoint !== "pending-candidates") workflow.save(`area:${area.id}:problems`, {
        problems: checkpoint === "saved-candidate" ? [{ id: "old-problem", statement: "Bookkeepers repeat bank-rule setup",
          whyItPersists: "Each bank uses a separate rule list", affected: "Bookkeepers", scaleEstimate: "Unknown",
          scaleBasisFactorId: factor.id, factorIds: [factor.id], factors: [factor], verdict: "insufficient-evidence",
          verdictReason: "Only one saved account", verdictSourceIds: [source.id], sourceHostnames: ["source.example"], singleHarvestModeWarning: true }] : [],
        killSources: [], blockedCandidates: [], factorUtilizationRate: 0,
      });

      await engine.resumeRun("frame-run");
      const deadline = Date.now() + 5_000;
      while (engine.getActiveRunIds().size > 0 && Date.now() < deadline) await Bun.sleep(5);

      expect(engine.getActiveRunIds().size).toBe(0);
      expect(errors).toEqual([]);
      expect(db.db.prepare("SELECT status FROM research_runs WHERE id = 'frame-run'").get()).toEqual({ status: "completed" });
      expect(calls).toHaveLength(checkpoint === "pending-candidates" ? 1 : 0);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE discovery_run_id = 'frame-run'").get())
        .toEqual({ count: checkpoint === "saved-candidate" ? 1 : 0 });
      expect(db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = 'frame-run' AND snapshot_key = 'prompts'").get()).toEqual(savedPrompts);
      expect(workflow.read("discovery-completed")).not.toBeNull();
      expect(workflow.read(`area:${area.id}:investigation-completed`)).toBeNull();
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM workflow_work_items").get()).toEqual({ count: 0 });
    } finally { await engine.shutdown(); fixture.close(); }
  });

test("legacy areas reconcile overlapping contrary sources without changing their frozen verdict packets", async () => {
  const fixture = recoveryFixture();
  const { db, workflow } = fixture;
  const errors: string[] = [];
  const engine = new ResearchEngine({ db, modelClients: { test: { async structuredCompletion() { throw new Error("Completed legacy packets must not dispatch"); } } },
    onEvent(event) { if (event.type === "run-failed") errors.push(event.error); } });
  try {
    const prompts = workflow.read<Record<string, unknown>>("prompts")!;
    delete prompts["area-gap"]; delete prompts["evidence-check"];
    db.db.prepare("UPDATE workflow_snapshots SET value_json = ? WHERE research_run_id = 'frame-run' AND snapshot_key = 'prompts'").run(JSON.stringify(prompts));
    db.db.prepare("DELETE FROM workflow_snapshots WHERE research_run_id = 'frame-run' AND snapshot_key = 'source-routes'").run();
    db.db.prepare("UPDATE research_runs SET config_json = ? WHERE id = 'frame-run'").run(JSON.stringify({ ...DEFAULT_RUN_CONFIG, model }));
    const areas = [frame.areas[0]!, { ...frame.areas[0]!, id: "history", name: "History", priority: 2 }];
    const approved = { ...frame, areas };
    const frames = new ResearchFrameRepository(db);
    const saved = frames.createDraft({ threadId: "project", runId: "frame-run", frame: approved, sources: [source], knownProblem: false });
    frames.approve(saved.id, "project", approved);
    const discovery = new DiscoveryRepository(db);
    discovery.persistScope("frame-run", scope);
    const originalSource = { ...source, canonicalUrl: source.url, providerSourceId: source.id, retrievedText: source.text,
      author: null, publishedAt: null, contentHash: sha256(source.text), retrievedAt: new Date().toISOString() };
    const contraryText = "Bank rules already address this workflow.";
    for (const area of areas) {
      const factor = { id: `factor-${area.id}`, sourceId: source.id, source: originalSource, subject: "Bookkeeper", behavior: "Applies bank rules",
        quote: source.text, harvestMode: "domain" as const, modelConfidence: 0.8, sourceRole: "firsthand" as const, audienceFit: "intended-buyer" as const,
        independentSourceKey: "owner", supportsDemand: false };
      discovery.persistFactors("frame-run", [originalSource], [factor]);
      workflow.save(`frame-scan:${area.id}`, { areaId: area.id, qualifyingFacts: 1, sources: [originalSource], factors: [factor] });
      workflow.save(`area:${area.id}:harvest`, { sources: [originalSource], factors: [factor] });
      const contrary = { ...originalSource, id: `contrary-${area.id}`, canonicalUrl: "https://source.example/contrary", url: "https://source.example/contrary",
        retrievedText: contraryText, contentHash: sha256(contraryText) };
      workflow.save(`area:${area.id}:problems`, { problems: [{ id: `problem-${area.id}`, statement: `Bookkeepers repeat ${area.id} setup`,
        whyItPersists: "Each bank uses a separate rule list", affected: "Bookkeepers", scaleEstimate: "Unknown", scaleBasisFactorId: factor.id,
        factorIds: [factor.id], factors: [factor], verdict: "confirmed", verdictReason: "Frozen legacy verdict", verdictSourceIds: [contrary.id],
        sourceHostnames: ["source.example"], singleHarvestModeWarning: true }], killSources: [contrary], blockedCandidates: [], factorUtilizationRate: 1 });
    }
    workflow.save("frame-workflow", { version: 1 }); workflow.save("frame-selected-areas", areas);
    const packets = db.db.prepare("SELECT snapshot_key,value_json FROM workflow_snapshots WHERE research_run_id = 'frame-run' AND snapshot_key LIKE 'area:%' ORDER BY snapshot_key").all();

    await engine.resumeRun("frame-run");
    const deadline = Date.now() + 5_000;
    while (engine.getActiveRunIds().size > 0 && Date.now() < deadline) await Bun.sleep(5);

    expect(engine.getActiveRunIds().size).toBe(0);
    expect(errors).toEqual([]);
    expect(db.db.prepare("SELECT status FROM research_runs WHERE id = 'frame-run'").get()).toEqual({ status: "completed" });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE research_run_id = 'frame-run'").get()).toEqual({ count: 2 });
    expect(db.db.prepare("SELECT verdict FROM problems WHERE discovery_run_id = 'frame-run' ORDER BY id").all())
      .toEqual([{ verdict: "confirmed" }, { verdict: "confirmed" }]);
    expect(db.db.prepare("SELECT source_id FROM problem_verdict_sources WHERE research_run_id = 'frame-run' ORDER BY problem_id").all())
      .toEqual([{ source_id: "contrary-matching" }, { source_id: "contrary-matching" }]);
    expect(db.db.prepare("SELECT snapshot_key,value_json FROM workflow_snapshots WHERE research_run_id = 'frame-run' AND snapshot_key LIKE 'area:%' ORDER BY snapshot_key").all()).toEqual(packets);
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { await engine.shutdown(); fixture.close(); }
});

function recoveryFixture(savedSource = source) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-frame-recovery-"));
  configurePromptPaths({ bundledDir: join(process.cwd(), "prompts"), overrideDir: null });
  const db = new DatabaseClient(join(directory, "test.db"));
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('project','Bookkeeping','configuring',?,?)").run(now, now);
  db.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,created_at,updated_at) VALUES ('frame-run','project','running',?,2,?,?)")
    .run(JSON.stringify(DEFAULT_RUN_CONFIG), now, now);
  const workflow = new WorkflowExecution(db, "frame-run");
  workflow.save("frame-context-sources", [savedSource]);
  return { db, workflow,
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
