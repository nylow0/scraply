import { createHash, randomUUID } from "node:crypto";
import {
  assertWorkflowV2DecisionAnalysisSemantics,
  parseWorkflowV2StageOutput,
  WORKFLOW_VERSION_V2,
  type WorkflowV2StageId,
} from "../../core/stages";
import type { ResolvedWorkflowV2Prompt } from "../../core/prompts";
import {
  WorkflowV2DecisionAnalysisOutputSchema,
  WorkflowV2SolutionOptionSchema,
  WorkflowV2StartupSolutionOptionSchema,
  WorkflowV2SolutionsOutputSchema,
  type WorkflowV2DecisionAnalysis,
  type WorkflowV2SolutionOption,
} from "../../shared/structured-output-schemas";
import type { DatabaseClient } from "../client";
import { DEFAULT_IDEA_COUNT, RunConfigSchema } from "../../shared/schemas";

export class WorkflowV2ConflictError extends Error {
  readonly code = "WORKFLOW_V2_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowV2ConflictError";
  }
}

export class WorkflowV2ContextMismatchError extends Error {
  readonly code = "WORKFLOW_CONTEXT_MISMATCH_NEW_RUN_REQUIRED";

  constructor() {
    super("The decision context changed; create a new v2 run instead of mixing checkpoint inputs");
    this.name = "WorkflowV2ContextMismatchError";
  }
}

export interface WorkflowV2EvidenceSnapshot {
  sourceId: string;
  content: unknown;
}

export interface CompletedWorkflowV2Stage<T = unknown> {
  id?: string;
  researchRunId: string;
  stageId: WorkflowV2StageId;
  selectionId?: string | null;
  context: unknown;
  output: T;
  prompt: ResolvedWorkflowV2Prompt;
  schema: unknown;
  inputs: unknown;
  evidence: WorkflowV2EvidenceSnapshot[];
  runtimePrompt: { id: string; sha256: string };
  effectiveRequest: unknown;
}

export interface SavedWorkflowV2Stage<T = unknown> {
  id: string;
  researchRunId: string;
  stageId: WorkflowV2StageId;
  selectionId: string | null;
  context: unknown;
  output: T;
  prompt: ResolvedWorkflowV2Prompt;
  schema: unknown;
  inputs: unknown;
  evidence: WorkflowV2EvidenceSnapshot[];
  evidenceIdentities: Array<{ sourceId: string; contentSha256: string }>;
  runtimePrompt: { id: string; sha256: string };
  effectiveRequest: unknown;
  completedAt: string;
}

export type WorkflowV2StageResumeState =
  | { kind: "not-started" }
  | { kind: "unknown-completion" }
  | { kind: "reusable"; result: SavedWorkflowV2Stage };

export interface SaveResult {
  id: string;
  created: boolean;
}

interface StageResultRow {
  id: string;
  research_run_id: string;
  stage_id: WorkflowV2StageId;
  selection_key: string;
  workflow_version: number;
  stage_revision: number;
  context_json: string;
  context_sha256: string;
  output_json: string;
  output_sha256: string;
  prompt_filename: string;
  prompt_source: "bundled" | "override";
  prompt_text: string;
  prompt_sha256: string;
  current_bundled_prompt_sha256: string;
  override_baseline_revision: 1 | null;
  override_baseline_sha256: string | null;
  schema_json: string;
  schema_sha256: string;
  input_json: string;
  input_sha256: string;
  evidence_json: string;
  evidence_ids_json: string;
  evidence_ids_sha256: string;
  evidence_sha256: string;
  runtime_prompt_id: string;
  runtime_prompt_sha256: string;
  effective_request_json: string;
  effective_request_sha256: string;
  completed_at: string;
}

export class WorkflowV2Repository {
  constructor(private readonly client: DatabaseClient) {}

  saveSolutionOptions(
    researchRunId: string,
    problemId: string,
    options: Array<WorkflowV2SolutionOption & { id: string }>,
  ): { created: boolean } {
    this.client.requireImmediateTransaction();
    const run = this.client.db.prepare("SELECT config_json FROM research_runs WHERE id = ?")
      .get(researchRunId) as { config_json: string } | undefined;
    if (!run) throw new Error("The development run is missing");
    const ideaCount = RunConfigSchema.parse(JSON.parse(run.config_json)).ideaCount ?? DEFAULT_IDEA_COUNT;
    if (options.length > ideaCount) throw new Error(`This run requested at most ${ideaCount} ideas`);
    const parsed: Array<WorkflowV2SolutionOption & { id: string }> = options.map((option) => {
      const { id, ...candidate } = option;
      const schema = "startupOpportunity" in candidate
        ? WorkflowV2StartupSolutionOptionSchema
        : WorkflowV2SolutionOptionSchema;
      const parsedCandidate: WorkflowV2SolutionOption = schema.parse(candidate);
      return { ...parsedCandidate, id };
    });
    this.requireV2Run(researchRunId, problemId);
    const existing = this.client.db.prepare(`
      SELECT id, mechanism, description, respects_off_limits, respects_off_limits_why,
        option_position, key_assumption, why_current_approach_may_suffice,
        supporting_evidence_ids_json, contrary_evidence_ids_json, unknowns_json,
        startup_opportunity_json
      FROM solutions WHERE research_run_id = ? ORDER BY option_position, id
    `).all(researchRunId);
    const expected = parsed.map((option, position) => optionRow(option, position));
    if (existing.length > 0) {
      if (canonicalJson(existing) !== canonicalJson(expected)) {
        throw new WorkflowV2ConflictError("This run already has a different set of solution options");
      }
      return { created: false };
    }
    const completedOptions = this.client.db.prepare(`
      SELECT output_json FROM stage_results
      WHERE research_run_id = ? AND stage_id = 'solutions' AND selection_key = ''
    `).get(researchRunId) as { output_json: string } | undefined;
    if (completedOptions) {
      if (parsed.length === 0
        && WorkflowV2SolutionsOutputSchema.parse(JSON.parse(completedOptions.output_json)).options.length === 0) {
        return { created: false };
      }
      throw new WorkflowV2ConflictError("This run already completed a different solution-options checkpoint");
    }

    const now = new Date().toISOString();
    const insert = this.client.db.prepare(`
      INSERT INTO solutions (
        id, problem_id, research_run_id, mechanism, description, respects_off_limits,
        respects_off_limits_why, option_position, key_assumption,
        why_current_approach_may_suffice, supporting_evidence_ids_json,
        contrary_evidence_ids_json, unknowns_json, created_at,
        startup_opportunity_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [position, option] of parsed.entries()) {
      insert.run(
        option.id,
        problemId,
        researchRunId,
        option.mechanism,
        option.description,
        option.respectsOffLimits ? 1 : 0,
        option.respectsOffLimitsWhy,
        position,
        option.keyAssumption,
        option.whyCurrentApproachMaySuffice,
        canonicalJson(option.supportingEvidenceIds),
        canonicalJson(option.contraryEvidenceIds),
        canonicalJson(option.unknowns),
        now,
        option.startupOpportunity ? canonicalJson(option.startupOpportunity) : null,
      );
    }
    return { created: true };
  }

  selectSolution(researchRunId: string, solutionId: string): { selectedAt: string; created: boolean } {
    this.client.requireImmediateTransaction();
    this.requireV2Run(researchRunId);
    const solution = this.client.db.prepare(`
      SELECT id FROM solutions WHERE id = ? AND research_run_id = ?
    `).get(solutionId, researchRunId) as { id: string } | undefined;
    if (!solution) throw new Error("Solution option does not belong to this v2 run");
    const selected = this.client.db.prepare(`
      SELECT id, selected_at FROM solutions
      WHERE research_run_id = ? AND selected_at IS NOT NULL
    `).get(researchRunId) as { id: string; selected_at: string } | undefined;
    if (selected?.id === solutionId) return { selectedAt: selected.selected_at, created: false };
    if (selected) throw new WorkflowV2ConflictError("This run already has a different selected option");
    const selectedAt = new Date().toISOString();
    this.client.db.prepare("UPDATE solutions SET selected_at = ? WHERE id = ? AND research_run_id = ?")
      .run(selectedAt, solutionId, researchRunId);
    return { selectedAt, created: true };
  }

  saveStageResult<T>(stage: CompletedWorkflowV2Stage<T>): SaveResult {
    this.client.requireImmediateTransaction();
    this.requireV2Run(stage.researchRunId);
    if (stage.prompt.stageId !== stage.stageId) throw new Error("Resolved prompt does not match the stage");
    assertSha256(stage.prompt.resolvedSha256, "resolved prompt");
    assertSha256(stage.prompt.currentBundledSha256, "bundled prompt");
    assertSha256(stage.runtimePrompt.sha256, "runtime prompt");
    verifyHash(stage.prompt.text, stage.prompt.resolvedSha256, "resolved prompt");
    const parsedOutput = parseWorkflowV2StageOutput(stage.stageId, 1, stage.output, stage.evidence);
    const selectionKey = normalizeSelectionKey(stage.selectionId);
    const contextJson = canonicalJson(stage.context);
    const outputJson = canonicalJson(parsedOutput);
    const schemaJson = canonicalJson(stage.schema);
    const inputJson = canonicalJson(stage.inputs);
    const evidenceJson = canonicalJson(stage.evidence);
    const evidenceIdentities = evidenceIdentity(stage.evidence);
    const evidenceIdsJson = canonicalJson(evidenceIdentities);
    const effectiveRequestJson = canonicalJson({
      request: stage.effectiveRequest,
      runtimePrompt: stage.runtimePrompt,
    });
    const existing = this.stageRow(stage.researchRunId, stage.stageId, selectionKey);
    const identity = {
      contextSha256: sha256(contextJson),
      outputJson,
      outputSha256: sha256(outputJson),
      promptSha256: stage.prompt.resolvedSha256,
      schemaSha256: sha256(schemaJson),
      inputSha256: sha256(inputJson),
      evidenceSha256: sha256(evidenceJson),
      effectiveRequestSha256: sha256(effectiveRequestJson),
    };
    if (existing) {
      if (!sameStageIdentity(existing, identity)) {
        throw new WorkflowV2ConflictError("This stage already has a different completed checkpoint");
      }
      return { id: existing.id, created: false };
    }

    const id = stage.id ?? randomUUID();
    const completedAt = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO stage_results (
        id, research_run_id, stage_id, selection_key, workflow_version, stage_revision,
        context_json, context_sha256, output_json, output_sha256,
        prompt_filename, prompt_source,
        prompt_text, prompt_sha256, current_bundled_prompt_sha256,
        override_baseline_revision, override_baseline_sha256, schema_json, schema_sha256,
        input_json, input_sha256, evidence_json, evidence_ids_json, evidence_ids_sha256,
        evidence_sha256,
        runtime_prompt_id, runtime_prompt_sha256, effective_request_json,
        effective_request_sha256, completed_at
      ) VALUES (?, ?, ?, ?, 2, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      stage.researchRunId,
      stage.stageId,
      selectionKey,
      contextJson,
      identity.contextSha256,
      outputJson,
      identity.outputSha256,
      stage.prompt.filename,
      stage.prompt.source,
      stage.prompt.text,
      stage.prompt.resolvedSha256,
      stage.prompt.currentBundledSha256,
      stage.prompt.overrideBaseline?.revision ?? null,
      stage.prompt.overrideBaseline?.sha256 ?? null,
      schemaJson,
      identity.schemaSha256,
      inputJson,
      identity.inputSha256,
      evidenceJson,
      evidenceIdsJson,
      sha256(evidenceIdsJson),
      identity.evidenceSha256,
      stage.runtimePrompt.id,
      stage.runtimePrompt.sha256,
      effectiveRequestJson,
      identity.effectiveRequestSha256,
      completedAt,
    );
    return { id, created: true };
  }

  findStageResult(
    researchRunId: string,
    stageId: WorkflowV2StageId,
    selectionId?: string | null,
  ): SavedWorkflowV2Stage | null {
    const row = this.stageRow(researchRunId, stageId, normalizeSelectionKey(selectionId));
    return row ? decodeStageRow(row) : null;
  }

  getStageResumeState(input: {
    researchRunId: string;
    stageId: WorkflowV2StageId;
    selectionId?: string | null;
    context: unknown;
    identity?: {
      promptSha256: string;
      schema: unknown;
      inputs: unknown;
      evidence: WorkflowV2EvidenceSnapshot[];
    };
  }): WorkflowV2StageResumeState {
    const saved = this.findStageResult(input.researchRunId, input.stageId, input.selectionId);
    if (saved) {
      if (sha256(canonicalJson(input.context)) !== sha256(canonicalJson(saved.context))) {
        throw new WorkflowV2ContextMismatchError();
      }
      if (input.identity && (
        saved.prompt.resolvedSha256 !== input.identity.promptSha256
        || sha256(canonicalJson(saved.schema)) !== sha256(canonicalJson(input.identity.schema))
        || sha256(canonicalJson(saved.inputs)) !== sha256(canonicalJson(input.identity.inputs))
        || sha256(canonicalJson(saved.evidence)) !== sha256(canonicalJson(input.identity.evidence))
      )) throw new WorkflowV2ContextMismatchError();
      return { kind: "reusable", result: saved };
    }
    const ambiguous = this.client.db.prepare(`
      SELECT 1 FROM generation_attempts
      WHERE research_run_id = ? AND (stage_key = ? OR stage_key LIKE ?)
        AND (
          status IN ('dispatched', 'accepted')
          OR (status = 'interrupted' AND terminal_kind IS NOT 'never-dispatched')
        )
      LIMIT 1
    `).get(input.researchRunId, input.stageId, `${input.stageId}:%`);
    return ambiguous ? { kind: "unknown-completion" } : { kind: "not-started" };
  }

  saveDecisionAnalysis(input: {
    id?: string;
    researchRunId: string;
    solutionId: string;
    stageResultId: string;
    analysis: WorkflowV2DecisionAnalysis;
  }): SaveResult {
    this.client.requireImmediateTransaction();
    const analysis = WorkflowV2DecisionAnalysisOutputSchema.parse(input.analysis);
    assertWorkflowV2DecisionAnalysisSemantics(analysis);
    const selected = this.client.db.prepare(`
      SELECT id FROM solutions WHERE research_run_id = ? AND selected_at IS NOT NULL
    `).get(input.researchRunId) as { id: string } | undefined;
    if (!selected) throw new Error("Persist the human option selection before its analysis");
    if (selected.id !== input.solutionId) {
      throw new WorkflowV2ConflictError("Decision analysis does not target the selected option");
    }
    const checkpoint = this.client.db.prepare(`
      SELECT output_json FROM stage_results
      WHERE id = ? AND research_run_id = ? AND stage_id = 'decision-analysis' AND selection_key = ?
    `).get(input.stageResultId, input.researchRunId, input.solutionId) as { output_json: string } | undefined;
    const analysisJson = canonicalJson(analysis);
    if (!checkpoint || checkpoint.output_json !== analysisJson) {
      throw new Error("Decision analysis must match its completed stage checkpoint");
    }
    const existing = this.client.db.prepare(`
      SELECT id, stage_result_id, analysis_json FROM decision_analyses
      WHERE research_run_id = ? AND solution_id = ?
    `).get(input.researchRunId, input.solutionId) as {
      id: string;
      stage_result_id: string;
      analysis_json: string;
    } | undefined;
    if (existing) {
      if (existing.stage_result_id !== input.stageResultId || existing.analysis_json !== analysisJson) {
        throw new WorkflowV2ConflictError("The selected option already has a different decision analysis");
      }
      return { id: existing.id, created: false };
    }
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO decision_analyses (
        id, research_run_id, solution_id, stage_result_id, analysis_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.researchRunId, input.solutionId, input.stageResultId, analysisJson, now, now);
    return { id, created: true };
  }

  private stageRow(
    researchRunId: string,
    stageId: WorkflowV2StageId,
    selectionKey: string,
  ): StageResultRow | null {
    return this.client.db.prepare(`
      SELECT * FROM stage_results
      WHERE research_run_id = ? AND stage_id = ? AND selection_key = ?
    `).get(researchRunId, stageId, selectionKey) as StageResultRow | undefined ?? null;
  }

  private requireV2Run(researchRunId: string, problemId?: string): void {
    const run = this.client.db.prepare(`
      SELECT workflow_version, problem_id FROM research_runs WHERE id = ?
    `).get(researchRunId) as { workflow_version: number; problem_id: string | null } | undefined;
    if (!run) throw new Error("Research run not found");
    if (run.workflow_version !== WORKFLOW_VERSION_V2) throw new Error("Research run is not workflow v2");
    if (problemId !== undefined && run.problem_id !== problemId) {
      throw new Error("Research run does not target the supplied problem");
    }
  }
}

function optionRow(option: WorkflowV2SolutionOption & { id: string }, position: number) {
  return {
    id: option.id,
    mechanism: option.mechanism,
    description: option.description,
    respects_off_limits: option.respectsOffLimits ? 1 : 0,
    respects_off_limits_why: option.respectsOffLimitsWhy,
    option_position: position,
    key_assumption: option.keyAssumption,
    why_current_approach_may_suffice: option.whyCurrentApproachMaySuffice,
    supporting_evidence_ids_json: canonicalJson(option.supportingEvidenceIds),
    contrary_evidence_ids_json: canonicalJson(option.contraryEvidenceIds),
    unknowns_json: canonicalJson(option.unknowns),
    startup_opportunity_json: option.startupOpportunity ? canonicalJson(option.startupOpportunity) : null,
  };
}

function evidenceIdentity(evidence: WorkflowV2EvidenceSnapshot[]) {
  const ids = new Set<string>();
  return evidence.map((item) => {
    if (!item.sourceId.trim() || ids.has(item.sourceId)) {
      throw new Error("Stage evidence IDs must be nonempty and unique");
    }
    ids.add(item.sourceId);
    return { sourceId: item.sourceId, contentSha256: sha256(canonicalJson(item.content)) };
  });
}

function decodeStageRow(row: StageResultRow): SavedWorkflowV2Stage {
  if (row.workflow_version !== WORKFLOW_VERSION_V2) throw new Error("Invalid stored workflow version");
  verifyHash(row.prompt_text, row.prompt_sha256, "stored prompt");
  verifyHash(row.context_json, row.context_sha256, "stored context");
  verifyHash(row.output_json, row.output_sha256, "stored output");
  verifyHash(row.schema_json, row.schema_sha256, "stored schema");
  verifyHash(row.input_json, row.input_sha256, "stored input");
  verifyHash(row.evidence_json, row.evidence_sha256, "stored evidence");
  verifyHash(row.evidence_ids_json, row.evidence_ids_sha256, "stored evidence identities");
  verifyHash(row.effective_request_json, row.effective_request_sha256, "stored effective request");
  const evidence = JSON.parse(row.evidence_json) as WorkflowV2EvidenceSnapshot[];
  const output = parseWorkflowV2StageOutput(
    row.stage_id,
    row.stage_revision,
    JSON.parse(row.output_json),
    evidence,
  );
  return {
    id: row.id,
    researchRunId: row.research_run_id,
    stageId: row.stage_id,
    selectionId: row.selection_key || null,
    context: JSON.parse(row.context_json),
    output,
    prompt: {
      stageId: row.stage_id,
      filename: row.prompt_filename,
      revision: 1,
      source: row.prompt_source,
      currentBundledSha256: row.current_bundled_prompt_sha256,
      resolvedSha256: row.prompt_sha256,
      overrideBaseline: row.override_baseline_revision === null ? null : {
        revision: row.override_baseline_revision,
        sha256: row.override_baseline_sha256!,
      },
      text: row.prompt_text,
    },
    schema: JSON.parse(row.schema_json),
    inputs: JSON.parse(row.input_json),
    evidence,
    evidenceIdentities: JSON.parse(row.evidence_ids_json),
    runtimePrompt: { id: row.runtime_prompt_id, sha256: row.runtime_prompt_sha256 },
    effectiveRequest: JSON.parse(row.effective_request_json),
    completedAt: row.completed_at,
  };
}

function sameStageIdentity(
  row: StageResultRow,
  identity: {
    contextSha256: string;
    outputJson: string;
    outputSha256: string;
    promptSha256: string;
    schemaSha256: string;
    inputSha256: string;
    evidenceSha256: string;
    effectiveRequestSha256: string;
  },
): boolean {
  return row.context_sha256 === identity.contextSha256
    && row.output_json === identity.outputJson
    && row.output_sha256 === identity.outputSha256
    && row.prompt_sha256 === identity.promptSha256
    && row.schema_sha256 === identity.schemaSha256
    && row.input_sha256 === identity.inputSha256
    && row.evidence_sha256 === identity.evidenceSha256
    && row.effective_request_sha256 === identity.effectiveRequestSha256;
}

function normalizeSelectionKey(selectionId?: string | null): string {
  const key = selectionId ?? "";
  if (key.includes("\u0000")) throw new Error("Invalid stage selection ID");
  return key;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label} SHA-256`);
}

function verifyHash(value: string, expected: string, label: string): void {
  if (sha256(value) !== expected) throw new Error(`${label} snapshot hash mismatch`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Workflow snapshot contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalValue(object[key])]));
  }
  throw new Error("Workflow snapshot contains a non-JSON value");
}
