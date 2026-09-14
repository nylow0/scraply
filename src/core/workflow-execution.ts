import { createHash } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { DevelopmentRepository } from "../db/repositories/development";
import { WorkflowV2Repository, canonicalJson } from "../db/repositories/workflow-v2";
import type { SearchClient } from "../providers/search";
import type { GenerationMetadata, StructuredModelClient, StructuredStageRequest } from "../providers/structured";
import { deriveJsonSchema } from "../shared/json-schema";
import { SourceSchema } from "../shared/schemas";
import { WorkflowV2QueryPlanOutputSchema, WorkflowV2FactorHarvestOutputSchema, WorkflowV2ProblemCandidatesOutputSchema, WorkflowV2ProblemKillOutputSchema, WorkflowV2SolutionsOutputSchema } from "../shared/structured-output-schemas";
import type { WorkflowV2DevelopmentContext } from "./development";
import { resolveWorkflowV2Prompt, type ResolvedWorkflowV2Prompt } from "./prompts";
import { WORKFLOW_V2_STAGE_IDS, WORKFLOW_V2_STAGE_REGISTRY, type WorkflowV2StageId } from "./stages";

/** Run-local snapshots never reuse fresh web results or prompt overrides across runs. */
export class WorkflowExecution {
  readonly repository: WorkflowV2Repository;
  private readonly prompts: Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>;
  private readonly factorUncertainty = new Map<string, string>();
  private readonly pendingStages = new Map<string, {
    stageId: WorkflowV2StageId;
    request: StructuredStageRequest<unknown>;
    prompt: ResolvedWorkflowV2Prompt;
    metadata: GenerationMetadata;
    output: unknown;
    context: unknown;
    selectionId: string | null;
  }>();

  constructor(private readonly db: DatabaseClient, readonly runId: string) {
    this.repository = new WorkflowV2Repository(db);
    const saved = this.read<Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>>("prompts");
    this.prompts = saved ?? Object.fromEntries(WORKFLOW_V2_STAGE_IDS.map((stage) => [stage, resolveWorkflowV2Prompt(stage)])) as Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>;
    if (!saved) {
      this.save("prompts", this.prompts);
      // 96-bit deterministic identifiers are easier for models to copy than full SHA-256 text.
      // Save the format per run: an older run without this marker must still reproduce its IDs.
      this.save("identifier-characters", 24);
    }
  }

  resolvePrompt = (stage: WorkflowV2StageId): ResolvedWorkflowV2Prompt => this.prompts[stage];

  // Older runs keep their original six-stage contract when resumed.
  hasRiskEvaluator(): boolean {
    return Boolean(this.prompts["risk-evaluation"]);
  }

  read<T>(key: string): T | null {
    const row = this.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = ?")
      .get(this.runId, key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : null;
  }

  save(key: string, value: unknown): void {
    const json = canonicalJson(value);
    const existing = this.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = ?")
      .get(this.runId, key) as { value_json: string } | undefined;
    if (existing && existing.value_json !== json) throw new Error(`Run snapshot ${key} cannot change. Start a new run.`);
    if (!existing) this.db.db.prepare("INSERT INTO workflow_snapshots VALUES (?, ?, ?)").run(this.runId, key, json);
  }

  // Deterministic IDs make a replay of saved search/stage outputs refer to the same source/factor IDs.
  idFactory(phase: string): () => string {
    let sequence = 0;
    const characters = this.read<number>("identifier-characters") ?? 64;
    if (characters !== 24 && characters !== 64) throw new Error("Unsupported saved identifier format");
    return () => createHash("sha256").update(`${this.runId}:${phase}:${sequence++}`).digest("hex").slice(0, characters);
  }

  search(client: Pick<SearchClient, "search"> & Partial<Pick<SearchClient, "provider">>): Pick<SearchClient, "search"> & Partial<Pick<SearchClient, "provider">> {
    return { ...(client.provider ? { provider: client.provider } : {}), search: async (query, options) => {
      options?.signal?.throwIfAborted();
      const { signal: _signal, ...parameters } = options ?? {};
      void _signal;
      const key = `search:${createHash("sha256").update(canonicalJson({ query, parameters })).digest("hex")}`;
      const saved = this.read<unknown>(key);
      if (saved) return SourceSchema.array().parse(saved);
      const results = await client.search(query, options);
      options?.signal?.throwIfAborted();
      this.save(key, results);
      return results;
    } };
  }

  discoveryClient(client: StructuredModelClient): StructuredModelClient {
    return { structuredCompletion: async <T>(original: StructuredStageRequest<T>) => {
      const [id, ...selection] = original.stage.split(":");
      if (!WORKFLOW_V2_STAGE_IDS.includes(id as WorkflowV2StageId)) throw new Error(`Unknown stage ${id}`);
      const stageId = id as WorkflowV2StageId;
      const stage = WORKFLOW_V2_STAGE_REGISTRY[stageId];
      const prompt = this.resolvePrompt(stageId);
      const factorLimit = stageId === "factor-harvest"
        ? Number((original.workOrder.inputs as { factorLimit?: unknown }).factorLimit)
        : Number.NaN;
      const requestSchema = stageId === "factor-harvest" && Number.isInteger(factorLimit) && factorLimit >= 0
        ? WorkflowV2FactorHarvestOutputSchema.extend({
            factors: WorkflowV2FactorHarvestOutputSchema.shape.factors.max(factorLimit),
          })
        : stage.schema;
      const request: StructuredStageRequest<unknown> = {
        ...original,
        workOrder: { ...original.workOrder, instruction: prompt.text, inputs: { routing: original.workOrder.inputs, workflowVersion: 2 } },
        schema: requestSchema,
        jsonSchema: deriveJsonSchema(requestSchema),
        deadlineMs: stage.deadlineMs,
      };
      if (original.model.providerId === "openai-subscription") delete request.maxOutputTokens;
      else request.maxOutputTokens = stage.maxOutputTokens;
      const context = { inputs: request.workOrder.inputs, evidence: request.evidence };
      const selectionId = selection.join(":") || null;
      const evidence = request.evidence.map((item) => ({ sourceId: item.sourceId, content: item.content }));
      const previous = this.repository.getStageResumeState({
        researchRunId: this.runId,
        stageId,
        selectionId,
        context,
        identity: { promptSha256: prompt.resolvedSha256, schema: request.jsonSchema, inputs: request.workOrder.inputs, evidence },
      });
      if (previous.kind === "unknown-completion") throw new Error("A generation may have completed before interruption. Start a new run to avoid replaying it.");
      const recovered = previous.kind === "not-started"
        ? this.recoverCompletedStage(request)
        : null;
      let output: unknown;
      let metadata: GenerationMetadata;
      if (previous.kind === "reusable") {
        output = previous.result.output;
        const savedMetadata = this.read<GenerationMetadata>(`metadata:${original.stage}`);
        if (!savedMetadata) throw new Error("Checkpoint metadata is missing");
        metadata = savedMetadata;
      } else if (recovered) {
        output = recovered.output;
        metadata = recovered.metadata;
        assertDiscoveryStageSemantics(stageId, output, original);
        this.persistCompletedStage(original.stage, stageId, request, prompt, metadata, output, context, selectionId);
      } else {
        const completion = await client.structuredCompletion(request);
        output = requestSchema.parse(completion.output);
        metadata = completion.metadata;
        assertDiscoveryStageSemantics(stageId, output, original);
        // Each validated provider result is its own durable replay boundary. Domain rows may be
        // persisted later, but a restart must not repeat completed model work.
        this.persistCompletedStage(original.stage, stageId, request, prompt, metadata, output, context, selectionId);
      }
      if (stageId === "factor-harvest") {
        for (const factor of WorkflowV2FactorHarvestOutputSchema.parse(output).factors) {
          this.factorUncertainty.set(factorIdentity(factor), factor.uncertainty);
        }
      }
      // Discovery keeps its deterministic search and quote checks while retaining v2 evidence labels.
      let adapted: unknown = output;
      if (stageId === "query-plan") adapted = { queries: WorkflowV2QueryPlanOutputSchema.parse(output).queries };
      if (stageId === "factor-harvest") adapted = {
        factors: WorkflowV2FactorHarvestOutputSchema.parse(output).factors.map((factor) => "sourceRole" in factor ? factor : {
          ...factor,
          sourceRole: "unknown" as const,
          audienceFit: "unknown" as const,
          independentSourceKey: null,
          supportsDemand: false,
          demandEvidenceUncertainty: "Not classified in the saved output.",
        }),
      };
      if (stageId === "problem-candidates") adapted = { problems: WorkflowV2ProblemCandidatesOutputSchema.parse(output).problems.map(({ alternativeExplanations, unknowns, ...problem }) => { void alternativeExplanations; void unknowns; return problem; }) };
      if (stageId === "problem-kill") {
        const { unresolvedAssumptions, wouldChangeConclusion, ...assessment } = WorkflowV2ProblemKillOutputSchema.parse(output);
        void unresolvedAssumptions; void wouldChangeConclusion;
        adapted = assessment;
      }
      return { output: original.schema.parse(adapted), metadata };
    } };
  }

  private recoverCompletedStage(request: StructuredStageRequest<unknown>): {
    output: unknown;
    metadata: GenerationMetadata;
  } | null {
    const rows = this.db.db.prepare(`
      SELECT request_json, output_json, attempt_metadata_json
      FROM generation_attempts
      WHERE research_run_id = ? AND stage_key = ? AND status = 'completed'
      ORDER BY terminal_at DESC
    `).all(this.runId, request.stage) as Array<{
      request_json: string;
      output_json: string;
      attempt_metadata_json: string;
    }>;
    const expected = completedAttemptIdentity(request);
    for (const row of rows) {
      const savedRequest = JSON.parse(row.request_json) as Record<string, unknown>;
      if (canonicalJson(completedAttemptIdentity(savedRequest)) !== canonicalJson(expected)) continue;
      const output = request.schema.parse(JSON.parse(row.output_json));
      const metadata = JSON.parse(row.attempt_metadata_json) as GenerationMetadata;
      if (!metadata.prompt) continue;
      return { output, metadata };
    }
    if (request.stage.startsWith("factor-harvest:")) {
      const earlier = this.db.db.prepare(`
        SELECT request_json, output_json, attempt_metadata_json
        FROM generation_attempts
        WHERE research_run_id = ? AND stage_key LIKE 'factor-harvest:%' AND status = 'completed'
        ORDER BY terminal_at DESC
      `).all(this.runId) as typeof rows;
      for (const row of earlier) {
        const savedRequest = JSON.parse(row.request_json) as Record<string, unknown>;
        const sourceIds = recoverableFactorPartitionSourceIds(request, savedRequest);
        if (!sourceIds) continue;
        const parsed = WorkflowV2FactorHarvestOutputSchema.safeParse(JSON.parse(row.output_json));
        if (!parsed.success) continue;
        const output = request.schema.safeParse({ factors: parsed.data.factors.filter((factor) => sourceIds.has(factor.sourceId)) });
        if (!output.success) continue;
        const metadata = JSON.parse(row.attempt_metadata_json) as GenerationMetadata;
        if (!metadata.prompt) continue;
        return { output: output.data, metadata };
      }
    }
    return null;
  }

  private persistCompletedStage(
    stageKey: string,
    stageId: WorkflowV2StageId,
    request: StructuredStageRequest<unknown>,
    prompt: ResolvedWorkflowV2Prompt,
    metadata: GenerationMetadata,
    output: unknown,
    context: unknown,
    selectionId: string | null,
  ): void {
    this.db.immediateTransaction(() => {
      this.commitStage(stageId, request, prompt, metadata, output, context, selectionId);
      this.save(`metadata:${stageKey}`, metadata);
    });
  }

  /** Caller invokes this inside the same transaction that persists the validated domain rows. */
  flushPendingStages(stageIds: readonly WorkflowV2StageId[]): void {
    this.db.requireImmediateTransaction();
    const allowed = new Set(stageIds);
    for (const [stageKey, pending] of this.pendingStages) {
      if (!allowed.has(pending.stageId)) continue;
      this.commitStage(
        pending.stageId,
        pending.request,
        pending.prompt,
        pending.metadata,
        pending.output,
        pending.context,
        pending.selectionId,
      );
      this.save(`metadata:${stageKey}`, pending.metadata);
      this.pendingStages.delete(stageKey);
    }
  }

  withFactorUncertainty<T extends { sourceId: string; subject: string; quote: string }>(factors: T[]): Array<T & { uncertainty?: string }> {
    return factors.map((factor) => {
      const value = this.factorUncertainty.get(factorIdentity(factor));
      return value ? { ...factor, uncertainty: value } : factor;
    });
  }

  commitStage<T>(stageId: WorkflowV2StageId, request: StructuredStageRequest<T>, prompt: ResolvedWorkflowV2Prompt,
    metadata: GenerationMetadata, output: unknown, context: unknown, selectionId: string | null = null) {
    if (!metadata.prompt) throw new Error("The model provider did not identify its prompt compiler");
    return this.repository.saveStageResult({
      researchRunId: this.runId, stageId, selectionId, context, output, prompt,
      schema: request.jsonSchema, inputs: request.workOrder.inputs, evidence: request.evidence.map((item) => ({ sourceId: item.sourceId, content: item.content })),
      runtimePrompt: metadata.prompt,
      effectiveRequest: {
        model: request.model, reasoningEffort: request.reasoningEffort, workOrder: request.workOrder,
        evidence: request.evidence, jsonSchema: request.jsonSchema, repairPolicy: request.repairPolicy,
        deadlineMs: request.deadlineMs, ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      },
    });
  }

  developmentContext(problemId: string): WorkflowV2DevelopmentContext {
    const saved = this.read<WorkflowV2DevelopmentContext>("development-context");
    if (saved) return saved;
    const base = new DevelopmentRepository(this.db).loadContext(problemId);
    if (!base) throw new Error("The selected problem is missing");
    const row = this.db.db.prepare("SELECT discovery_run_id FROM problems WHERE id = ?").get(problemId) as { discovery_run_id: string };
    const stageEvidence = this.db.db.prepare("SELECT stage_id, context_json, output_json FROM stage_results WHERE research_run_id = ? AND stage_id IN ('factor-harvest', 'problem-candidates', 'problem-kill')")
      .all(row.discovery_run_id) as Array<{ stage_id: string; context_json: string; output_json: string }>;
    const sourceIds = [...new Set([...base.factors.map((factor) => factor.sourceId), ...base.problem.verdictSourceIds])];
    const sources = new Map(sourceIds.map((id) => {
      const source = this.db.db.prepare("SELECT id, title, canonical_url AS url, retrieved_text AS text FROM sources WHERE id = ?").get(id);
      return [id, source];
    }));
    const uncertaintyByFactor = new Map(stageEvidence.filter((stage) => stage.stage_id === "factor-harvest")
      .flatMap((stage) => WorkflowV2FactorHarvestOutputSchema.parse(JSON.parse(stage.output_json)).factors)
      .map((factor) => [`${factor.sourceId}\u0000${factor.subject.trim()}\u0000${factor.quote.trim()}`, factor.uncertainty]));
    const evidenceForSource = (sourceId: string) => ({
      source: sources.get(sourceId),
      factors: base.factors.filter((factor) => factor.sourceId === sourceId).map((factor) => ({
        ...factor,
        uncertainty: factor.uncertainty
          ?? uncertaintyByFactor.get(`${factor.sourceId}\u0000${factor.subject.trim()}\u0000${factor.quote.trim()}`)
          ?? "Not recorded",
      })),
    });
    const context: WorkflowV2DevelopmentContext = {
      scope: base.scope,
      problem: base.problem,
      supportingEvidence: [...new Set(base.factors.map((factor) => factor.sourceId))].map((sourceId) => ({
        sourceId, content: evidenceForSource(sourceId),
      })),
      contraryEvidence: base.problem.verdictSourceIds.map((sourceId) => ({ sourceId, content: evidenceForSource(sourceId) })),
      priorFailedAttempts: [],
      priorProjectMechanisms: this.priorProjectMechanisms(),
      recordedExperiments: this.recordedExperiments(base.problem.statement),
    };
    const candidateOutputs = stageEvidence.filter((stage) => stage.stage_id === "problem-candidates")
      .flatMap((stage) => WorkflowV2ProblemCandidatesOutputSchema.parse(JSON.parse(stage.output_json)).problems)
      .filter((candidate) => candidate.statement.trim() === base.problem.statement.trim());
    const assessmentOutputs = stageEvidence.filter((stage) => stage.stage_id === "problem-kill")
      .filter((stage) => findRecords([JSON.parse(stage.context_json)], "candidate")
        .some((candidate) => candidate.statement === base.problem.statement))
      .map((stage) => WorkflowV2ProblemKillOutputSchema.parse(JSON.parse(stage.output_json)));
    context.researchContext = {
      alternativeExplanations: uniqueStrings(candidateOutputs.flatMap((candidate) => candidate.alternativeExplanations)),
      unknowns: uniqueStrings(candidateOutputs.flatMap((candidate) => candidate.unknowns)),
      unresolvedAssumptions: uniqueStrings(assessmentOutputs.flatMap((assessment) => assessment.unresolvedAssumptions)),
      wouldChangeConclusion: uniqueStrings(assessmentOutputs.flatMap((assessment) => assessment.wouldChangeConclusion)),
    };
    this.save("development-context", context);
    return context;
  }

  private priorProjectMechanisms(): NonNullable<WorkflowV2DevelopmentContext["priorProjectMechanisms"]> {
    const rows = this.db.db.prepare(`
      SELECT s.mechanism, p.statement
      FROM solutions s JOIN problems p ON p.id = s.problem_id
      JOIN research_runs previous ON previous.id = s.research_run_id
      JOIN research_runs current ON current.id = ?
      WHERE previous.thread_id = current.thread_id AND previous.rowid < current.rowid
      ORDER BY previous.rowid DESC, s.option_position, s.id LIMIT 40
    `).all(this.runId) as Array<{ mechanism: string; statement: string }>;
    const results: NonNullable<WorkflowV2DevelopmentContext["priorProjectMechanisms"]> = [];
    let characters = 0;
    for (const row of rows) {
      const item = { mechanism: row.mechanism, problemStatement: row.statement };
      const size = JSON.stringify(item).length;
      if (characters + size > 8_000) break;
      results.push(item);
      characters += size;
    }
    return results;
  }

  private recordedExperiments(statement: string): NonNullable<WorkflowV2DevelopmentContext["recordedExperiments"]> {
    // Match the same problem within this project. User results remain reports, not an
    // automatic success/failure judgment. The containing context is snapshotted per run.
    const rows = this.db.db.prepare(`
      SELECT s.mechanism, da.user_decision, da.observed_result, COUNT(*) OVER () AS total_count
      FROM decision_analyses da JOIN solutions s ON s.id = da.solution_id
      JOIN problems p ON p.id = s.problem_id JOIN research_runs previous ON previous.id = da.research_run_id
      JOIN research_runs current ON current.id = ?
      WHERE previous.thread_id = current.thread_id AND previous.rowid < current.rowid
        AND previous.status = 'completed' AND trim(p.statement) = trim(?)
        AND length(trim(COALESCE(da.observed_result, ''))) > 0
      ORDER BY previous.rowid DESC, da.updated_at DESC LIMIT 5
    `).all(this.runId, statement) as Array<{ mechanism: string; user_decision: string | null; observed_result: string; total_count: number }>;
    const results: NonNullable<WorkflowV2DevelopmentContext["recordedExperiments"]>["results"] = [];
    let characters = 0;
    for (const row of rows) {
      const result = { mechanism: row.mechanism, userDecision: row.user_decision, observedResult: row.observed_result };
      const size = JSON.stringify(result).length;
      if (characters + size > 12000) continue;
      results.push(result);
      characters += size;
    }
    return { results, omittedCount: (rows[0]?.total_count ?? 0) - results.length };
  }

  selectedOption(problemId: string) {
    const checkpoint = this.repository.findStageResult(this.runId, "solutions");
    if (!checkpoint) throw new Error("Solution options are not ready");
    const selected = this.db.db.prepare("SELECT id, option_position FROM solutions WHERE research_run_id = ? AND selected_at IS NOT NULL")
      .get(this.runId) as { id: string; option_position: number } | undefined;
    if (!selected) return null;
    const option = WorkflowV2SolutionsOutputSchema.parse(checkpoint.output).options[selected.option_position];
    if (!option) throw new Error("Selected option is missing from its saved checkpoint");
    return { ...option, id: selected.id, problemId };
  }
}

function assertDiscoveryStageSemantics<T>(
  stageId: WorkflowV2StageId,
  output: unknown,
  request: StructuredStageRequest<T>,
): void {
  const evidence = request.evidence.map((item) => item.content);
  if (stageId === "query-plan") {
    const queries = WorkflowV2QueryPlanOutputSchema.parse(output).queries.map((item) => item.query.trim());
    const expected = (request.workOrder.inputs as Record<string, unknown> | undefined)?.queryCount;
    if (typeof expected === "number" && new Set(queries.filter(Boolean)).size < expected) {
      throw new Error(`Query planner returned fewer than ${expected} unique questions`);
    }
    return;
  }
  if (stageId === "factor-harvest" || stageId === "problem-candidates") {
    // Discovery validates individual quotes and citations, recording rejected rows.
    // Aborting here would discard valid evidence from the same batch as a bad row.
    return;
  }
  if (stageId === "problem-kill") {
    const sourceIds = new Set([
      ...findRecords(evidence, "sources").flatMap((source) => typeof source.id === "string" ? [source.id] : []),
      ...findRecords(evidence, "supportingFactors").flatMap((factor) => typeof factor.sourceId === "string" ? [factor.sourceId] : []),
    ]);
    const assessment = WorkflowV2ProblemKillOutputSchema.parse(output);
    if (assessment.verdictSourceIds.some((id) => !sourceIds.has(id))) {
      throw new Error("Evidence assessment referenced an unknown source ID");
    }
    if (assessment.verdict === "confirmed" && findRecords(evidence, "supportingFactors").length === 0) {
      throw new Error("Confirmed evidence assessment requires supplied supporting factors");
    }
  }
}

function findRecords(values: unknown[], key: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const selected = record[key];
    if (Array.isArray(selected)) {
      for (const item of selected) {
        if (item && typeof item === "object" && !Array.isArray(item)) found.push(item as Record<string, unknown>);
      }
    } else if (selected && typeof selected === "object") {
      found.push(selected as Record<string, unknown>);
    }
    for (const child of Object.values(record)) visit(child);
  };
  for (const value of values) visit(value);
  return found;
}

function completedAttemptIdentity(request: Record<string, unknown> | StructuredStageRequest<unknown>): Record<string, unknown> {
  return {
    stage: request.stage,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    workOrder: request.workOrder,
    evidence: request.evidence,
    jsonSchema: request.jsonSchema,
    repairPolicy: request.repairPolicy,
    maxOutputTokens: request.maxOutputTokens ?? null,
  };
}

function recoverableFactorPartitionSourceIds(
  request: StructuredStageRequest<unknown>,
  savedRequest: Record<string, unknown>,
): Set<string> | null {
  const normalize = (value: Record<string, unknown> | StructuredStageRequest<unknown>) => {
    const workOrder = structuredClone(value.workOrder) as Record<string, unknown>;
    if (typeof workOrder.stage === "string") {
      // Source IDs identify one partition, while the harvest mode identifies its semantics.
      // A smaller resumed partition may reuse a completed superset only across that boundary.
      workOrder.stage = workOrder.stage.replace(/^(factor-harvest:(?:domain|audience)):.+$/, "$1");
    }
    const inputs = workOrder.inputs as Record<string, unknown> | undefined;
    const routing = inputs?.routing as Record<string, unknown> | undefined;
    if (routing) delete routing.factorLimit;
    const jsonSchema = structuredClone(value.jsonSchema) as Record<string, unknown>;
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    const factors = properties?.factors as Record<string, unknown> | undefined;
    if (factors) delete factors.maxItems;
    return { model: value.model, reasoningEffort: value.reasoningEffort, workOrder,
      jsonSchema, repairPolicy: value.repairPolicy,
      maxOutputTokens: value.maxOutputTokens ?? null };
  };
  if (canonicalJson(normalize(request)) !== canonicalJson(normalize(savedRequest))) return null;
  const sources = (value: unknown): Array<Record<string, unknown>> => {
    if (!Array.isArray(value)) return [];
    const content = (value[0] as { content?: { sources?: unknown } } | undefined)?.content;
    return Array.isArray(content?.sources) ? content.sources as Array<Record<string, unknown>> : [];
  };
  const requestedSources = sources(request.evidence);
  const savedSources = sources(savedRequest.evidence);
  if (requestedSources.length === 0 || savedSources.length < requestedSources.length) return null;
  const savedById = new Map(savedSources.map((source) => [String(source.id), source]));
  if (requestedSources.some((source) => canonicalJson(savedById.get(String(source.id))) !== canonicalJson(source))) return null;
  return new Set(requestedSources.map((source) => String(source.id)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function factorIdentity(factor: { sourceId: string; subject: string; quote: string }): string {
  return `${factor.sourceId}\u0000${factor.subject.trim()}\u0000${factor.quote.trim()}`;
}
