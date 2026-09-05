import { z } from "zod";

export const RUNTIME_PROTOCOL_VERSION = "1.1" as const;
export const RUNTIME_REQUIRED_CAPABILITIES = [
  "envelope_limits",
  "account_refresh",
  "credential_persistence_ack",
  "generation_attempt_metadata",
  "exactly_one_terminal",
] as const;
export const RUNTIME_PROMPT_ID = "scraply.stage-worker.v1" as const;

export const RuntimeOperationSchema = z.enum([
  "runtime.initialize", "account.list", "account.login.start", "account.login.complete",
  "account.login.cancel", "account.logout", "account.refresh", "credential.session.set",
  "credential.session.persisted", "model.list", "generation.start", "generation.cancel",
  "runtime.shutdown",
]);
export const RuntimeCapabilitySchema = z.enum(RUNTIME_REQUIRED_CAPABILITIES);
export const QualifiedModelSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).strict();
export const PromptIdentitySchema = z.object({
  id: z.literal(RUNTIME_PROMPT_ID),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ProtocolLimitsSchema = z.object({
  maxEnvelopeBytes: z.literal(16_777_216),
  maxInputBytes: z.literal(2_097_152),
  maxSchemaBytes: z.literal(262_144),
  maxOutputBytes: z.literal(2_097_152),
}).strict();
export const InitializeResultSchema = z.object({
  selectedProtocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  runtime: z.object({ name: z.literal("scraply-agent"), version: z.string().min(1) }).strict(),
  prompt: PromptIdentitySchema,
  operations: z.array(RuntimeOperationSchema),
  capabilities: z.array(RuntimeCapabilitySchema),
  limits: ProtocolLimitsSchema,
}).strict();

export const ProviderAccountSchema = z.object({
  providerId: z.string().min(1),
  email: z.string().optional(),
  accountId: z.string().optional(),
  plan: z.string().optional(),
}).strict();
export const PersistenceMarkerSchema = z.object({
  providerId: z.string().min(1), sessionId: z.string().min(1), rotationId: z.string().min(1),
}).strict();
export const CredentialResultSchema = z.object({
  account: ProviderAccountSchema,
  credential: z.string().min(1),
  persistence: PersistenceMarkerSchema,
}).strict();
export const ModelMetadataSchema = z.object({
  identity: QualifiedModelSchema,
  displayName: z.string().min(1),
  description: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  supportsStructuredOutput: z.boolean(),
  supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
  reasoningEffortDescriptions: z.record(z.string()).optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  pricing: z.record(z.string()).optional(),
}).strict();

export const WorkOrderSchema = z.object({
  stage: z.string().min(1),
  instruction: z.string().min(1),
  goal: z.string().min(1),
  inputs: z.unknown().optional(),
  requiredDecisions: z.array(z.string().min(1)).optional(),
  definitionOfDone: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).optional(),
}).strict();
export const EvidenceSourceSchema = z.object({ sourceId: z.string().min(1), content: z.unknown() }).strict();
export const GenerationStartPayloadSchema = z.object({
  generationId: z.string().min(1),
  deadlineMs: z.number().int().positive(),
  model: QualifiedModelSchema,
  promptRevision: z.literal(RUNTIME_PROMPT_ID),
  workOrder: WorkOrderSchema,
  evidence: z.array(EvidenceSourceSchema).optional(),
  outputSchema: z.record(z.unknown()),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  repairPolicy: z.enum(["disabled", "one_retry"]).optional(),
}).strict();

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
}).strict();
export const AttemptUsageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: TokenUsageSchema }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
export const ProviderCostSchema = z.object({ amount: z.number().nonnegative(), currency: z.string().optional() }).strict();
export const AttemptCostSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("reported"), value: ProviderCostSchema }).strict(),
  z.object({ status: z.literal("not_reported") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
const FinishReasonSchema = z.union([
  z.enum(["stop", "length", "content_filter"]),
  z.object({ other: z.string() }).strict(),
]);
export const GenerationAttemptMetadataSchema = z.object({
  attempt: z.enum(["initial", "schema_repair"]),
  outcome: z.enum(["completed", "failed", "cancelled", "deadline_exceeded"]),
  providerCompletion: z.enum(["confirmed", "unknown"]),
  model: QualifiedModelSchema,
  usage: AttemptUsageSchema,
  cost: AttemptCostSchema,
  finishReason: FinishReasonSchema.optional(),
  latencyMs: z.number().int().nonnegative(),
  providerRequestId: z.string().min(1).optional(),
}).strict();
export const GenerationMetadataSchema = z.object({
  model: QualifiedModelSchema,
  prompt: PromptIdentitySchema,
  usage: AttemptUsageSchema,
  providerCosts: z.array(ProviderCostSchema).optional(),
  finishReason: FinishReasonSchema,
  latencyMs: z.number().int().nonnegative(),
  repairCount: z.number().int().nonnegative(),
  providerRequestIds: z.array(z.string().min(1)),
  attempts: z.array(GenerationAttemptMetadataSchema),
}).strict();
export const RuntimeFailureSchema = z.object({
  code: z.string().min(1), retryable: z.boolean(), providerRequestId: z.string().optional(), detail: z.string(),
}).strict();
export const GenerationEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generation.started"), generationId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("generation.delta"), generationId: z.string().min(1), sequence: z.number().int().nonnegative(), delta: z.unknown() }).strict(),
  z.object({ kind: z.literal("generation.completed"), generationId: z.string().min(1), result: z.object({ output: z.unknown(), metadata: GenerationMetadataSchema }).strict() }).strict(),
  z.object({ kind: z.literal("generation.failed"), generationId: z.string().min(1), error: RuntimeFailureSchema, attempts: z.array(GenerationAttemptMetadataSchema).optional() }).strict(),
  z.object({ kind: z.literal("generation.cancelled"), generationId: z.string().min(1), attempts: z.array(GenerationAttemptMetadataSchema).optional() }).strict(),
]);
export const ServerEnvelopeSchema = z.union([
  z.object({ protocolVersion: z.string(), requestId: z.union([z.string(), z.number()]), operation: z.literal("generation.start"), event: GenerationEventSchema }).strict(),
  z.object({ protocolVersion: z.string(), id: z.union([z.string(), z.number()]), operation: RuntimeOperationSchema, result: z.unknown() }).strict(),
  z.object({ protocolVersion: z.string(), id: z.union([z.string(), z.number()]).optional(), operation: RuntimeOperationSchema.optional(), error: RuntimeFailureSchema }).strict(),
]);

export type RuntimeOperation = z.infer<typeof RuntimeOperationSchema>;
export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>;
export type InitializeResult = z.infer<typeof InitializeResultSchema>;
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;
export type PersistenceMarker = z.infer<typeof PersistenceMarkerSchema>;
export type CredentialResult = z.infer<typeof CredentialResultSchema>;
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;
export type WorkOrder = z.infer<typeof WorkOrderSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type GenerationStartPayload = z.infer<typeof GenerationStartPayloadSchema>;
export type AttemptUsage = z.infer<typeof AttemptUsageSchema>;
export type GenerationAttemptMetadata = z.infer<typeof GenerationAttemptMetadataSchema>;
export type GenerationMetadata = z.infer<typeof GenerationMetadataSchema>;
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;
