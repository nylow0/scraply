import type { z } from "zod";
import type { ModelRef, ReasoningEffort } from "../shared/schemas";
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
  | "unavailable"
  | "failed";

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; attempts?: GenerationAttemptMetadata[]; runtimeCode?: string },
  ) {
    super(message, options);
    this.name = "ProviderFailure";
    this.attempts = options?.attempts;
    this.runtimeCode = options?.runtimeCode;
  }

  readonly attempts: GenerationAttemptMetadata[] | undefined;
  readonly runtimeCode: string | undefined;
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
  workOrder: WorkOrder;
  evidence: EvidenceSource[];
  schema: z.ZodType<T>;
  jsonSchema: object;
  repairPolicy: "disabled" | "one_retry";
  maxOutputTokens?: number;
  signal?: AbortSignal;
  deadlineMs: number;
  onDispatched?: () => void;
  onAccepted?: (metadata: GenerationAcceptanceMetadata) => void;
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
