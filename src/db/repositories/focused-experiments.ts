import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import type { StructuredStageRequest } from "../../providers/structured";
import {
  FocusedDemandTestSchema,
  FocusedExperimentRecordSchema,
  NewFocusedExperimentSchema,
  type FocusedDemandTest,
  type FocusedExperimentRecord,
} from "../../shared/focused-experiment";
import { canonicalJson, sha256 } from "../../shared/content-identity";
import type { DatabaseClient } from "../client";

export type FocusedExperimentStageKey = "draft" | "initial-review" | "correction" | "final-review";

export const FOCUSED_EXPERIMENT_MIGRATION_SQL = `
  CREATE TABLE focused_experiment_stage_results (
    id TEXT PRIMARY KEY,
    research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    solution_id TEXT NOT NULL,
    stage_key TEXT NOT NULL CHECK(stage_key IN ('draft', 'initial-review', 'correction', 'final-review')),
    stage_revision INTEGER NOT NULL CHECK(stage_revision = 1),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    identity_sha256 TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    prompt_text TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL,
    schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
    input_json TEXT NOT NULL CHECK(json_valid(input_json)),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    output_json TEXT NOT NULL CHECK(json_valid(output_json)),
    completed_at TEXT NOT NULL,
    UNIQUE(research_run_id, solution_id, stage_key),
    FOREIGN KEY (solution_id, research_run_id)
      REFERENCES solutions(id, research_run_id) ON DELETE CASCADE
  );

  CREATE TABLE focused_experiments (
    id TEXT PRIMARY KEY,
    research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    solution_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('approved', 'needs_revision')),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(research_run_id, solution_id),
    FOREIGN KEY (solution_id, research_run_id)
      REFERENCES solutions(id, research_run_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_focused_experiments_run
    ON focused_experiments(research_run_id, created_at, id);

  CREATE TRIGGER prevent_focused_experiment_stage_update
  BEFORE UPDATE ON focused_experiment_stage_results
  BEGIN
    SELECT RAISE(ABORT, 'completed focused experiment stages are immutable');
  END;

`;

export const FOCUSED_DEMAND_TEST_MIGRATION_SQL = `
  CREATE TABLE focused_demand_tests (
    research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    solution_id TEXT NOT NULL,
    test_json TEXT NOT NULL CHECK(json_valid(test_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(research_run_id, solution_id),
    FOREIGN KEY (solution_id, research_run_id)
      REFERENCES solutions(id, research_run_id) ON DELETE CASCADE
  );

  CREATE TRIGGER prevent_focused_demand_test_update
  BEFORE UPDATE ON focused_demand_tests
  BEGIN
    SELECT RAISE(ABORT, 'focused demand tests are immutable');
  END;
`;

export interface FocusedExperimentStageCheckpoint<T> {
  request: StructuredStageRequest<T>;
  instruction: string;
  output: T;
}

export interface FocusedExperimentExport {
  schemaVersion: 1;
  threadId: string;
  experiments: Array<{
    researchRunId: string;
    solutionId: string;
    shortDemandTest: FocusedDemandTest | null;
    record: FocusedExperimentRecord | null;
    stages: Array<{
      stageKey: FocusedExperimentStageKey;
      stageRevision: 1;
      model: { providerId: string; modelId: string };
      reasoningEffort: string;
      request: unknown;
      prompt: { text: string; sha256: string };
      schema: unknown;
      inputs: unknown;
      evidence: unknown;
      output: unknown;
      completedAt: string;
    }>;
    generationAttempts: Array<{
      generationId: string;
      stageKey: string;
      status: string;
      model: { providerId: string; modelId: string };
      reasoningEffort: string;
      request: unknown;
      output: unknown | null;
      error: { code: string | null; message: string | null } | null;
      metadata: unknown | null;
      createdAt: string;
      terminalAt: string | null;
    }>;
  }>;
}

export class FocusedExperimentRepository {
  constructor(private readonly client: DatabaseClient) {}

  findDemandTest(researchRunId: string, solutionId: string): FocusedDemandTest | null {
    const row = this.client.db.prepare(`
      SELECT test_json
      FROM focused_demand_tests
      WHERE research_run_id = ? AND solution_id = ?
    `).get(researchRunId, solutionId) as { test_json: string } | undefined;
    return row ? FocusedDemandTestSchema.parse(JSON.parse(row.test_json)) : null;
  }

  saveDemandTests(
    researchRunId: string,
    tests: Array<{ solutionId: string; test: FocusedDemandTest }>,
  ): void {
    const insert = this.client.db.prepare(`
      INSERT INTO focused_demand_tests (research_run_id, solution_id, test_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const item of tests) {
      const parsed = FocusedDemandTestSchema.parse(item.test);
      const existing = this.findDemandTest(researchRunId, item.solutionId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(parsed)) {
          throw new Error(`Focused demand test for solution ${item.solutionId} is immutable`);
        }
        continue;
      }
      insert.run(researchRunId, item.solutionId, canonicalJson(parsed), now);
    }
  }

  exportExperiments(threadId: string): FocusedExperimentExport {
    const identities = this.client.db.prepare(`
      SELECT DISTINCT identity.research_run_id, identity.solution_id
      FROM (
        SELECT research_run_id, solution_id FROM focused_demand_tests
        UNION
        SELECT research_run_id, solution_id FROM focused_experiments
        UNION
        SELECT research_run_id, solution_id FROM focused_experiment_stage_results
      ) identity
      JOIN research_runs run ON run.id = identity.research_run_id
      WHERE run.thread_id = ?
      ORDER BY identity.research_run_id, identity.solution_id
    `).all(threadId) as Array<{ research_run_id: string; solution_id: string }>;
    return {
      schemaVersion: 1,
      threadId,
      experiments: identities.map((identity) => ({
        researchRunId: identity.research_run_id,
        solutionId: identity.solution_id,
        shortDemandTest: this.findDemandTest(identity.research_run_id, identity.solution_id),
        record: this.findRecord(identity.research_run_id, identity.solution_id),
        stages: this.exportStages(identity.research_run_id, identity.solution_id),
        generationAttempts: this.exportGenerationAttempts(identity.research_run_id, identity.solution_id),
      })),
    };
  }

  findRecord(researchRunId: string, solutionId: string): FocusedExperimentRecord | null {
    const row = this.client.db.prepare(`
      SELECT record_json
      FROM focused_experiments
      WHERE research_run_id = ? AND solution_id = ?
    `).get(researchRunId, solutionId) as { record_json: string } | undefined;
    return row ? FocusedExperimentRecordSchema.parse(JSON.parse(row.record_json)) : null;
  }

  saveRecord(researchRunId: string, solutionId: string, record: FocusedExperimentRecord): void {
    const parsed = FocusedExperimentRecordSchema.parse(record);
    const existing = this.findRecord(researchRunId, solutionId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed)) {
        throw new Error("A focused experiment is already saved for this option");
      }
      return;
    }
    NewFocusedExperimentSchema.parse(parsed.plan);
    const now = new Date().toISOString();
    this.client.db.prepare(`
      INSERT INTO focused_experiments (
        id, research_run_id, solution_id, status, record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), researchRunId, solutionId, parsed.status, canonicalJson(parsed), now, now);
  }

  findStage<T>(
    researchRunId: string,
    solutionId: string,
    stageKey: FocusedExperimentStageKey,
    request: StructuredStageRequest<T>,
    instruction: string,
    schema: ZodType<T>,
  ): T | null {
    const row = this.client.db.prepare(`
      SELECT identity_sha256, output_json
      FROM focused_experiment_stage_results
      WHERE research_run_id = ? AND solution_id = ? AND stage_key = ?
    `).get(researchRunId, solutionId, stageKey) as { identity_sha256: string; output_json: string } | undefined;
    if (!row) return null;
    const identity = focusedExperimentStageIdentity(request, instruction);
    if (row.identity_sha256 !== identity) {
      throw new Error(`Saved focused experiment ${stageKey} input changed. Start a new run.`);
    }
    return schema.parse(JSON.parse(row.output_json));
  }

  saveStage<T>(
    researchRunId: string,
    solutionId: string,
    stageKey: FocusedExperimentStageKey,
    checkpoint: FocusedExperimentStageCheckpoint<T>,
  ): void {
    const identity = focusedExperimentStageIdentity(checkpoint.request, checkpoint.instruction);
    const existing = this.client.db.prepare(`
      SELECT identity_sha256, output_json
      FROM focused_experiment_stage_results
      WHERE research_run_id = ? AND solution_id = ? AND stage_key = ?
    `).get(researchRunId, solutionId, stageKey) as { identity_sha256: string; output_json: string } | undefined;
    const outputJson = canonicalJson(checkpoint.output);
    if (existing) {
      if (existing.identity_sha256 !== identity || existing.output_json !== outputJson) {
        throw new Error(`Focused experiment ${stageKey} checkpoint is immutable`);
      }
      return;
    }
    this.client.db.prepare(`
      INSERT INTO focused_experiment_stage_results (
        id, research_run_id, solution_id, stage_key, stage_revision,
        provider_id, model_id, reasoning_effort, identity_sha256,
        request_json, prompt_text, prompt_sha256, schema_json, input_json,
        evidence_json, output_json, completed_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      researchRunId,
      solutionId,
      stageKey,
      checkpoint.request.model.providerId,
      checkpoint.request.model.modelId,
      checkpoint.request.reasoningEffort,
      identity,
      canonicalJson(requestSnapshot(checkpoint.request)),
      checkpoint.instruction,
      sha256(checkpoint.instruction),
      canonicalJson(checkpoint.request.jsonSchema),
      canonicalJson(checkpoint.request.workOrder.inputs ?? null),
      canonicalJson(checkpoint.request.evidence),
      outputJson,
      new Date().toISOString(),
    );
  }

  private exportStages(researchRunId: string, solutionId: string): FocusedExperimentExport["experiments"][number]["stages"] {
    const rows = this.client.db.prepare(`
      SELECT stage_key, stage_revision, provider_id, model_id, reasoning_effort,
        request_json, prompt_text, prompt_sha256, schema_json, input_json,
        evidence_json, output_json, completed_at
      FROM focused_experiment_stage_results
      WHERE research_run_id = ? AND solution_id = ?
      ORDER BY rowid
    `).all(researchRunId, solutionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      stageKey: String(row.stage_key) as FocusedExperimentStageKey,
      stageRevision: 1,
      model: { providerId: String(row.provider_id), modelId: String(row.model_id) },
      reasoningEffort: String(row.reasoning_effort),
      request: parseJson(row.request_json),
      prompt: { text: String(row.prompt_text), sha256: String(row.prompt_sha256) },
      schema: parseJson(row.schema_json),
      inputs: parseJson(row.input_json),
      evidence: parseJson(row.evidence_json),
      output: parseJson(row.output_json),
      completedAt: String(row.completed_at),
    }));
  }

  private exportGenerationAttempts(
    researchRunId: string,
    solutionId: string,
  ): FocusedExperimentExport["experiments"][number]["generationAttempts"] {
    const rows = this.client.db.prepare(`
      SELECT generation_id, stage_key, status, provider_id, model_id, reasoning_effort,
        request_json, output_json, error_code, error_message, attempt_metadata_json,
        created_at, terminal_at
      FROM generation_attempts
      WHERE research_run_id = ? AND stage_key LIKE 'focused-experiment:%'
      ORDER BY created_at, rowid
    `).all(researchRunId) as Array<Record<string, unknown>>;
    return rows.filter((row) => {
      const request = parseJson(row.request_json);
      if (!request || typeof request !== "object" || Array.isArray(request)) return false;
      const workOrder = (request as Record<string, unknown>).workOrder;
      if (!workOrder || typeof workOrder !== "object" || Array.isArray(workOrder)) return false;
      const inputs = (workOrder as Record<string, unknown>).inputs;
      return Boolean(inputs && typeof inputs === "object" && !Array.isArray(inputs)
        && (inputs as Record<string, unknown>).solutionId === solutionId);
    }).map((row) => ({
      generationId: String(row.generation_id),
      stageKey: String(row.stage_key),
      status: String(row.status),
      model: { providerId: String(row.provider_id), modelId: String(row.model_id) },
      reasoningEffort: String(row.reasoning_effort),
      request: parseJson(row.request_json),
      output: row.output_json === null ? null : parseJson(row.output_json),
      error: row.error_code === null && row.error_message === null
        ? null
        : { code: row.error_code === null ? null : String(row.error_code), message: row.error_message === null ? null : String(row.error_message) },
      metadata: row.attempt_metadata_json === null ? null : parseJson(row.attempt_metadata_json),
      createdAt: String(row.created_at),
      terminalAt: row.terminal_at === null ? null : String(row.terminal_at),
    }));
  }
}

export function focusedExperimentStageIdentity<T>(request: StructuredStageRequest<T>, instruction: string): string {
  return sha256(canonicalJson({ instruction, request: requestSnapshot(request) }));
}

function requestSnapshot<T>(request: StructuredStageRequest<T>): Record<string, unknown> {
  return {
    stage: request.stage,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    workOrder: request.workOrder,
    evidence: request.evidence,
    jsonSchema: request.jsonSchema,
    repairPolicy: request.repairPolicy,
    deadlineMs: request.deadlineMs,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
  };
}


function parseJson(value: unknown): unknown {
  return JSON.parse(String(value)) as unknown;
}
