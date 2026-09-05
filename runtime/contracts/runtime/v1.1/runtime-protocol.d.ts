export type ProtocolVersion = "1.1";
export type RequestId = string | number;
export type RuntimeCapability = "envelope_limits" | "account_refresh" | "credential_persistence_ack" | "generation_attempt_metadata" | "exactly_one_terminal";
export type RuntimeOperation = "runtime.initialize" | "account.list" | "account.login.start" | "account.login.complete" | "account.login.cancel" | "account.logout" | "account.refresh" | "credential.session.set" | "credential.session.persisted" | "model.list" | "generation.start" | "generation.cancel" | "runtime.shutdown";

export interface RequestEnvelope<TOperation extends RuntimeOperation = RuntimeOperation, TPayload extends object = object> {
  protocolVersion: ProtocolVersion;
  id: RequestId;
  operation: TOperation;
  payload: TPayload;
}

export interface SuccessEnvelope<TOperation extends RuntimeOperation = RuntimeOperation, TResult = unknown> {
  protocolVersion: ProtocolVersion;
  id: RequestId;
  operation: TOperation;
  result: TResult;
}

export type RuntimeErrorCode = "malformed_json" | "invalid_envelope" | "invalid_request_id" | "unsupported_protocol_version" | "unsupported_operation" | "invalid_payload" | "line_too_large" | "not_initialized" | "already_initialized" | "request_conflict" | "operation_unavailable" | "required_capability_unavailable" | "credential_persistence_required" | "reconnect_required" | "generation_not_found" | "login_not_found" | "cancelled" | "deadline_exceeded" | "authentication_failed" | "provider_unavailable" | "rate_limited" | "schema_invalid" | "output_invalid" | "internal";
export interface RuntimeFailure { code: RuntimeErrorCode; retryable: boolean; providerRequestId?: string; detail: string }
export interface FailureEnvelope { protocolVersion: ProtocolVersion; id?: RequestId; operation?: RuntimeOperation; error: RuntimeFailure }

export interface PromptIdentity {
  id: "scraply.stage-worker.v1";
  sha256: "277d724f20acb1f32fa0a8b7c454c670971e3c40bfc921db40c044caa760e6f1";
}
export interface ProtocolLimits { maxEnvelopeBytes: 16777216; maxInputBytes: 2097152; maxSchemaBytes: 262144; maxOutputBytes: 2097152 }
export interface InitializePayload { supportedProtocolVersions: ProtocolVersion[]; requiredCapabilities?: RuntimeCapability[]; client: { name: string; version: string } }
export interface InitializeResult {
  selectedProtocolVersion: ProtocolVersion;
  sessionId: string;
  runtime: { name: "scraply-agent"; version: string };
  prompt: PromptIdentity;
  operations: RuntimeOperation[];
  capabilities: RuntimeCapability[];
  limits: ProtocolLimits;
}

export interface QualifiedModel { providerId: string; modelId: string }
export interface ProviderAccount { providerId: string; email?: string; accountId?: string; plan?: string }
export interface ModelMetadata {
  identity: QualifiedModel;
  displayName: string;
  description?: string;
  contextLength?: number;
  supportsStructuredOutput: boolean;
  supportedReasoningEfforts?: string[];
  reasoningEffortDescriptions?: Record<string, string>;
  defaultReasoningEffort?: string;
  pricing?: Record<string, string>;
}
export interface PersistenceMarker { providerId: string; sessionId: string; rotationId: string }
export interface CredentialResult { account: ProviderAccount; credential: string; persistence: PersistenceMarker }

export interface WorkOrder { stage: string; instruction: string; goal: string; inputs?: unknown; requiredDecisions?: string[]; definitionOfDone: string[]; constraints?: string[] }
export interface EvidenceSource { sourceId: string; content: unknown }
export interface GenerationStartPayload {
  generationId: string;
  deadlineMs: number;
  model: QualifiedModel;
  promptRevision: "scraply.stage-worker.v1";
  workOrder: WorkOrder;
  evidence?: EvidenceSource[];
  outputSchema: object;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  maxOutputTokens?: number;
  repairPolicy?: "disabled" | "one_retry";
}

export interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; reasoningTokens?: number }
export type AttemptUsage = { status: "known"; value: TokenUsage } | { status: "unknown" };
export type ProviderCost = { amount: number; currency?: string };
export type AttemptCost = { status: "reported"; value: ProviderCost } | { status: "not_reported" } | { status: "unknown" };
export interface GenerationAttemptMetadata {
  attempt: "initial" | "schema_repair";
  outcome: "completed" | "failed" | "cancelled" | "deadline_exceeded";
  providerCompletion: "confirmed" | "unknown";
  model: QualifiedModel;
  usage: AttemptUsage;
  cost: AttemptCost;
  finishReason?: "stop" | "length" | "content_filter" | { other: string };
  latencyMs: number;
  providerRequestId?: string;
}
export interface GenerationMetadata {
  model: QualifiedModel;
  prompt: PromptIdentity;
  usage: AttemptUsage;
  providerCosts?: ProviderCost[];
  finishReason: "stop" | "length" | "content_filter" | { other: string };
  latencyMs: number;
  repairCount: number;
  providerRequestIds: string[];
  attempts: GenerationAttemptMetadata[];
}
export type GenerationEvent =
  | { kind: "generation.started"; generationId: string }
  | { kind: "generation.delta"; generationId: string; sequence: number; delta: unknown }
  | { kind: "generation.completed"; generationId: string; result: { output: unknown; metadata: GenerationMetadata } }
  | { kind: "generation.failed"; generationId: string; error: RuntimeFailure; attempts?: GenerationAttemptMetadata[] }
  | { kind: "generation.cancelled"; generationId: string; attempts?: GenerationAttemptMetadata[] };
export interface EventEnvelope { protocolVersion: ProtocolVersion; requestId: RequestId; operation: "generation.start"; event: GenerationEvent }
export type ServerEnvelope = SuccessEnvelope | FailureEnvelope | EventEnvelope;

export type InitializeRequest = RequestEnvelope<"runtime.initialize", InitializePayload>;
export type InitializeResponse = SuccessEnvelope<"runtime.initialize", InitializeResult>;
export type AccountListRequest = RequestEnvelope<"account.list", Record<string, never>>;
export type AccountListResponse = SuccessEnvelope<"account.list", { accounts: ProviderAccount[] }>;
export type AccountLoginStartRequest = RequestEnvelope<"account.login.start", { providerId: string; method: "browser" | "device" | "pkce"; callbackUrl?: string }>;
export type AccountLoginStartResponse = SuccessEnvelope<"account.login.start", { loginId: string; providerId: string; method: string; authorizationUrl?: string; verificationUrl?: string; userCode?: string; callbackPort?: number }>;
export type AccountLoginCompleteRequest = RequestEnvelope<"account.login.complete", { loginId: string; code?: string }>;
export type AccountLoginCompleteResponse = SuccessEnvelope<"account.login.complete", CredentialResult>;
export type AccountLoginCancelRequest = RequestEnvelope<"account.login.cancel", { loginId: string }>;
export type AccountLoginCancelResponse = SuccessEnvelope<"account.login.cancel", { cancelled: true }>;
export type AccountLogoutRequest = RequestEnvelope<"account.logout", { providerId: string }>;
export type AccountLogoutResponse = SuccessEnvelope<"account.logout", { loggedOut: boolean }>;
export type AccountRefreshRequest = RequestEnvelope<"account.refresh", { providerId: string }>;
export type AccountRefreshResponse = SuccessEnvelope<"account.refresh", CredentialResult>;
export type CredentialSetRequest = RequestEnvelope<"credential.session.set", { providerId: string; credential: string }>;
export type CredentialSetResponse = SuccessEnvelope<"credential.session.set", { providerId: string }>;
export type CredentialPersistedRequest = RequestEnvelope<"credential.session.persisted", PersistenceMarker>;
export type CredentialPersistedResponse = SuccessEnvelope<"credential.session.persisted", PersistenceMarker & { ready: true }>;
export type ModelListRequest = RequestEnvelope<"model.list", { providerId: string }>;
export type ModelListResponse = SuccessEnvelope<"model.list", { models: ModelMetadata[] }>;
export type GenerationStartRequest = RequestEnvelope<"generation.start", GenerationStartPayload>;
export type GenerationAcceptedResponse = SuccessEnvelope<"generation.start", { generationId: string; prompt: PromptIdentity }>;
export type GenerationCancelRequest = RequestEnvelope<"generation.cancel", { generationId: string }>;
export type GenerationCancelResponse = SuccessEnvelope<"generation.cancel", { generationId: string; cancelled: true }>;
export type ShutdownRequest = RequestEnvelope<"runtime.shutdown", Record<string, never>>;
export type ShutdownResponse = SuccessEnvelope<"runtime.shutdown", Record<string, never>>;
