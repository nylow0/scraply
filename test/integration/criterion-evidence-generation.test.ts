import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceDevelopmentOptions, type WorkflowV2DevelopmentContext } from "../../src/core/development";
import { scheduledModelClient } from "../../src/core/scheduled-model-client";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { ProviderFailure } from "../../src/providers/structured";
import { RuntimeClient } from "../../src/providers/runtime";
import { DatabaseClient } from "../../src/db/client";
import { GenerationAttemptRepository } from "../../src/db/repositories/generation-attempts";
import { z } from "zod";
import { meetsAllMustHaves } from "../../src/shared/solution-goal-fit";
import type { WorkflowV2SolutionOption } from "../../src/shared/structured-output-schemas";
import { ResearchEngine } from "../../src/core/research-engine";
import { WorkflowRepository } from "../../src/db/repositories/workflows";
import { getRunTrace, getRunTraceStep } from "../../src/core/run-trace";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { StructuredModelClient } from "../../src/providers/structured";

const model = { providerId: "openai-subscription", modelId: "gpt-fixture" };
const context: WorkflowV2DevelopmentContext = {
  scope: { title: "Bakery", domain: "Deposits", audience: "Small shop owners", observations: "Disputes repeat", offLimits: [] },
  problem: { id: "problem", statement: "Orders go uncollected", whyItPersists: "A balance remains unpaid", affected: "Owners",
    scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [], verdict: "confirmed", verdictReason: "Owner accounts", verdictSourceIds: ["owner-source"] },
  supportingEvidence: [{ sourceId: "owner-source", content: { quote: "The customer never picked up or paid the balance." } }],
  contraryEvidence: [], priorFailedAttempts: [],
  frame: { goal: "Reduce disputes", goalKind: "process-improvement", contextFacts: [],
    successCriteria: [{ id: "owner-evidence", name: "Grounded in observed disputes or losses", weight: "must", howJudged: "A direct owner account", basis: "brief" },
      { id: "small-team-fit", name: "Fits a small shop team", weight: "high", howJudged: "Check work for 1–3 people", basis: "brief" },
      { id: "pilot-test", name: "Testable with a two-week dispute count", weight: "high", howJudged: "A two-week log", basis: "brief" }],
    constraints: [], areas: [], exclusions: [], openQuestions: [], languages: ["en"] },
};
const option = {
  mechanism: "Record approval and payment before baking", description: "Keep one order card and payment cutoff",
  keyAssumption: "Staff can enforce the cutoff", whyCurrentApproachMaySuffice: "The current shop policy may suffice",
  supportingEvidenceIds: ["owner-source"], contraryEvidenceIds: [], unknowns: ["Team capacity"], respectsOffLimits: true, respectsOffLimitsWhy: "No excluded work",
  biggerProblem: { statement: "Uncollected orders leave unpaid work", affected: "Owners", scale: "Unknown", scaleKnown: false, scaleEvidenceIds: [] },
  slice: { description: "One order card", connectionToBiggerProblem: "Prevent unpaid work", feasibilityWithinConstraints: "Test in one shop" },
  criteriaFit: [
    { criterionId: "owner-evidence", criterionName: "Grounded in observed disputes or losses", mustHave: true,
      status: "meets", evidenceIds: ["owner-source"], note: "A saved owner account documents unpaid work" },
    { criterionId: "small-team-fit", criterionName: "Fits a small shop team", mustHave: false,
      status: "partial", evidenceIds: [], note: "Capacity in a 1–3 person shop has not been tested; the reported bakers’ team sizes are unknown." },
    { criterionId: "pilot-test", criterionName: "Testable with a two-week dispute count", mustHave: false,
      status: "partial", evidenceIds: [], note: "The proposed two-week log can count disputes; enough eligible orders may not occur in that window." },
  ],
  firstTest: { kind: "process-test", question: "Does the cutoff reduce disputes?", method: "Log orders", cost: "One staff hour", metric: "Dispute count",
    sample: 10, observationWindow: "Two weeks", passCriterion: "Fewer disputes", failCriterion: "More disputes", inconclusiveCriterion: "Too few orders" },
} satisfies WorkflowV2SolutionOption;
const corrected = { ...option, criteriaFit: option.criteriaFit.map(fit => fit.evidenceIds.length ? fit : { ...fit, status: "unknown" as const }) };
// What the app saves for `option`, the real Bakery output that used to fail the whole batch.
const repaired = { ...option, criteriaFit: option.criteriaFit.map(fit => fit.evidenceIds.length ? fit
  : { ...fit, status: "unknown" as const, note: `${fit.note} Marked unknown because no saved evidence was cited.` }) };
// Still invalid after app repair, so it exercises schema repair and diagnostics.
const broken = { ...corrected, mechanism: "" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function native(outputs: unknown[], mode = "workflow-criterion-evidence", interruptAt?: number) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-criterion-evidence-"));
  const outputPath = join(directory, "outputs.json");
  const capturePath = join(directory, "requests.jsonl");
  writeFileSync(outputPath, JSON.stringify(outputs));
  const runtime = new RuntimeClient({ executablePath: process.execPath,
    argumentPrefix: [join(process.cwd(), "test/fixtures/runtime-child.cjs")],
    artifact: { version: "0.1.0", sourceCommit: "ab9fcfc859ee19fff8dfd4c05c854ab5d145baf8",
      sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex") },
    appVersion: "test", controlTimeoutMs: 250, terminalGraceMs: 250,
    environment: { ...process.env, SCRAPLY_RUNTIME_CHILD_MODE: mode,
      SCRAPLY_CRITERION_OUTPUTS: outputPath, SCRAPLY_RUNTIME_CAPTURE: capturePath,
      ...(interruptAt === undefined ? {} : { SCRAPLY_CRITERION_INTERRUPT_AT: String(interruptAt) }) } });
  cleanups.push(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, requests: () => readFileSync(capturePath, "utf8").trim().split("\n").map(line => (JSON.parse(line) as { payload: {
    generationId: string; repairPolicy: string; outputSchema: object; workOrder: { constraints?: string[] };
  } }).payload) };
}

async function recordedNative(outputs: unknown[], mode?: string, interruptAt?: number) {
  const fixture = native(outputs, mode, interruptAt);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const directory = mkdtempSync(join(tmpdir(), "scraply-invalid-output-trace-"));
  const db = new DatabaseClient(join(directory, "scraply.db"));
  cleanups.push(async () => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const config = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2 as const, model };
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Bakery','configuring',?,?)").run(now, now);
  db.immediateTransaction(() => new WorkflowRepository(db).createSession({ id: "session", threadId: "thread",
    purpose: "discovery", mode: "vibe", contract: { limits: { enforced: false } }, remainingMs: 60_000 }));
  db.db.prepare(`INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,workflow_session_id,created_at,updated_at)
    VALUES ('run','thread','running',?,2,'session',?,?)`).run(JSON.stringify(config), now, now);
  const engine = new ResearchEngine({ db, modelClients: { [model.providerId]: fixture.runtime },
    modelScheduler: new WorkflowModelScheduler(), onEvent: () => {} });
  const active = { runId: "run", threadId: "thread", problemId: null, config, abortController: new AbortController(),
    startedAt: Date.now(), projectedCodexCalls: 2, projectedSearches: 0,
    followUpModelReservation: null, followUpSearchReservation: null, generationProvenance: new Map<string, string>() };
  // Use the production recorder and scheduled native client without running unrelated research stages.
  const access = engine as unknown as { activeRuns: Map<string, typeof active>;
    instrumentedModel(run: typeof active): StructuredModelClient };
  access.activeRuns.set(active.runId, active);
  const client = access.instrumentedModel(active);
  const dispatchSnapshots: number[] = [];
  const diagnostics = () => db.db.prepare("SELECT * FROM workflow_snapshots WHERE snapshot_key LIKE 'generation-schema-invalid:%' ORDER BY rowid").all();
  const generate = (onSchemaInvalid?: () => void) => produceDevelopmentOptions(context, { modelClient: client, model, reasoningEffort: "medium", ideaCount: 1,
    beforeGeneration: request => {
      request.onDispatched = () => dispatchSnapshots.push(diagnostics().length);
      if (onSchemaInvalid) request.onSchemaInvalid = onSchemaInvalid;
    } });
  const detail = () => {
    const step = getRunTrace(db, "run").steps.find(step => step.stage === "solutions")!;
    return getRunTraceStep(db, "run", step.id);
  };
  const resume = () => { access.activeRuns.clear(); return engine.resumeRun("run"); };
  return { ...fixture, db, generate, diagnostics, dispatchSnapshots, detail, resume };
}

test("confirmed invalid output is durable before native repair and readable in persisted Trace after success", async () => {
  const fixture = await recordedNative([{ options: [broken] }, { options: [corrected] }]);
  await fixture.generate();
  expect(fixture.dispatchSnapshots).toEqual([0, 1]);
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(JSON.stringify(getRunTrace(fixture.db, "run"))).not.toContain(option.mechanism);
  const detail = fixture.detail();
  expect(detail.output).toEqual({ options: [corrected] });
  const invalid = detail.events.find(event => event.type === "schema-validation-failed");
  expect(invalid?.payload).toMatchObject({ output: { options: [broken] }, issues: [{ path: ["options", 0, "mechanism"] }] });
  expect(getRunTrace(fixture.db, "run").metrics.modelCalls).toBe(2);
});

test("both confirmed invalid responses survive terminal failure with exact native UUIDs and actual validation issues", async () => {
  const fixture = await recordedNative([{ options: [broken] }, { options: [broken] }]);
  expect(await fixture.generate().catch((error: unknown) => error)).toMatchObject({ code: "schema" });
  expect(fixture.diagnostics()).toHaveLength(2);
  const failures = fixture.detail().events.filter(event => event.type === "schema-validation-failed");
  expect(failures).toHaveLength(2);
  expect(failures.map(event => (event.payload as { generationId: string }).generationId))
    .toEqual(fixture.requests().map(request => request.generationId));
  expect(fixture.detail().output).toBeNull();
});

test.each(["storage", "callback"])("a diagnostic %s failure preserves the confirmed invalid result and stops repair", async mode => {
  const fixture = await recordedNative([{ options: [broken] }, { options: [corrected] }]);
  if (mode === "storage") fixture.db.db.exec(`CREATE TRIGGER reject_schema_diagnostic BEFORE INSERT ON workflow_snapshots
    WHEN NEW.snapshot_key LIKE 'generation-schema-invalid:%'
    BEGIN SELECT RAISE(ABORT, 'Diagnostic storage unavailable'); END`);
  const failure = await fixture.generate(mode === "callback" ? () => { throw new Error("Diagnostic callback unavailable"); } : undefined)
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "failed", attempts: [{ providerCompletion: "confirmed", usage: { status: "known" } }] });
  expect(fixture.requests()).toHaveLength(1);
  const detail = fixture.detail();
  expect(detail.step.status).toBe("failed");
  expect(detail.events.find(event => event.type === "schema-validation-failed" && (event.payload as { retentionFailed?: boolean }).retentionFailed)?.payload)
    .toMatchObject({ output: { options: [broken] }, retentionFailed: true, issues: [{ path: ["options", 0, "mechanism"] }] });
  expect(getRunTrace(fixture.db, "run").metrics.modelCalls).toBe(1);
  expect(fixture.db.db.prepare("SELECT status, usage_json FROM generation_attempts").get())
    .toEqual({ status: "failed", usage_json: JSON.stringify([{ status: "known", value: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }]) });
});

test("an unknown repair completion retains the first invalid response without replay", async () => {
  const fixture = await recordedNative([{ options: [broken] }], undefined, 1);
  expect(await fixture.generate().catch((error: unknown) => error)).toMatchObject({ code: "interrupted", attempts: [
    { providerCompletion: "confirmed", usage: { status: "known" } },
    { providerCompletion: "unknown", usage: { status: "unknown" } },
  ] });
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(fixture.detail().events.filter(event => event.type === "schema-validation-failed")).toHaveLength(1);
  const saved = fixture.db.db.prepare("SELECT * FROM generation_attempts").all();
  expect(await fixture.resume().catch((error: unknown) => error)).toMatchObject({ code: "conflict" });
  expect(fixture.requests()).toHaveLength(2);
  expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").all()).toEqual(saved);
  expect(getRunTrace(fixture.db, "run").metrics.modelCalls).toBe(2);
});

test("valid cached output keeps its saved identity and app diagnostics stay outside the native wire request", async () => {
  const fixture = await recordedNative([{ options: [corrected] }]);
  await fixture.generate();
  const saved = fixture.db.db.prepare("SELECT * FROM generation_attempts").all();
  await fixture.generate();
  expect(fixture.requests()).toHaveLength(1);
  expect(JSON.stringify(fixture.requests())).not.toContain("onSchemaInvalid");
  expect(fixture.diagnostics()).toHaveLength(0);
  expect(fixture.db.db.prepare("SELECT * FROM generation_attempts").all()).toEqual(saved);
  expect(fixture.detail().output).toEqual({ options: [corrected] });
});

test("the real Bakery output with uncited partial verdicts is kept as unknown in one call", async () => {
  const fixture = native([{ options: [option] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const result = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1 });
  expect(result.options[0]!.criteriaFit).toEqual(repaired.criteriaFit);
  expect(result.metadata.repairCount).toBe(0);
  expect(fixture.requests()).toHaveLength(1);
  expect(meetsAllMustHaves(result.options[0]!.criteriaFit)).toBe(true);
});

test("schema repair still runs once for output the app cannot repair", async () => {
  const fixture = native([{ options: [broken] }, { options: [corrected] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const result = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1 });
  expect(result.options[0]!.criteriaFit).toEqual(corrected.criteriaFit);
  expect(result.metadata.repairCount).toBe(1);
  expect(result.metadata.attempts.map(attempt => attempt.attempt)).toEqual(["initial", "schema_repair"]);
  expect(result.metadata.usage).toEqual({ status: "known", value: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } });
  const requests = fixture.requests();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.workOrder.constraints?.some(constraint => constraint.includes("prior response"))).toBe(true);
  expect(requests[0]!.outputSchema).toEqual(requests[1]!.outputSchema);
});

test("a second unrepairable response exhausts repair without a third native dispatch", async () => {
  const fixture = native([{ options: [broken] }, { options: [broken] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const failure = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProviderFailure);
  expect(failure).toMatchObject({ code: "schema", attempts: [
    { attempt: "initial", providerCompletion: "confirmed", usage: { status: "known" } },
    { attempt: "schema_repair", providerCompletion: "confirmed", usage: { status: "known" } },
  ] });
  expect(fixture.requests()).toHaveLength(2);
});

const unassessed = { criterionId: "small-team-fit", criterionName: "Fits a small shop team", mustHave: false,
  status: "unknown" as const, evidenceIds: [], note: "The model did not assess this criterion." };
test.each([
  { reason: "known scale without evidence", output: { ...corrected, biggerProblem: { ...corrected.biggerProblem, scaleKnown: true } } },
  { reason: "unknown scale citation", output: { ...corrected, biggerProblem: { ...corrected.biggerProblem, scaleEvidenceIds: ["invented"] } } },
  { reason: "first test named for another goal", output: { ...corrected, firstTest: { ...corrected.firstTest, kind: "pilot" } } },
  { reason: "renamed criterion", output: { ...corrected, criteriaFit: corrected.criteriaFit.map((fit, index) => index ? fit : { ...fit, criterionName: "Invented criterion" }) } },
  { reason: "repeated criterion", output: { ...corrected, criteriaFit: [corrected.criteriaFit[0]!, corrected.criteriaFit[0]!, corrected.criteriaFit[2]!] },
    criteriaFit: [corrected.criteriaFit[0]!, unassessed, corrected.criteriaFit[2]!] as typeof corrected.criteriaFit },
])("the app fills its own goal fields without a model retry ($reason)", async scenario => {
  const fixture = native([{ options: [scenario.output] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const result = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1 });
  expect(result.options[0]!.biggerProblem).toEqual(corrected.biggerProblem);
  expect(result.options[0]!.firstTest).toEqual(corrected.firstTest);
  expect(result.options[0]!.criteriaFit).toEqual(scenario.criteriaFit ?? corrected.criteriaFit);
  expect(result.metadata.repairCount).toBe(0);
  expect(fixture.requests()).toHaveLength(1);
});

test("explicit unknown criterion fit remains unknown with one completed native attempt", async () => {
  const unknown = { ...corrected, criteriaFit: corrected.criteriaFit.map(fit => ({ ...fit, status: "unknown" as const, evidenceIds: [] })) };
  const fixture = native([{ options: [unknown] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const result = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1 });
  expect(result.options[0]!.criteriaFit).toEqual(unknown.criteriaFit);
  expect(result.metadata.repairCount).toBe(0);
  expect(result.metadata.attempts).toHaveLength(1);
  expect(fixture.requests()).toHaveLength(1);
  expect(meetsAllMustHaves(result.options[0]!.criteriaFit)).toBe(false);
});

test("an uncited must-have verdict becomes unknown and leaves the must-have shortlist", async () => {
  const initial = { ...corrected, criteriaFit: corrected.criteriaFit.map((fit, index) => index ? fit : { ...fit, evidenceIds: [] }) };
  const fixture = native([{ options: [initial] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const result = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1 });
  expect(result.options[0]!.criteriaFit![0]).toMatchObject({ criterionId: "owner-evidence", mustHave: true, status: "unknown", evidenceIds: [] });
  expect(meetsAllMustHaves(result.options[0]!.criteriaFit)).toBe(false);
  expect(result.metadata.repairCount).toBe(0);
  expect(fixture.requests()).toHaveLength(1);
});

test("an explicitly disabled repair allowance rejects invalid output after one confirmed native attempt", async () => {
  const fixture = native([{ options: [broken] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const scheduled = scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery");
  const failure = await produceDevelopmentOptions(context, { model, reasoningEffort: "medium", ideaCount: 1,
    modelClient: { structuredCompletion: request => scheduled.structuredCompletion({ ...request, repairPolicy: "disabled" }) },
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "schema", attempts: [{ providerCompletion: "confirmed", usage: { status: "known" } }] });
  expect(fixture.requests()).toHaveLength(1);
});

test("a lost native completion is not replayed as criterion schema repair", async () => {
  const fixture = native([], "stream-interrupted");
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const failure = await produceDevelopmentOptions(context, {
    modelClient: scheduledModelClient(fixture.runtime, new WorkflowModelScheduler(), "bakery"), model, reasoningEffort: "medium", ideaCount: 1,
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "interrupted", attempts: [{ providerCompletion: "unknown", usage: { status: "unknown" } }] });
  expect(fixture.requests()).toHaveLength(1);
});

test.each([false, true])("completed historical criterion output keeps its wire identity and never dispatches on cache read (needs repair: %s)", async invalid => {
  const fixture = native([{ options: [corrected] }]);
  await fixture.runtime.restoreCredential(model.providerId, "synthetic-credential");
  const generated = await produceDevelopmentOptions(context, { modelClient: fixture.runtime, model, reasoningEffort: "medium", ideaCount: 1 });
  const directory = mkdtempSync(join(tmpdir(), "scraply-criterion-cache-"));
  const db = new DatabaseClient(join(directory, "scraply.db"));
  cleanups.push(async () => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES ('thread','Bakery','configuring',?,?)").run(now, now);
  db.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,workflow_version,created_at,updated_at) VALUES ('run','thread','failed','{}',2,?,?)").run(now, now);
  const repository = new GenerationAttemptRepository(db);
  // App refinements are not part of the persisted native wire identity. This old
  // completion was accepted before the new app-side criterion check was attached.
  const originalRequest = { ...generated.request, schema: z.unknown() };
  const attempt = repository.prepare("run", originalRequest);
  repository.markDispatched(attempt.id);
  const savedOutput = { options: [invalid ? option : corrected] };
  repository.recordTerminal(attempt.id, { status: "completed", terminalKind: "completed", output: savedOutput,
    attemptMetadata: generated.metadata, usage: generated.metadata.attempts.map(item => item.usage) });
  const originalRow = db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(attempt.id);
  let cachedGenerationId: string | undefined;
  const resumed = produceDevelopmentOptions(context, { model, reasoningEffort: "medium", ideaCount: 1,
    modelClient: { async structuredCompletion(request) {
      expect(request.jsonSchema).toEqual(originalRequest.jsonSchema);
      expect(request.workOrder).toEqual(originalRequest.workOrder);
      expect(request.evidence).toEqual(originalRequest.evidence);
      const cached = repository.findCompleted("run", request);
      if (!cached) throw new Error("Historical wire identity changed");
      cachedGenerationId = cached.generationId;
      return { output: cached.output, metadata: generated.metadata };
    } } });
  // A saved completion that failed only on app-owned fields is repaired on read; the saved row stays untouched.
  const recovered = await resumed;
  expect(recovered.options[0]!.criteriaFit).toEqual(invalid ? repaired.criteriaFit : corrected.criteriaFit);
  expect(cachedGenerationId).toBe(originalRequest.generationId);
  expect(fixture.requests()).toHaveLength(1);
  expect(db.db.prepare("SELECT * FROM generation_attempts WHERE id = ?").get(attempt.id)).toEqual(originalRow);
  expect(db.db.prepare("SELECT count(*) AS count FROM generation_attempts").get()).toEqual({ count: 1 });
});
