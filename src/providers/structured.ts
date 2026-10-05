import type { z } from "zod";
import type { ModelRef, ReasoningEffort } from "../shared/schemas";
import type { SchemaValidationFailure } from "../shared/generation-diagnostics";
import type {
  AttemptUsage,
  EvidenceSource,
  WorkOrder,
} from "../shared/runtime-protocol";

export type ProviderFailureCode =
  | "cancelled"
  | "interrupted"
  | "timeout"
  | "auth"
  | "rate-limit"
  | "schema"
  | "output-limit"
  | "unavailable"
  | "failed";

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; attempts?: GenerationAttemptMetadata[]; runtimeCode?: string; unretainedSchemaFailure?: SchemaValidationFailure },
  ) {
    super(message, options);
    this.name = "ProviderFailure";
    this.attempts = options?.attempts;
    this.runtimeCode = options?.runtimeCode;
    this.unretainedSchemaFailure = options?.unretainedSchemaFailure;
  }

  readonly attempts: GenerationAttemptMetadata[] | undefined;
  readonly runtimeCode: string | undefined;
  readonly unretainedSchemaFailure: SchemaValidationFailure | undefined;
  /** The app records the physical call's UUID so outer retries acknowledge only that lost call. */
  failedGenerationId?: string;
}

/**
 * True when a dispatched call lost its provider stream: the provider may have finished, but the result
 * never arrived. A lost runtime process carries no provider attempts and is not a dropped stream.
 */
export function isDroppedStream(error: unknown): boolean {
  return error instanceof ProviderFailure && error.code === "interrupted"
    && Boolean(error.attempts?.some((attempt) => attempt.providerCompletion === "unknown"));
}

export type { AttemptUsage };

export type FinishReason = "stop" | "length" | "content_filter" | { other: string };
export type AttemptCost =
  | { status: "reported"; value: { amount: number; currency?: string | undefined } }
  | { status: "not_reported" }
  | { status: "unknown" };
export interface GenerationAttemptMetadata {
  attempt: "initial" | "schema_repair";
  outcome: "completed" | "failed" | "cancelled" | "deadline_exceeded";
  providerCompletion: "confirmed" | "unknown";
  model: ModelRef;
  usage: AttemptUsage;
  cost: AttemptCost;
  finishReason?: FinishReason | undefined;
  latencyMs: number;
  providerRequestId?: string | undefined;
  reasoningSummary?: string | undefined;
}
export interface GenerationMetadata {
  model: ModelRef;
  prompt?: { id: string; sha256: string } | undefined;
  usage: AttemptUsage;
  providerCosts?: Array<{ amount: number; currency?: string | undefined }> | undefined;
  finishReason?: FinishReason | undefined;
  latencyMs: number;
  repairCount: number;
  providerRequestIds: string[];
  reasoningSummary?: string | undefined;
  attempts: GenerationAttemptMetadata[];
}

export interface GenerationAcceptanceMetadata {
  protocolVersion?: string;
  runtimeVersion?: string;
  runtimeSourceSha?: string;
  runtimeExecutableSha256?: string;
  compilerPrompt?: {
    id: string;
    sha256: string;
  };
}

export interface StructuredStageRequest<T> {
  generationId: string;
  stage: string;
  model: ModelRef;
  reasoningEffort: ReasoningEffort;
  reasoningSummaries?: boolean;
  workOrder: WorkOrder;
  evidence: EvidenceSource[];
  /** Input is unknown: a schema may repair app-owned fields before validating. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  jsonSchema: object;
  repairPolicy: "disabled" | "one_retry";
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Optional for explicit bounded probes, measured from the request including queue time. */
  deadlineMs?: number;
  /**
   * Longest one provider call may run once the runtime starts it; queue time does not count.
   * Research sets this so a stalled or runaway call fails with `timeout` instead of holding the run.
   */
  callTimeLimitMs?: number;
  onDispatched?: () => void;
  onAccepted?: (metadata: GenerationAcceptanceMetadata) => void;
  /** Synchronous durable app checkpoint before a confirmed invalid response can enter schema repair. */
  onSchemaInvalid?: (failure: SchemaValidationFailure) => void;
}

export interface StructuredStageResult<T> {
  output: T;
  metadata: GenerationMetadata;
}

export interface StructuredModelClient {
  preparedIdentity?(): GenerationAcceptanceMetadata;
  prepareIdentity?(): Promise<GenerationAcceptanceMetadata>;
  structuredCompletion<T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>>;
}
