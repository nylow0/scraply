import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client";
import { DevelopmentRepository } from "../db/repositories/development";
import { WorkflowV2Repository } from "../db/repositories/workflow-v2";
import type { SearchClient } from "../providers/search";
import { isDroppedStream, ProviderFailure, type GenerationMetadata, type StructuredModelClient, type StructuredStageRequest } from "../providers/structured";
import { canonicalJson, sha256, workflowSearchKey } from "../shared/content-identity";
import { EvidenceCheckOutputSchema, LegacyEvidenceCheckOutputSchema } from "../shared/evidence-investigators";
import { deriveJsonSchema } from "../shared/json-schema";
import { OpportunityExpansionOutputSchema } from "../shared/opportunity-exploration";
import { LegacyResearchFrameOutputSchema, ResearchFrameOutputSchema } from "../shared/research-frame";
import { SourceSchema, type Source } from "../shared/schemas";
import { AssessedWorkflowV2ProblemKillOutputSchema, BoundedWorkflowV2FactorHarvestOutputSchema, LabeledWorkflowV2FactorHarvestOutputSchema, FACTOR_EXPLANATION_CHARACTERS, ClassifiedWorkflowV2ProblemKillOutputSchema, WorkflowV2QueryPlanOutputSchema, WorkflowV2FactorHarvestOutputSchema, WorkflowV2ProblemCandidatesOutputSchema, WorkflowV2ProblemKillOutputSchema, WorkflowV2SolutionsOutputSchema } from "../shared/structured-output-schemas";
import { PROBLEM_AUDIENCE_ASSESSMENT_INSTRUCTION, repairVerdictSourceIds, scopeFactorAssessments } from "./problem-evidence";
import { LegacyWorkflowV2QueryPlanOutputSchema } from "../shared/structured-output-schemas";
import type { WorkflowV2DevelopmentContext } from "./development";
import { resolveWorkflowV2Prompt, type ResolvedWorkflowV2Prompt } from "./prompts";
import { WORKFLOW_V2_STAGE_IDS, WORKFLOW_V2_STAGE_REGISTRY, type WorkflowV2StageId } from "./stages";
import { prepareWorkflowSearch, recordWorkflowSearchDispatched, recordWorkflowSearchTerminal, unknownSearchAttempts, UnknownSearchCompletionError } from "./workflow-search-attempts";

export { workflowSearchKey } from "../shared/content-identity";

/** Run-local snapshots never reuse fresh web results or prompt overrides across runs. */
export class WorkflowExecution {
  private static readonly activeSearches = new WeakMap<DatabaseClient, Map<string, Promise<Source[]>>>();
  readonly repository: WorkflowV2Repository;
  readonly smallHarvestBatches: boolean;
  readonly boundedFollowUpHarvest: boolean;
  readonly parallelResearch: boolean;
  readonly labeledFactors: boolean;
  readonly rankProblemCandidates: boolean;
  private readonly prompts: Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>;
  private readonly disableRepair: boolean;
  private readonly factorUncertainty = new Map<string, string>();

  constructor(private readonly db: DatabaseClient, readonly runId: string,
    private readonly acknowledgedAttemptIds: readonly string[] = []) {
    this.repository = new WorkflowV2Repository(db);
    const run = db.db.prepare(`SELECT rr.purpose, ws.contract_json FROM research_runs rr
      LEFT JOIN workflow_sessions ws ON ws.id = rr.workflow_session_id WHERE rr.id = ?`)
      .get(runId) as { purpose: string | null; contract_json: string | null } | undefined;
    this.disableRepair = run?.purpose === "research-followup";
    const saved = this.read<Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>>("prompts");
    const instructionSet = run?.contract_json
      ? (JSON.parse(run.contract_json) as { instructions?: { research?: string; ideas?: string; review?: string } }).instructions
      : undefined;
    this.prompts = saved ?? Object.fromEntries(WORKFLOW_V2_STAGE_IDS.map((stage) => {
      const prompt = resolveWorkflowV2Prompt(stage);
      const kind = ["frame-search-plan", "frame", "area-ranking", "evidence-check", "area-gap", "query-plan", "factor-harvest", "problem-candidates", "problem-kill"].includes(stage)
        ? "research" : ["solutions", "idea-follow-up"].includes(stage) ? "ideas" : "review";
      const instruction = instructionSet?.[kind]?.trim();
      if (!instruction) return [stage, prompt];
      const text = `${prompt.text}\n\nProject instruction for this workflow stage:\n${instruction}`;
      return [stage, { ...prompt, text, resolvedSha256: sha256(text) }];
    })) as Record<WorkflowV2StageId, ResolvedWorkflowV2Prompt>;
    if (!saved) {
      this.save("prompts", this.prompts);
      // 96-bit deterministic identifiers are easier for models to copy than full SHA-256 text.
      // Save the format per run: an older run without this marker must still reproduce its IDs.
      this.save("identifier-characters", 24);
      this.save("focused-experiments", { version: 1 });
      this.save("small-harvest-batches", { version: 1 });
      this.save("problem-audience-assessment", { version: 1 });
      this.save("candidate-accounting", { version: 1 });
      this.save("source-routes", { version: 2 });
      this.save("query-plan-languages", { version: 1 });
      this.save("bounded-follow-up-harvest", { version: 1 });
      this.save("parallel-research", { version: 1 });
      this.save("labeled-factors", { version: 1 });
    }
    // Runs without the marker keep their original source groups and checkpoint identities.
    this.smallHarvestBatches = this.read<{ version: number }>("small-harvest-batches")?.version === 1;
    this.boundedFollowUpHarvest = this.read<{ version: number }>("bounded-follow-up-harvest")?.version === 1;
    // Older runs keep their sequential reads, whose factor limits are part of saved request identities.
    this.parallelResearch = this.read<{ version: number }>("parallel-research")?.version === 1;
    // Older runs keep the read schema their completed reads were requested with.
    this.labeledFactors = this.read<{ version: number }>("labeled-factors")?.version === 1;
    if (!this.read("source-route-start")) this.save("source-route-start", new Date().toISOString());
    // Candidate order controls sequential source IDs in completed verdict requests.
    this.rankProblemCandidates = this.read<{ version: number }>("candidate-accounting")?.version === 1;
  }

  resolvePrompt = (stage: WorkflowV2StageId): ResolvedWorkflowV2Prompt => this.prompts[stage];

  // Older runs keep their original six-stage contract when resumed.
  hasRiskEvaluator(): boolean {
    return Boolean(this.prompts["risk-evaluation"]);
  }

  hasFocusedExperiments(): boolean {
    return this.read<{ version: number }>("focused-experiments")?.version === 1;
  }

  read<T>(key: string): T | null {
    const row = this.db.db.prepare("SELECT value_json FROM workflow_snapshots WHERE research_run_id = ? AND snapshot_key = ?")
      .get(this.runId, key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : null;
  }

  /**
   * Records a call whose stream dropped and that the app is starting over. Its result is never used;
   * resume and the run outcome treat it as settled instead of waiting for the user to acknowledge it.
   */
  acknowledgeStreamRestart(generationId: string): void {
    const lost = this.db.db.prepare("SELECT id FROM generation_attempts WHERE research_run_id = ? AND generation_id = ?")
      .all(this.runId, generationId) as Array<{ id: string }>;
    this.save(`acknowledged-retry:stream-restart:${generationId}`, { attemptIds: lost.map((attempt) => attempt.id) });
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

  search(client: Pick<SearchClient, "search"> & Partial<Pick<SearchClient, "provider" | "providerForRoute" | "searchWithDispatch">>): Pick<SearchClient, "search"> & Partial<Pick<SearchClient, "provider" | "providerForRoute">> {
    return { ...(client.provider ? { provider: client.provider } : {}),
      ...(client.providerForRoute ? { providerForRoute: client.providerForRoute } : {}), search: async (query, options) => {
      options?.signal?.throwIfAborted();
      const { signal: _signal, legacySearchOptions, provider: requestedProvider, ...parameters } = options ?? {};
      void _signal;
      const normalizedQuery = query.normalize("NFKC").trim().replace(/\s+/g, " ");
      let running = WorkflowExecution.activeSearches.get(this.db);
      if (!running) {
        running = new Map();
        WorkflowExecution.activeSearches.set(this.db, running);
      }
      const activeKey = canonicalJson({ runId: this.runId, key: workflowSearchKey(normalizedQuery, parameters) });
      const active = running.get(activeKey);
      if (active) return active;
      const pending = (async () => {
        // Completed pre-routing searches retain their original question and parameters. Both
        // new legs may read that checkpoint; neither dispatches paid work again.
        if (!this.read("source-routes")) {
          const legacyKey = workflowSearchKey(normalizedQuery, legacySearchOptions ?? parameters);
          const legacy = this.read<unknown>(legacyKey);
          if (legacy) return SourceSchema.array().parse(legacy);
        }
        // Automatic routing may lose a key between restarts. Reuse the paid result before selecting a fallback.
        if (!requestedProvider && client.providerForRoute) for (const provider of ["exa", "perplexity"] as const) {
          const saved = this.read<unknown>(workflowSearchKey(normalizedQuery, parameters, provider));
          if (saved) return SourceSchema.array().parse(saved);
        }
        if (this.read("source-routes")) {
          const unknown = unknownSearchAttempts(this.db, this.runId).find(attempt =>
            workflowSearchKey(attempt.query, attempt.parameters) === workflowSearchKey(normalizedQuery, parameters)
            && !this.acknowledgedAttemptIds.includes(attempt.id));
          if (unknown) throw new UnknownSearchCompletionError(unknown.id);
        }
        const provider = requestedProvider ?? client.providerForRoute?.(options?.route) ?? client.provider;
        const key = workflowSearchKey(normalizedQuery, parameters, provider);
        const saved = this.read<unknown>(key);
        if (saved) return SourceSchema.array().parse(saved);
        const queryReceipt = `search-query:${key.slice("search:".length)}`;
        if (!this.read(queryReceipt)) this.save(queryReceipt, { key, query: normalizedQuery, parameters, ...(provider ? { provider } : {}) });
        const attempt = this.read("source-routes") ? prepareWorkflowSearch(this.db, this.runId,
          { key, query: normalizedQuery, parameters, dispatchProofVersion: 1, ...(provider ? { provider } : {}) }, this.acknowledgedAttemptIds) : null;
        const cancelled = () => {
          if (attempt) recordWorkflowSearchTerminal(this.db, this.runId, attempt.id, "cancelled", "Cancelled by user");
        };
        options?.signal?.addEventListener("abort", cancelled, { once: true });
        let results: Awaited<ReturnType<SearchClient["search"]>>;
        try {
          const dispatched = () => {
            options?.signal?.throwIfAborted();
            if (attempt) recordWorkflowSearchDispatched(this.db, this.runId, attempt.id);
          };
          const dispatchOptions = { ...options, ...(provider ? { provider } : {}) };
          if (client.searchWithDispatch) results = await client.searchWithDispatch(normalizedQuery, dispatchOptions, dispatched, attempt?.id);
          else {
            dispatched();
            results = await client.search(normalizedQuery, dispatchOptions);
          }
          options?.signal?.throwIfAborted();
        } catch (error) {
          if (attempt) recordWorkflowSearchTerminal(this.db, this.runId, attempt.id,
            options?.signal?.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : "Search failed");
          throw error;
        } finally { options?.signal?.removeEventListener("abort", cancelled); }
        // If storing a paid result fails, retain its ambiguous dispatch for explicit acknowledgement.
        this.db.immediateTransaction(() => {
          this.save(key, results);
          if (attempt) recordWorkflowSearchTerminal(this.db, this.runId, attempt.id, "completed", undefined, { transaction: "existing" });
        });
        return results;
      })();
      running.set(activeKey, pending);
      // Cancellation releases this live operation immediately. A provider that ignores abort
      // must not make a same-run replacement inherit its promise or remove the new operation later.
      const releaseActive = () => { if (running.get(activeKey) === pending) running.delete(activeKey); };
      options?.signal?.addEventListener("abort", releaseActive, { once: true });
      if (options?.signal?.aborted) releaseActive();
      try { return await pending; }
      finally {
        options?.signal?.removeEventListener("abort", releaseActive);
        releaseActive();
      }
    } };
  }

  discoveryClient(client: StructuredModelClient): StructuredModelClient {
    return { structuredCompletion: async <T>(original: StructuredStageRequest<T>) => {
      const [id, ...selection] = original.stage.split(":");
      if (!WORKFLOW_V2_STAGE_IDS.includes(id as WorkflowV2StageId)) throw new Error(`Unknown stage ${id}`);
      const stageId = id as WorkflowV2StageId;
      const stage = WORKFLOW_V2_STAGE_REGISTRY[stageId];
      const savedPrompt = this.resolvePrompt(stageId);
      const assessAudience = stageId === "problem-kill" && original.stage.endsWith(":audience-v1");
      const instruction = assessAudience ? `${savedPrompt.text}\n\n${PROBLEM_AUDIENCE_ASSESSMENT_INSTRUCTION}` : savedPrompt.text;
      const prompt = { ...savedPrompt, text: instruction, resolvedSha256: sha256(instruction) };
      const selectionId = selection.join(":") || null;
      // Pin completed contracts, including a native result saved before its stage commit.
      // Only unfinished extraction gets the new limits; completed work is never regenerated.
      const completedFactor = stageId === "factor-harvest"
        ? this.db.db.prepare(`SELECT request_json FROM generation_attempts
            WHERE research_run_id = ? AND stage_key = ? AND status = 'completed'
            ORDER BY terminal_at DESC LIMIT 1`).get(this.runId, original.stage) as { request_json: string } | undefined
        : undefined;
      const savedFactorSchema = stageId === "factor-harvest"
        ? this.repository.findStageResult(this.runId, stageId, selectionId)?.schema
          ?? (completedFactor ? (JSON.parse(completedFactor.request_json) as { jsonSchema: unknown }).jsonSchema : undefined)
        : undefined;
      const factorSchema = savedFactorSchema ? WorkflowV2FactorHarvestOutputSchema
        : this.labeledFactors ? LabeledWorkflowV2FactorHarvestOutputSchema : BoundedWorkflowV2FactorHarvestOutputSchema;
      const factorLimit = stageId === "factor-harvest"
        ? Number((original.workOrder.inputs as { factorLimit?: unknown }).factorLimit)
        : Number.NaN;
      const requestSchema = stageId === "factor-harvest" && Number.isInteger(factorLimit) && factorLimit >= 0
        ? factorSchema.extend({
            factors: factorSchema.shape.factors.max(factorLimit),
          })
        // A saved run keeps its original prompt and schema so completed kill reviews can resume.
        : stageId === "query-plan" && !this.read("query-plan-languages") ? LegacyWorkflowV2QueryPlanOutputSchema
        : assessAudience ? AssessedWorkflowV2ProblemKillOutputSchema
        : stageId === "problem-kill" && prompt.currentBundledSha256 !== resolveWorkflowV2Prompt("problem-kill").currentBundledSha256
          ? ClassifiedWorkflowV2ProblemKillOutputSchema
        : stage.schema;
      const request: StructuredStageRequest<unknown> = {
        ...original,
        workOrder: { ...original.workOrder, instruction: prompt.text, inputs: { routing: original.workOrder.inputs, workflowVersion: 2 } },
        schema: requestSchema,
        jsonSchema: savedFactorSchema ?? deriveJsonSchema(requestSchema),
      };
      if (this.disableRepair) request.repairPolicy = "disabled";
      if (original.model.providerId === "openai-subscription") delete request.maxOutputTokens;
      else request.maxOutputTokens = stage.maxOutputTokens;
      const savedStage = stageId === "evidence-check" || stageId === "frame"
        ? this.repository.findStageResult(this.runId, stageId, selectionId) : null;
      const savedRequest = (savedStage?.effectiveRequest as { request?: Record<string, unknown> } | undefined)?.request;
      const savedStageIdentity = savedStage && savedRequest
        ? { ...savedRequest, stage: original.stage, jsonSchema: savedStage.schema } : null;
      if (savedStage && savedStageIdentity && (recoverableHistoricalEvidenceCheck(request, savedStageIdentity)
        || recoverableHistoricalFrame(request, savedStageIdentity))) {
        // Only completed work pins a historical contract. Unfinished requests use the current schema.
        request.jsonSchema = savedStage.schema as object;
      }
      const context = { inputs: request.workOrder.inputs, evidence: request.evidence };
      const evidence = request.evidence.map((item) => ({ sourceId: item.sourceId, content: item.content }));
      const previous = this.repository.getStageResumeState({
        researchRunId: this.runId,
        stageId,
        selectionId,
        stageKey: original.stage,
        context,
        acknowledgedAttemptIds: this.acknowledgedAttemptIds,
        identity: { promptSha256: prompt.resolvedSha256, schema: request.jsonSchema, inputs: request.workOrder.inputs, evidence },
      });
      if (previous.kind === "unknown-completion") throw new Error("A generation may have completed before interruption. Review this request before explicitly retrying it.");
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
        output = repairDiscoveryStageOutput(stageId, recovered.output, original);
        metadata = recovered.metadata;
        assertDiscoveryStageSemantics(stageId, output, original);
        this.persistCompletedStage(original.stage, stageId,
          recovered.jsonSchema ? { ...request, jsonSchema: recovered.jsonSchema } : request,
          prompt, metadata, output, context, selectionId);
      } else {
        const completion = await completeWithinTimeLimit(client, request, stageId, (generationId) => this.acknowledgeStreamRestart(generationId));
        output = repairDiscoveryStageOutput(stageId, requestSchema.parse(completion.output), original);
        metadata = completion.metadata;
        assertDiscoveryStageSemantics(stageId, output, original);
        // Each validated provider result is its own durable replay boundary. Domain rows may be
        // persisted later, but a restart must not repeat completed model work.
        this.persistCompletedStage(original.stage, stageId, request, prompt, metadata, output, context, selectionId);
      }
      if (stageId === "factor-harvest") {
        for (const factor of WorkflowV2FactorHarvestOutputSchema.parse(output).factors) {
          this.factorUncertainty.set(factorIdentity(factor), boundedExcerpt(factor.uncertainty, FACTOR_EXPLANATION_CHARACTERS));
        }
      }
      // Discovery keeps its deterministic search and quote checks while retaining v2 evidence labels.
      let adapted: unknown = output;
      if (stageId === "query-plan") adapted = { queries: WorkflowV2QueryPlanOutputSchema.parse(output).queries };
      if (stageId === "factor-harvest") adapted = {
        factors: WorkflowV2FactorHarvestOutputSchema.parse(output).factors.map(compactFactorExplanations).map((factor) => "sourceRole" in factor ? factor : {
          ...factor,
          sourceRole: "unknown" as const,
          audienceFit: "unknown" as const,
          independentSourceKey: null,
          supportsDemand: false,
          demandEvidenceUncertainty: "Not classified in the saved output.",
        }),
      };
      if (stageId === "problem-candidates") adapted = WorkflowV2ProblemCandidatesOutputSchema.parse(output);
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
    jsonSchema?: StructuredStageRequest<unknown>["jsonSchema"];
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
      const exactIdentity = canonicalJson(completedAttemptIdentity(savedRequest)) === canonicalJson(expected);
      if (!exactIdentity && !recoverableHistoricalEvidenceCheck(request, savedRequest)
        && !recoverableHistoricalFrame(request, savedRequest)) continue;
      const output = request.schema.parse(JSON.parse(row.output_json));
      const metadata = JSON.parse(row.attempt_metadata_json) as GenerationMetadata;
      if (!metadata.prompt) continue;
      return { output, metadata, ...(!exactIdentity ? { jsonSchema: savedRequest.jsonSchema as StructuredStageRequest<unknown>["jsonSchema"] } : {}) };
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
        const factorLimit = Number((request.workOrder.inputs as { routing?: { factorLimit?: unknown } }).routing?.factorLimit);
        const matchingFactors = parsed.data.factors.filter((factor) => sourceIds.has(factor.sourceId)).map(compactFactorExplanations);
        const factors = Number.isInteger(factorLimit) && factorLimit >= 0
          ? matchingFactors.slice(0, factorLimit)
          : matchingFactors;
        const output = request.schema.safeParse({ factors });
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
      this.commitStage(stageId, request, prompt, metadata, output, context, selectionId,
        stageId === "query-plan" && this.read("query-plan-languages") ? 2 : 1);
      this.save(`metadata:${stageKey}`, metadata);
    });
  }

  withFactorUncertainty<T extends { sourceId: string; subject: string; quote: string }>(factors: T[]): Array<T & { uncertainty?: string }> {
    return factors.map((factor) => {
      const value = this.factorUncertainty.get(factorIdentity(factor));
      return value ? { ...factor, uncertainty: value } : factor;
    });
  }

  commitStage<T>(stageId: WorkflowV2StageId, request: StructuredStageRequest<T>, prompt: ResolvedWorkflowV2Prompt,
    metadata: GenerationMetadata, output: unknown, context: unknown, selectionId: string | null = null,
    schemaRevision: 1 | 2 = 1) {
    if (!metadata.prompt) throw new Error("The model provider did not identify its prompt compiler");
    return this.repository.saveStageResult({
      researchRunId: this.runId, stageId, selectionId, context, output, prompt, schemaRevision,
      schema: request.jsonSchema, inputs: request.workOrder.inputs, evidence: request.evidence.map((item) => ({ sourceId: item.sourceId, content: item.content })),
      runtimePrompt: metadata.prompt,
      effectiveRequest: {
        model: request.model, reasoningEffort: request.reasoningEffort, workOrder: request.workOrder,
        evidence: request.evidence, jsonSchema: request.jsonSchema, repairPolicy: request.repairPolicy,
        ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
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
        uncertainty: boundedExcerpt(factor.uncertainty
          ?? uncertaintyByFactor.get(`${factor.sourceId}\u0000${factor.subject.trim()}\u0000${factor.quote.trim()}`)
          ?? "Not recorded", FACTOR_EXPLANATION_CHARACTERS),
      })),
    });
    const priorProjectMechanisms = this.priorProjectMechanisms();
    const context: WorkflowV2DevelopmentContext = {
      scope: base.scope,
      problem: base.problem,
      supportingEvidence: [...new Set(base.factors.map((factor) => factor.sourceId))].map((sourceId) => ({
        sourceId, content: evidenceForSource(sourceId),
      })),
      contraryEvidence: base.problem.verdictSourceIds.map((sourceId) => ({ sourceId, content: evidenceForSource(sourceId) })),
      priorFailedAttempts: [],
      priorProjectMechanisms: priorProjectMechanisms.items,
      priorProjectMechanismsOmittedCount: priorProjectMechanisms.omittedCount,
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

  private priorProjectMechanisms(): {
    items: NonNullable<WorkflowV2DevelopmentContext["priorProjectMechanisms"]>;
    omittedCount: number;
  } {
    const rows = this.db.db.prepare(`
      SELECT s.description, s.mechanism, p.statement, COUNT(*) OVER () AS total_count
      FROM solutions s JOIN problems p ON p.id = s.problem_id
      JOIN research_runs previous ON previous.id = s.research_run_id
      JOIN research_runs current ON current.id = ?
      WHERE previous.thread_id = current.thread_id AND previous.rowid < current.rowid
      ORDER BY previous.rowid DESC, s.option_position, s.id LIMIT 100
    `).all(this.runId) as Array<{ description: string; mechanism: string; statement: string; total_count: number }>;
    const results: NonNullable<WorkflowV2DevelopmentContext["priorProjectMechanisms"]> = [];
    let characters = 2; // JSON array brackets.
    for (const row of rows) {
      const item = {
        description: boundedExcerpt(row.description, 180),
        mechanism: boundedExcerpt(row.mechanism, 440),
        problemStatement: boundedExcerpt(row.statement, 140),
      };
      const size = JSON.stringify(item).length + (results.length > 0 ? 1 : 0);
      if (characters + size > 24_000) continue;
      results.push(item);
      characters += size;
    }
    return { items: results, omittedCount: (rows[0]?.total_count ?? 0) - results.length };
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
    const selected = this.db.db.prepare("SELECT id, option_position FROM solutions WHERE research_run_id = ? AND selected_at IS NOT NULL")
      .get(this.runId) as { id: string; option_position: number } | undefined;
    if (!selected) return null;
    const option = checkpoint
      ? WorkflowV2SolutionsOutputSchema.parse(checkpoint.output).options[selected.option_position]
      : this.expansionOptionFromCheckpoint(selected.id, selected.option_position);
    if (!option) throw new Error("Selected option is missing from its saved checkpoint");
    return { ...option, id: selected.id, problemId };
  }

  private expansionOptionFromCheckpoint(solutionId: string, position: number) {
    const row = this.db.db.prepare(`
      SELECT attempt.result_json
      FROM opportunity_candidate_origins origin
      JOIN opportunity_exploration_attempts attempt
        ON attempt.thread_id = origin.thread_id
       AND attempt.stage_key = 'gap-generation:' || origin.batch_id
       AND attempt.status = 'completed'
      WHERE origin.candidate_id = ? AND origin.batch_id IS NOT NULL
    `).get(solutionId) as { result_json: string } | undefined;
    if (!row) throw new Error("Solution options are not ready");
    const saved: unknown = JSON.parse(row.result_json);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      throw new Error("Saved opportunity expansion checkpoint is invalid");
    }
    const record = saved as Record<string, unknown>;
    if (!Array.isArray(record.candidateIds) || record.candidateIds.some((id) => typeof id !== "string")) {
      throw new Error("Saved opportunity expansion candidate IDs are invalid");
    }
    if (record.candidateIds[position] !== solutionId) {
      throw new Error("Selected expansion option does not match its durable generation checkpoint");
    }
    const option = OpportunityExpansionOutputSchema.parse(record.output).options[position];
    if (!option) return undefined;
    const { focusedDemandTest, ...workflowOption } = option;
    void focusedDemandTest;
    return workflowOption;
  }
}

/**
 * Research call limits, from Sol xhigh runs: normal calls finish within about two minutes, while
 * stalled or runaway calls ran 7 to 38 minutes. Evidence reads are shorter: 99% of 236 successful
 * reads finished within 54 seconds (the slowest took 115), and a stalled read is started over.
 * Idea stages legitimately run longer and stay unlimited.
 */
export const RESEARCH_CALL_TIME_LIMIT_MS: Partial<Record<WorkflowV2StageId, number>> = {
  "frame-search-plan": 240_000, "area-ranking": 240_000, "query-plan": 240_000, "factor-harvest": 90_000,
  "evidence-check": 240_000, "area-gap": 240_000, frame: 480_000, "problem-candidates": 480_000, "problem-kill": 480_000,
};

/**
 * A timed-out research call is retried once. Evidence reading handles its own timeout restart and split
 * (see discovery.ts). A research call whose OpenAI stream dropped is started over once here:
 * `acknowledgeRestart` records the lost attempt as deliberately replaced, and its result is never used.
 * A second drop is not acknowledged; framed research then ends only that area (see research-engine.ts).
 * Idea stages have no time limit and are never started over.
 */
async function completeWithinTimeLimit<T>(client: StructuredModelClient, request: StructuredStageRequest<T>, stageId: WorkflowV2StageId,
  acknowledgeRestart: (generationId: string) => void) {
  const limit = RESEARCH_CALL_TIME_LIMIT_MS[stageId];
  if (limit === undefined || request.callTimeLimitMs !== undefined) return client.structuredCompletion(request);
  const limited: StructuredStageRequest<T> = { ...request, callTimeLimitMs: limit };
  try {
    return await client.structuredCompletion(limited);
  } catch (error) {
    if (!(error instanceof ProviderFailure) || request.signal?.aborted) throw error;
    if (isDroppedStream(error)) acknowledgeRestart(request.generationId);
    else if (stageId === "factor-harvest" || error.code !== "timeout") throw error;
    return client.structuredCompletion({ ...limited, generationId: randomUUID() });
  }
}

/**
 * Repairs citation slips in an evidence assessment instead of discarding the run:
 * fact IDs cited as sources map to their source, unknown IDs are dropped, factor reviews
 * are scoped to the supplied factors, and "confirmed" without supplied factors is downgraded.
 * Unreviewed factors keep their extracted classification; discovery re-applies the confirmation rule.
 */
function repairDiscoveryStageOutput<T>(stageId: WorkflowV2StageId, output: unknown, request: StructuredStageRequest<T>): unknown {
  if (stageId !== "problem-kill" || typeof output !== "object" || output === null || !("verdictSourceIds" in output)
    || !Array.isArray(output.verdictSourceIds)) return output;
  const evidence = request.evidence.map((item) => item.content);
  const factors = findRecords(evidence, "supportingFactors");
  const sourceIds = new Set([
    ...findRecords(evidence, "sources").flatMap((source) => typeof source.id === "string" ? [source.id] : []),
    ...factors.flatMap((factor) => typeof factor.sourceId === "string" ? [factor.sourceId] : []),
  ]);
  const factorSources = new Map(factors.flatMap((factor) => typeof factor.id === "string" && typeof factor.sourceId === "string"
    ? [[factor.id, factor.sourceId] as const] : []));
  const factorIds = [...factorSources.keys()];
  const known = new Set(factorIds);
  const repaired: Record<string, unknown> = { ...output, verdictSourceIds: repairVerdictSourceIds(
    output.verdictSourceIds.filter((id): id is string => typeof id === "string"), sourceIds, factorSources) };
  if (Array.isArray(repaired.factorAssessments)) {
    repaired.factorAssessments = scopeFactorAssessments(repaired.factorAssessments.filter((item): item is { factorId: string } =>
      typeof item === "object" && item !== null && "factorId" in item && typeof item.factorId === "string"), factorIds);
  }
  if (Array.isArray(repaired.intendedBuyerEvidenceFactorIds)) {
    repaired.intendedBuyerEvidenceFactorIds = repaired.intendedBuyerEvidenceFactorIds.filter((id) => typeof id === "string" && known.has(id));
  }
  if (repaired.verdict === "confirmed" && factors.length === 0) repaired.verdict = "insufficient-evidence";
  return repaired;
}

function assertDiscoveryStageSemantics<T>(
  stageId: WorkflowV2StageId,
  output: unknown,
  request: StructuredStageRequest<T>,
): void {
  const evidence = request.evidence.map((item) => item.content);
  if (stageId === "query-plan") {
    const queries = WorkflowV2QueryPlanOutputSchema.parse(output).queries.map((item) => item.query.trim());
    const inputs = request.workOrder.inputs as Record<string, unknown> | undefined;
    const expected = inputs?.queryCount;
    if (inputs?.queryCountIsGuidance !== true && typeof expected === "number" && new Set(queries.filter(Boolean)).size < expected) {
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
    // Citation slips were repaired before this check; anything left here is an app bug.
    const assessment = WorkflowV2ProblemKillOutputSchema.parse(output);
    if (request.stage.endsWith(":audience-v1") && !("intendedBuyerEvidenceFactorIds" in assessment)) {
      throw new Error("Problem audience assessment must cite supporting factors");
    }
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

function recoverableHistoricalEvidenceCheck(
  request: StructuredStageRequest<unknown>, savedRequest: Record<string, unknown>,
): boolean {
  if (request.stage.split(":")[0] !== "evidence-check"
    || canonicalJson(request.jsonSchema) !== canonicalJson(deriveJsonSchema(EvidenceCheckOutputSchema))
    || canonicalJson(savedRequest.jsonSchema) !== canonicalJson(deriveJsonSchema(LegacyEvidenceCheckOutputSchema))) return false;
  // The root union changed only its wire shape. Model, prompt, evidence, inputs, repair policy and output limit still match.
  return canonicalJson(completedAttemptIdentity({ ...savedRequest, jsonSchema: request.jsonSchema }))
    === canonicalJson(completedAttemptIdentity(request));
}

function recoverableHistoricalFrame(
  request: StructuredStageRequest<unknown>, savedRequest: Record<string, unknown>,
): boolean {
  if (request.stage.split(":")[0] !== "frame"
    || canonicalJson(request.jsonSchema) !== canonicalJson(deriveJsonSchema(ResearchFrameOutputSchema))
    || canonicalJson(savedRequest.jsonSchema) !== canonicalJson(deriveJsonSchema(LegacyResearchFrameOutputSchema))) return false;
  // Only source-reference length changed. Model, prompt, evidence, inputs, repair policy and output limit still match.
  return canonicalJson(completedAttemptIdentity({ ...savedRequest, jsonSchema: request.jsonSchema }))
    === canonicalJson(completedAttemptIdentity(request));
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
    // This specific tightening is compatible with cached observations after compacting notes.
    // Every other schema, model, prompt, and evidence change still prevents partition reuse.
    const historicalSchema = deriveJsonSchema(WorkflowV2FactorHarvestOutputSchema);
    if (canonicalJson(jsonSchema) === canonicalJson(deriveJsonSchema(BoundedWorkflowV2FactorHarvestOutputSchema))) {
      Object.assign(jsonSchema, historicalSchema);
    }
    const evidence = structuredClone(value.evidence) as unknown;
    if (Array.isArray(evidence)) {
      const partition = evidence[0] as { sourceId?: unknown; content?: unknown } | undefined;
      if (partition && typeof partition === "object") {
        // The envelope ID and sources identify the partition. Compare every other evidence field.
        partition.sourceId = "factor-harvest:partition";
        if (partition.content && typeof partition.content === "object" && !Array.isArray(partition.content)) {
          delete (partition.content as Record<string, unknown>).sources;
        }
      }
    }
    return { model: value.model, reasoningEffort: value.reasoningEffort, workOrder,
      evidence, jsonSchema, repairPolicy: value.repairPolicy,
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
  if (requestedSources.some((source) => {
    const saved = savedById.get(String(source.id));
    return !saved || canonicalJson(saved) !== canonicalJson(source);
  })) return null;
  return new Set(requestedSources.map((source) => String(source.id)));
}

function boundedExcerpt(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (normalized.length <= maxCharacters) return normalized;
  // Zod counts UTF-16 units; preserve whole code points while meeting its text ceiling.
  let units = 0;
  const end = characters.findIndex((character) => {
    units += character.length;
    return units > maxCharacters - 1;
  });
  return `${characters.slice(0, end).join("")}…`;
}

function compactFactorExplanations(factor: ReturnType<typeof WorkflowV2FactorHarvestOutputSchema.parse>["factors"][number]) {
  return {
    ...factor,
    uncertainty: boundedExcerpt(factor.uncertainty, FACTOR_EXPLANATION_CHARACTERS),
    ...("demandEvidenceUncertainty" in factor
      ? { demandEvidenceUncertainty: boundedExcerpt(factor.demandEvidenceUncertainty, FACTOR_EXPLANATION_CHARACTERS) } : {}),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function factorIdentity(factor: { sourceId: string; subject: string; quote: string }): string {
  return `${factor.sourceId}\u0000${factor.subject.trim()}\u0000${factor.quote.trim()}`;
}
