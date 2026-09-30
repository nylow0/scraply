import { z } from "zod";

const Count = z.number().int().nonnegative();
const Id = z.string().min(1).max(256);
export const GetRunTraceRequestSchema = z.object({ runId: Id }).strict();
export const GetRunTraceStepRequestSchema = GetRunTraceRequestSchema.extend({ stepId: Id }).strict();

export const RunTraceMetricsSchema = z.object({
  factors: Count, totalSources: Count,
  evidenceMix: z.record(Count), audienceFit: z.record(Count), sourceMix: z.record(Count),
  qualifyingObservations: Count, qualifyingPerAssessedCandidate: z.number().nonnegative().nullable(),
  candidateFunnel: z.object({ total: Count, assessed: Count, confirmed: Count, insufficient: Count,
    dropped: Count, notAssessed: Count, userAsserted: Count }),
  confirmationRate: z.number().min(0).max(1).nullable(),
  coverage: z.object({ kind: z.enum(["areas", "phases"]), groups: z.array(z.object({
    id: z.string(), factors: Count, problems: Count, confirmed: Count,
  })) }),
  modelCalls: Count, searches: Count, wallTimeMs: Count, modelTimeMs: Count,
  interruptionTimeMs: Count, interruptions: Count, ideas: Count, acceptedIdeas: Count,
});
export const RunTraceAttemptSchema = z.object({
  id: Id, status: z.string(), model: z.string(), effort: z.string(), provider: z.string(),
  startedAt: z.string(), finishedAt: z.string().nullable(), durationMs: Count,
  inputTokens: Count.nullable(), outputTokens: Count.nullable(), reasoningTokens: Count.nullable(),
  costUsd: z.number().nonnegative().nullable(), errorCode: z.string().nullable(), message: z.string().nullable(),
  reasoningSummary: z.string().nullable(),
});
export const RunTraceSearchSchema = z.object({
  key: z.string(), query: z.string(), intent: z.string(), reason: z.string(),
  expectedSourceType: z.string(), provider: z.string().nullable(), route: z.string().nullable(),
  parameters: z.record(z.unknown()), status: z.enum(["completed", "not-saved"]),
  results: z.array(z.object({ sourceId: z.string().nullable(), url: z.string(), title: z.string(),
    sourceClass: z.string(), factsKept: Count })),
});
export const RunTraceStepSchema = z.object({
  id: Id, kind: z.enum(["model", "search", "work"]), stage: z.string(), label: z.string(),
  phase: z.string().nullable(), status: z.string(), startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(), durationMs: Count, attempts: z.array(RunTraceAttemptSchema),
  prompt: z.object({ filename: z.string(), source: z.string(), sha256: z.string() }).nullable(),
  search: RunTraceSearchSchema.nullable(),
});
export const RunTraceCandidateSchema = z.object({
  id: z.string(), statement: z.string(), state: z.enum(["confirmed", "insufficient", "dropped", "not-assessed", "user-asserted"]),
  reason: z.string(), derived: z.boolean(), factorIds: z.array(z.string()),
  qualifyingObservations: Count, independentSources: Count,
  assessments: z.array(z.unknown()), candidate: z.unknown().nullable(),
});
export const RunTraceFactSchema = z.object({
  id: z.string().nullable(), sourceId: z.string(), subject: z.string(), behavior: z.string(),
  quote: z.string(), sourceRole: z.string(), audienceFit: z.string(), kept: z.boolean().nullable(),
  reason: z.string().nullable(),
});
export const RunTraceStepDetailSchema = z.object({
  runId: Id, step: RunTraceStepSchema, inputs: z.unknown().nullable(), output: z.unknown().nullable(),
  evidence: z.array(z.unknown()), searches: z.array(RunTraceSearchSchema), facts: z.array(RunTraceFactSchema),
  candidates: z.array(RunTraceCandidateSchema),
  events: z.array(z.object({ type: z.string(), createdAt: z.string(), payload: z.unknown() })),
});
export const RunTraceSchema = z.object({
  runId: Id, threadId: Id, sessionId: z.string().nullable(), status: z.string(), purpose: z.string(),
  startedAt: z.string(), finishedAt: z.string().nullable(), live: z.boolean(),
  metrics: RunTraceMetricsSchema, steps: z.array(RunTraceStepSchema),
  candidates: z.array(RunTraceCandidateSchema), warnings: z.array(z.string()),
});

export type RunTrace = z.infer<typeof RunTraceSchema>;
export type RunTraceStep = z.infer<typeof RunTraceStepSchema>;
export type RunTraceStepDetail = z.infer<typeof RunTraceStepDetailSchema>;
export type RunTraceSearch = z.infer<typeof RunTraceSearchSchema>;
export type RunTraceCandidate = z.infer<typeof RunTraceCandidateSchema>;
