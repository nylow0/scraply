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

  constructor(private readonly db: DatabaseClient, readonly runId: string) {
    this.repository = new WorkflowV2Repository(db);
    const saved = this.read<Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>>("prompts");
    this.prompts = saved ?? Object.fromEntries(WORKFLOW_V2_STAGE_IDS.map((stage) => [stage, resolveWorkflowV2Prompt(stage)])) as Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>;
    if (!saved) this.save("prompts", this.prompts);
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
    return () => createHash("sha256").update(`${this.runId}:${phase}:${sequence++}`).digest("hex");
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
      const previous = this.repository.getStageResumeState({ researchRunId: this.runId, stageId, selectionId, context });
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
        this.db.immediateTransaction(() => {
          this.commitStage(stageId, request, prompt, metadata, output, context, selectionId);
          this.save(`metadata:${original.stage}`, metadata);
        });
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
    const stageEvidence = this.db.db.prepare("SELECT stage_id, output_json FROM stage_results WHERE research_run_id = ? AND stage_id IN ('factor-harvest', 'problem-candidates', 'problem-kill')")
      .all(row.discovery_run_id) as Array<{ stage_id: string; output_json: string }>;
    const sourceIds = [...new Set([...base.factors.map((factor) => factor.sourceId), ...base.problem.verdictSourceIds])];
    const sources = new Map(sourceIds.map((id) => {
      const source = this.db.db.prepare("SELECT id, title, canonical_url AS url, retrieved_text AS text FROM sources WHERE id = ?").get(id);
      return [id, source];
    }));
    const context: WorkflowV2DevelopmentContext = {
      scope: base.scope,
      problem: base.problem,
      supportingEvidence: [...new Set(base.factors.map((factor) => factor.sourceId))].map((sourceId) => ({
        sourceId, content: { source: sources.get(sourceId), factors: base.factors.filter((factor) => factor.sourceId === sourceId) },
      })),
      contraryEvidence: base.problem.verdictSourceIds.map((sourceId) => ({ sourceId, content: {
        source: sources.get(sourceId), factors: base.factors.filter((factor) => factor.sourceId === sourceId),
      } })),
      priorFailedAttempts: stageEvidence.filter((stage) => stage.stage_id === "problem-kill").map((stage) => stage.output_json),
    };
    // Preserve extracted uncertainty and alternatives as data, including judgments that disagree.
    if (stageEvidence.length) context.priorFailedAttempts.push(canonicalJson({ researchAssessments: stageEvidence.map((item) => JSON.parse(item.output_json) as unknown) }));
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
