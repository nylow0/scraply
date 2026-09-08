import { createHash } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { DevelopmentRepository } from "../db/repositories/development";
import { WorkflowV2Repository, canonicalJson } from "../db/repositories/workflow-v2";
import type { SearchClient } from "../providers/search";
import type { GenerationMetadata, StructuredModelClient, StructuredStageRequest } from "../providers/structured";
import { deriveJsonSchema } from "../shared/json-schema";
import { SourceSchema } from "../shared/schemas";
import { WorkflowV2QueryPlanOutputSchema, WorkflowV2FactorHarvestOutputSchema, WorkflowV2ProblemCandidatesOutputSchema, WorkflowV2ProblemKillOutputSchema, WorkflowV2SolutionsOutputSchema } from "../shared/structured-output-schemas";
import { quoteAppearsVerbatim } from "./discovery";
import type { WorkflowV2DevelopmentContext } from "./development";
import { resolveWorkflowV2Prompt, type ResolvedWorkflowV2Prompt } from "./prompts";
import { WORKFLOW_V2_STAGE_IDS, WORKFLOW_V2_STAGE_REGISTRY, type WorkflowV2StageId } from "./stages";

/** Run-local snapshots never reuse fresh web results or prompt overrides across runs. */
export class WorkflowExecution {
  readonly repository: WorkflowV2Repository;
  private readonly prompts: Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>;
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

  search(client: Pick<SearchClient, "search">): Pick<SearchClient, "search"> {
    return { search: async (query, options) => {
      options?.signal?.throwIfAborted();
      const { signal: _signal, ...parameters } = options ?? {};
      void _signal;
      const key = `search:${createHash("sha256").update(canonicalJson({ query, parameters })).digest("hex")}`;
      const saved = this.read<unknown>(key);
      if (saved) return SourceSchema.array().parse(saved);
      const results = await client.search(query, options);
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
      const request: StructuredStageRequest<unknown> = {
        ...original,
        workOrder: { ...original.workOrder, instruction: prompt.text, inputs: { routing: original.workOrder.inputs, workflowVersion: 2 } },
        schema: stage.schema,
        jsonSchema: deriveJsonSchema(stage.schema),
        deadlineMs: stage.deadlineMs,
      };
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
      let output: unknown;
      let metadata: GenerationMetadata;
      if (previous.kind === "reusable") {
        output = previous.result.output;
        const savedMetadata = this.read<GenerationMetadata>(`metadata:${original.stage}`);
        if (!savedMetadata) throw new Error("Checkpoint metadata is missing");
        metadata = savedMetadata;
      } else {
        const completion = await client.structuredCompletion(request);
        output = stage.schema.parse(completion.output);
        metadata = completion.metadata;
        assertDiscoveryStageSemantics(stageId, output, original);
        this.pendingStages.set(original.stage, { stageId, request, prompt, metadata, output, context, selectionId });
      }
      // Discovery keeps its deterministic search/quote pipeline. Only query-plan's wire shape differs.
      let adapted: unknown = output;
      if (stageId === "query-plan") adapted = { queries: WorkflowV2QueryPlanOutputSchema.parse(output).queries.map((item) => item.query) };
      if (stageId === "factor-harvest") adapted = { factors: WorkflowV2FactorHarvestOutputSchema.parse(output).factors.map(({ uncertainty, ...factor }) => { void uncertainty; return factor; }) };
      if (stageId === "problem-candidates") adapted = { problems: WorkflowV2ProblemCandidatesOutputSchema.parse(output).problems.map(({ alternativeExplanations, unknowns, ...problem }) => { void alternativeExplanations; void unknowns; return problem; }) };
      if (stageId === "problem-kill") {
        const { unresolvedAssumptions, wouldChangeConclusion, ...assessment } = WorkflowV2ProblemKillOutputSchema.parse(output);
        void unresolvedAssumptions; void wouldChangeConclusion;
        adapted = assessment;
      }
      return { output: original.schema.parse(adapted), metadata };
    } };
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
    const uncertainty = new Map<string, string>();
    for (const pending of this.pendingStages.values()) {
      if (pending.stageId !== "factor-harvest") continue;
      for (const factor of WorkflowV2FactorHarvestOutputSchema.parse(pending.output).factors) {
        uncertainty.set(factorIdentity(factor), factor.uncertainty);
      }
    }
    return factors.map((factor) => {
      const value = uncertainty.get(factorIdentity(factor));
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
  if (stageId === "factor-harvest") {
    const sources = findRecords(evidence, "sources");
    const sourceById = new Map(sources.flatMap((source) => {
      const id = typeof source.id === "string" ? source.id : null;
      const text = typeof source.text === "string" ? source.text : null;
      return id && text !== null ? [[id, text] as const] : [];
    }));
    for (const factor of WorkflowV2FactorHarvestOutputSchema.parse(output).factors) {
      const text = sourceById.get(factor.sourceId);
      if (text === undefined) throw new Error(`Factor harvest referenced unknown source ${factor.sourceId}`);
      if (!quoteAppearsVerbatim(text, factor.quote)) {
        throw new Error(`Factor harvest quote does not appear in source ${factor.sourceId}`);
      }
    }
    return;
  }
  if (stageId === "problem-candidates") {
    const factorIds = new Set(findRecords(evidence, "factors").flatMap((factor) =>
      typeof factor.id === "string" ? [factor.id] : []));
    for (const candidate of WorkflowV2ProblemCandidatesOutputSchema.parse(output).problems) {
      if (candidate.factorIds.some((id) => !factorIds.has(id))) {
        throw new Error("Problem candidate referenced an unknown factor ID");
      }
    }
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function factorIdentity(factor: { sourceId: string; subject: string; quote: string }): string {
  return `${factor.sourceId}\u0000${factor.subject.trim()}\u0000${factor.quote.trim()}`;
}
