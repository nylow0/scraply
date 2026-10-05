import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePromptPaths } from "../../src/core/prompts";
import { generateResearchFrame } from "../../src/core/research-frame";
import { WorkflowExecution } from "../../src/core/workflow-execution";
import { ResearchEngine } from "../../src/core/research-engine";
import { DiscoveryRepository } from "../../src/db/repositories/discovery";
import { ResearchFrameRepository } from "../../src/db/repositories/research-frames";
import { DatabaseClient } from "../../src/db/client";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { WorkflowV2ContextMismatchError } from "../../src/db/repositories/workflow-v2";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import { deriveJsonSchema } from "../../src/shared/json-schema";
import { ResearchFrameOutputSchema, type ResearchFrame } from "../../src/shared/research-frame";
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

test("a valid completed legacy frame checkpoint resumes with its saved schema and no client call", async () => {
  const fixture = recoveryFixture();
  let calls = 0;
  let originalRequest: StructuredStageRequest<unknown> | undefined;
  try {
    const provider: StructuredModelClient = { structuredCompletion: async (request) => {
      calls++;
      originalRequest = request;
      fixture.completeLegacy(request, true);
      throw new Error("Process ended before saving the research frame");
    } };
    await expect(fixture.generate(provider)).rejects.toThrow("Process ended");
    const originalAttempt = fixture.db.db.prepare("SELECT * FROM generation_attempts").get();
    const originalStage = fixture.db.db.prepare("SELECT * FROM stage_results").get();

    const result = await fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run"));

    expect(result).toEqual({ frame, sources: [source] });
    expect(calls).toBe(1);
    expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").get()).toEqual(originalAttempt);
    expect(fixture.db.db.prepare("SELECT * FROM stage_results").get()).toEqual(originalStage);
    await expect(fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run"), { ...scope, domain: "Different scope" }))
      .rejects.toThrow(WorkflowV2ContextMismatchError);
    await expect(fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run"), scope, { ...model, modelId: "other-model" }))
      .rejects.toThrow(WorkflowV2ContextMismatchError);
    if (!originalRequest) throw new Error("The original request was not captured");
    const changedEvidence = { ...originalRequest, generationId: "changed-evidence", evidence: [],
      workOrder: { ...originalRequest.workOrder, inputs: (originalRequest.workOrder.inputs as { routing: Record<string, unknown> }).routing },
      schema: ResearchFrameOutputSchema, jsonSchema: deriveJsonSchema(ResearchFrameOutputSchema) };
    await expect(new WorkflowExecution(fixture.db, "frame-run").discoveryClient(provider).structuredCompletion(changedEvidence))
      .rejects.toThrow(WorkflowV2ContextMismatchError);
    expect(calls).toBe(1);
    expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").get()).toEqual(originalAttempt);
    expect(fixture.db.db.prepare("SELECT * FROM stage_results").get()).toEqual(originalStage);
  } finally { fixture.close(); }
});

test("a completed legacy frame generation saved before stage commit is recovered without dispatching again", async () => {
  const fixture = recoveryFixture();
  let calls = 0;
  try {
    const provider: StructuredModelClient = { structuredCompletion: async (request) => {
      calls++;
      if (calls > 1) throw new Error("Completed frame work must not dispatch again");
      fixture.completeLegacy(request, false);
      throw new Error("Process ended before stage commit");
    } };
    await expect(fixture.generate(provider)).rejects.toThrow("Process ended");
    const originalAttempt = fixture.db.db.prepare("SELECT * FROM generation_attempts").get();
    expect(fixture.workflow.repository.findStageResult("frame-run", "frame")).toBeNull();

    const result = await fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run"));

    expect(result).toEqual({ frame, sources: [source] });
    expect(calls).toBe(1);
    expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").get()).toEqual(originalAttempt);
    expect(fixture.workflow.repository.findStageResult("frame-run", "frame")?.schema).toEqual(historicalFrameSchema());
    const originalStage = fixture.db.db.prepare("SELECT * FROM stage_results").get();
    expect(await fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run"))).toEqual(result);
    expect(calls).toBe(1);
    expect(fixture.db.db.prepare("SELECT * FROM stage_results").get()).toEqual(originalStage);
  } finally { fixture.close(); }
});

test("a historically invalid completed bookkeeper frame stays rejected and immutable", async () => {
  const sourceId = "https://quickbooks.intuit.com/learn-support/en-global/help-article/banking/set-bank-rules-categorise-online-banking-online/L0mjJl0nD_ROW_en";
  const savedSource = { ...source, id: sourceId, url: sourceId };
  const invalidFrame = { ...frame, contextFacts: [{ fact: source.text, sourceIds: [sourceId.slice(0, 128)] }],
    successCriteria: frame.successCriteria.map(criterion => ({ ...criterion, basis: "brief" })),
    constraints: frame.constraints.map(constraint => ({ ...constraint, basis: "brief" })) };
  const fixture = recoveryFixture(savedSource);
  let calls = 0;
  try {
    const provider: StructuredModelClient = { structuredCompletion: async (request) => {
      calls++;
      fixture.completeLegacy(request, true, { frame: invalidFrame });
      throw new Error("Process ended before frame semantic validation");
    } };
    await expect(fixture.generate(provider)).rejects.toThrow("Process ended");
    const originalAttempt = fixture.db.db.prepare("SELECT * FROM generation_attempts").get();
    const originalStage = fixture.db.db.prepare("SELECT * FROM stage_results").get();

    await expect(fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run")))
      .rejects.toThrow(`The frame cites an unknown source: ${sourceId.slice(0, 128)}`);

    expect(calls).toBe(1);
    expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").get()).toEqual(originalAttempt);
    expect(fixture.db.db.prepare("SELECT * FROM stage_results").get()).toEqual(originalStage);
    expect(fixture.workflow.read<Array<typeof source>>("frame-context-sources")).toEqual([savedSource]);
  } finally { fixture.close(); }
});

test.each(["prepared", "known-failed", "unknown"] as const)(
  "authorized recovery preserves the %s old frame request and dispatches full source references", async (status) => {
    const fixture = recoveryFixture();
    let calls = 0;
    let originalId = "";
    try {
      const provider: StructuredModelClient = { structuredCompletion: async (request) => {
        calls++;
        const attempts = new GenerationAttemptRepository(fixture.db);
        if (calls === 1) {
          const original = attempts.prepare("frame-run", { ...request, jsonSchema: historicalFrameSchema() });
          originalId = original.id;
          if (status !== "prepared") attempts.markDispatched(original.id);
          if (status === "known-failed") attempts.recordTerminal(original.id,
            { status: "failed", terminalKind: "provider-failed", attemptMetadata: metadata });
          if (status === "unknown") attempts.interruptInFlight("Process ended without a terminal result");
          throw new Error("Historical request did not complete");
        }
        expect(request.jsonSchema).toEqual(deriveJsonSchema(ResearchFrameOutputSchema));
        const fresh = attempts.prepare("frame-run", request);
        attempts.markDispatched(fresh.id);
        attempts.recordTerminal(fresh.id, { status: "completed", terminalKind: "completed", output: { frame }, attemptMetadata: metadata });
        return { output: request.schema.parse({ frame }), metadata };
      } };
      await expect(fixture.generate(provider)).rejects.toThrow("Historical request did not complete");
      const originalAttempt = fixture.db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(originalId);
      if (status === "unknown") {
        for (const acknowledgments of [[], ["another-attempt"]]) {
          await expect(fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run", acknowledgments)))
            .rejects.toThrow("Review this request before explicitly retrying it");
        }
        expect(calls).toBe(1);
        expect(fixture.db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(originalId)).toEqual(originalAttempt);
      }
      // Calling execution represents explicit retry admission; unknown dispatch needs its exact acknowledgment.
      const result = await fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run", status === "unknown" ? [originalId] : []));
      expect(result).toEqual({ frame, sources: [source] });
      expect(calls).toBe(2);
      expect(fixture.db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(originalId)).toEqual(originalAttempt);
      expect(fixture.workflow.repository.findStageResult("frame-run", "frame")?.schema).toEqual(deriveJsonSchema(ResearchFrameOutputSchema));
    } finally { fixture.close(); }
  },
);

test("a committed frame with a foreign schema retains its identity conflict without a client call", async () => {
  const fixture = recoveryFixture();
  let calls = 0;
  try {
    const provider: StructuredModelClient = { structuredCompletion: async (request) => {
      calls++;
      const schema = historicalFrameSchema();
      schema.properties!.frame!.properties!.goal!.maxLength = 3_999;
      fixture.completeLegacy(request, true, { frame }, schema);
      throw new Error("Process ended before saving the research frame");
    } };
    await expect(fixture.generate(provider)).rejects.toThrow("Process ended");
    const originalAttempt = fixture.db.db.prepare("SELECT * FROM generation_attempts").get();
    const originalStage = fixture.db.db.prepare("SELECT * FROM stage_results").get();

    await expect(fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run")))
      .rejects.toThrow(WorkflowV2ContextMismatchError);

    expect(calls).toBe(1);
    expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").get()).toEqual(originalAttempt);
    expect(fixture.db.db.prepare("SELECT * FROM stage_results").get()).toEqual(originalStage);
  } finally { fixture.close(); }
});

test.each(["scope", "schema"] as const)("a completed legacy generation with changed %s is not falsely recovered", async (changed) => {
  const fixture = recoveryFixture();
  let calls = 0;
  const freshFrame = { ...frame, goal: "Fresh frame for the current request" };
  try {
    const provider: StructuredModelClient = { structuredCompletion: async (request) => {
      calls++;
      if (calls === 1) {
        const schema = historicalFrameSchema();
        if (changed === "schema") schema.properties!.frame!.properties!.goal!.maxLength = 3_999;
        fixture.completeLegacy(request, false, { frame }, schema);
        throw new Error("Process ended before stage commit");
      }
      expect(request.jsonSchema).toEqual(deriveJsonSchema(ResearchFrameOutputSchema));
      return { output: request.schema.parse({ frame: freshFrame }), metadata };
    } };
    await expect(fixture.generate(provider)).rejects.toThrow("Process ended");
    const originalAttempt = fixture.db.db.prepare("SELECT * FROM generation_attempts").get();

    const result = await fixture.generate(provider, new WorkflowExecution(fixture.db, "frame-run"),
      changed === "scope" ? { ...scope, domain: "Different scope" } : scope);

    expect(result.frame).toEqual(freshFrame);
    expect(calls).toBe(2);
    expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").get()).toEqual(originalAttempt);
  } finally { fixture.close(); }
});

// The known original wire contract bounded provider references along with entity IDs.
function historicalFrameSchema() {
  const schema = deriveJsonSchema(ResearchFrameOutputSchema);
  const properties = schema.properties!.frame!.properties!;
  properties.contextFacts!.items!.properties!.sourceIds!.items!.maxLength = 128;
  properties.successCriteria!.items!.properties!.basis!.anyOf![1]!.items!.maxLength = 128;
  properties.constraints!.items!.properties!.basis!.anyOf![1]!.items!.maxLength = 128;
  return schema;
}

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
    generate(provider: StructuredModelClient, execution = workflow, requestScope = scope, requestModel = model) {
      return generateResearchFrame(requestScope, false, { workflow: execution, modelClient: execution.discoveryClient(provider),
        search: { async search() { throw new Error("Saved context must not be searched again"); } },
        model: requestModel, reasoningEffort: "medium", signal: new AbortController().signal, onProgress() {} });
    },
    completeLegacy(request: StructuredStageRequest<unknown>, commitStage: boolean, output: unknown = { frame }, schema = historicalFrameSchema()) {
      const savedRequest = { ...request, jsonSchema: schema };
      const attempts = new GenerationAttemptRepository(db);
      const prepared = attempts.prepare("frame-run", savedRequest);
      attempts.markDispatched(prepared.id);
      attempts.recordTerminal(prepared.id, { status: "completed", terminalKind: "completed", output, attemptMetadata: metadata });
      if (commitStage) db.immediateTransaction(() => {
        workflow.commitStage("frame", savedRequest, workflow.resolvePrompt("frame"), metadata, output,
          { inputs: request.workOrder.inputs, evidence: request.evidence });
        workflow.save("metadata:frame", metadata);
      });
      return prepared.id;
    },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
