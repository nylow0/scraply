import { createHash, randomUUID } from "node:crypto";
import type { GenerationAcceptanceMetadata, StructuredStageRequest } from "../../providers/structured";
import type { DatabaseClient } from "../client";

export type GenerationAttemptStatus =
  | "prepared"
  | "dispatched"
  | "accepted"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface PreparedGenerationAttempt {
  id: string;
  generationId: string;
  wireRequestSha256: string;
  requestSha256: string;
}

export interface GenerationTerminalRecord {
  status: Extract<GenerationAttemptStatus, "completed" | "failed" | "cancelled" | "interrupted">;
  terminalKind: string;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  attemptMetadata?: unknown;
  usage?: unknown;
  reportedCostUsd?: number;
}

export interface ReusableGeneration<T> {
  output: T;
  metadata: unknown;
}

export class GenerationAttemptRepository {
  constructor(private readonly client: DatabaseClient) {}

  prepare<T>(
    researchRunId: string,
    request: StructuredStageRequest<T>,
    runtimeIdentity: GenerationAcceptanceMetadata = {},
  ): PreparedGenerationAttempt {
    const id = randomUUID();
    const effectiveRequest = effectiveRequestSnapshot(request, runtimeIdentity);
    const requestJson = canonicalJson({ generationId: request.generationId, ...effectiveRequest });
    const now = new Date().toISOString();
    const wireRequestSha256 = sha256(requestJson);
    const requestSha256 = sha256(canonicalJson(effectiveRequest));
    this.client.db.prepare(`
      INSERT INTO generation_attempts (
        id, generation_id, research_run_id, stage_key, provider_id, model_id,
        reasoning_effort, status, request_json, wire_request_sha256, request_sha256,
        work_order_sha256, inputs_sha256, evidence_sha256, schema_sha256,
        protocol_version, runtime_version, runtime_source_sha, runtime_executable_sha256,
        runtime_prompt_id, runtime_prompt_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      request.generationId,
      researchRunId,
      request.stage,
      request.model.providerId,
      request.model.modelId,
      request.reasoningEffort,
      requestJson,
      wireRequestSha256,
      requestSha256,
      sha256(canonicalJson(request.workOrder)),
      sha256(canonicalJson(request.workOrder.inputs ?? null)),
      sha256(canonicalJson(request.evidence)),
      sha256(canonicalJson(request.jsonSchema)),
      runtimeIdentity.protocolVersion ?? null,
      runtimeIdentity.runtimeVersion ?? null,
      runtimeIdentity.runtimeSourceSha ?? null,
      runtimeIdentity.runtimeExecutableSha256 ?? null,
      runtimeIdentity.compilerPrompt?.id ?? null,
      runtimeIdentity.compilerPrompt?.sha256 ?? null,
      now,
      now,
    );
    return { id, generationId: request.generationId, wireRequestSha256, requestSha256 };
  }

  findCompleted<T>(
    researchRunId: string,
    request: StructuredStageRequest<T>,
    runtimeIdentity: GenerationAcceptanceMetadata = {},
  ): ReusableGeneration<T> | null {
    const requestSha256 = sha256(canonicalJson(effectiveRequestSnapshot(request, runtimeIdentity)));
    const row = this.client.db.prepare(`
      SELECT output_json, attempt_metadata_json
      FROM generation_attempts
      WHERE research_run_id = ? AND request_sha256 = ? AND status = 'completed'
      ORDER BY terminal_at DESC LIMIT 1
    `).get(researchRunId, requestSha256) as { output_json: string; attempt_metadata_json: string } | undefined;
    if (!row) return null;
    return {
      output: request.schema.parse(JSON.parse(row.output_json)),
      metadata: JSON.parse(row.attempt_metadata_json),
    };
  }

  markDispatched(id: string): void {
    this.client.db.prepare(`
      UPDATE generation_attempts SET status = 'dispatched', updated_at = ?
      WHERE id = ? AND status = 'prepared'
    `).run(new Date().toISOString(), id);
  }

  markAccepted(id: string, identity: GenerationAcceptanceMetadata): void {
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE generation_attempts
      SET status = 'accepted', protocol_version = ?, runtime_version = ?,
          runtime_source_sha = ?, runtime_executable_sha256 = ?,
          runtime_prompt_id = ?, runtime_prompt_sha256 = ?, accepted_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('prepared', 'dispatched')
    `).run(
      identity.protocolVersion ?? null,
      identity.runtimeVersion ?? null,
      identity.runtimeSourceSha ?? null,
      identity.runtimeExecutableSha256 ?? null,
      identity.compilerPrompt?.id ?? null,
      identity.compilerPrompt?.sha256 ?? null,
      now,
      now,
      id,
    );
  }

  recordTerminal(id: string, terminal: GenerationTerminalRecord): void {
    if (terminal.reportedCostUsd !== undefined && (!Number.isFinite(terminal.reportedCostUsd) || terminal.reportedCostUsd < 0)) {
      throw new Error("Invalid provider-reported cost");
    }
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE generation_attempts
      SET status = ?, terminal_kind = ?, output_json = ?, error_code = ?, error_message = ?,
          attempt_metadata_json = ?, usage_json = ?, reported_cost_usd = ?, terminal_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('prepared', 'dispatched', 'accepted')
    `).run(
      terminal.status,
      terminal.terminalKind,
      terminal.output === undefined ? null : canonicalJson(terminal.output),
      terminal.errorCode ?? null,
      terminal.errorMessage ?? null,
      terminal.attemptMetadata === undefined ? null : canonicalJson(terminal.attemptMetadata),
      terminal.usage === undefined ? null : canonicalJson(terminal.usage),
      terminal.reportedCostUsd ?? null,
      now,
      now,
      id,
    );
    const changed = this.client.db.prepare("SELECT changes() AS count").get() as { count: number };
    if (changed.count !== 1) throw new Error("Generation attempt already has a terminal result");
  }

  interruptInFlight(reason: string): number {
    const pending = this.client.db.prepare(`
      SELECT COUNT(*) AS count FROM generation_attempts WHERE status IN ('prepared', 'dispatched', 'accepted')
    `).get() as { count: number };
    const now = new Date().toISOString();
    this.client.db.prepare(`
      UPDATE generation_attempts
      SET status = 'interrupted', terminal_kind = 'never-dispatched', error_message = ?,
          terminal_at = ?, updated_at = ?
      WHERE status = 'prepared'
    `).run(reason, now, now);
    this.client.db.prepare(`
      UPDATE generation_attempts
      SET status = 'interrupted', terminal_kind = 'process-lost', error_message = ?,
          terminal_at = ?, updated_at = ?
      WHERE status IN ('dispatched', 'accepted')
    `).run(reason, now, now);
    return pending.count;
  }
}

function effectiveRequestSnapshot<T>(
  request: StructuredStageRequest<T>,
  runtimeIdentity: GenerationAcceptanceMetadata,
): Record<string, unknown> {
  return {
    version: 1,
    stage: request.stage,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    workOrder: request.workOrder,
    evidence: request.evidence,
    jsonSchema: request.jsonSchema,
    repairPolicy: request.repairPolicy,
    deadlineMs: request.deadlineMs,
    compilerPrompt: runtimeIdentity.compilerPrompt ?? null,
    maxOutputTokens: request.maxOutputTokens ?? null,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Generation snapshot contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalValue(object[key])]));
  }
  throw new Error("Generation snapshot contains a non-JSON value");
}
