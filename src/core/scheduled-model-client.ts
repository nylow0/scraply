import { randomUUID } from "node:crypto";
import { ProviderFailure, type GenerationAttemptMetadata, type GenerationMetadata,
  type StructuredModelClient, type StructuredStageRequest, type StructuredStageResult } from "../providers/structured";
import type { AttemptUsage } from "../shared/runtime-protocol";
import { WorkflowModelScheduler } from "./workflow-scheduler";

/**
 * Each native generation has repair disabled, so it makes at most one provider call.
 * A schema retry joins the project queue as a fresh turn instead of holding the slot.
 */
export function scheduledModelClient(
  client: StructuredModelClient, scheduler: WorkflowModelScheduler, projectId: string,
): StructuredModelClient {
  const completion = async <T>(request: StructuredStageRequest<T>): Promise<StructuredStageResult<T>> => {
    const deadline = Date.now() + request.deadlineMs;
    const deadlineController = new AbortController();
    const timeout = setTimeout(() => deadlineController.abort(
      new ProviderFailure("timeout", "Model generation exceeded its saved deadline", false),
    ), request.deadlineMs);
    const callSignal = request.signal
      ? AbortSignal.any([request.signal, deadlineController.signal]) : deadlineController.signal;
    const dispatch = (attemptRequest: StructuredStageRequest<T>) => scheduler.schedule(projectId,
      (signal) => {
        if (Date.now() >= deadline) throw new ProviderFailure("timeout", "Model generation exceeded its saved deadline", false);
        return client.structuredCompletion({
          ...attemptRequest, signal, deadlineMs: Math.max(1, deadline - Date.now()),
        });
      }, callSignal);
    const firstRequest: StructuredStageRequest<T> = { ...request, repairPolicy: "disabled" };
    try {
      return await dispatch(firstRequest);
    } catch (error) {
      if (!(error instanceof ProviderFailure) || error.code !== "schema"
        || request.repairPolicy !== "one_retry" || callSignal.aborted || Date.now() >= deadline) throw error;
      const firstAttempts = error.attempts ?? [];
      const retry: StructuredStageRequest<T> = {
        ...firstRequest, generationId: randomUUID(),
        workOrder: {
          ...request.workOrder,
          constraints: [...(request.workOrder.constraints ?? []),
            "The prior response did not match the required JSON schema. Regenerate from the supplied evidence and return only valid schema-conforming JSON."],
        },
      };
      try {
        const repaired = await dispatch(retry);
        return { output: repaired.output, metadata: mergeRepairMetadata(firstAttempts, repaired.metadata) };
      } catch (retryError) {
        if (!(retryError instanceof ProviderFailure)) throw retryError;
        throw new ProviderFailure(retryError.code, retryError.message, retryError.retryable, {
          cause: retryError,
          attempts: [...firstAttempts, ...(retryError.attempts ?? []).map((attempt) => ({
            ...attempt, attempt: "schema_repair" as const,
          }))],
          ...(retryError.runtimeCode ? { runtimeCode: retryError.runtimeCode } : {}),
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    ...(client.preparedIdentity ? { preparedIdentity: () => client.preparedIdentity!() } : {}),
    ...(client.prepareIdentity ? { prepareIdentity: () => client.prepareIdentity!() } : {}),
    structuredCompletion: completion,
  };
}

function mergeRepairMetadata(firstAttempts: GenerationAttemptMetadata[], repaired: GenerationMetadata): GenerationMetadata {
  const attempts: GenerationAttemptMetadata[] = [...firstAttempts, ...repaired.attempts.map((attempt) => ({
    ...attempt, attempt: "schema_repair" as const,
  }))];
  const reportedCosts = attempts.flatMap((attempt) => attempt.cost.status === "reported" ? [attempt.cost.value] : []);
  return {
    ...repaired,
    attempts,
    usage: combinedUsage(attempts),
    ...(reportedCosts.length ? { providerCosts: reportedCosts } : {}),
    providerRequestIds: [...new Set(attempts.flatMap((attempt) => attempt.providerRequestId ? [attempt.providerRequestId] : []))],
    repairCount: 1,
    latencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
  };
}

function combinedUsage(attempts: GenerationAttemptMetadata[]): AttemptUsage {
  if (attempts.length === 0 || attempts.some((attempt) => attempt.usage.status !== "known")) {
    return { status: "unknown" };
  }
  const values = attempts.map((attempt) => {
    if (attempt.usage.status !== "known") throw new Error("Known usage changed during aggregation");
    return attempt.usage.value;
  });
  const sum = (field: "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens" | "reasoningTokens") =>
    values.reduce((total, value) => total + (value[field] ?? 0), 0);
  return { status: "known", value: {
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"),
    ...(values.some((value) => value.cachedInputTokens !== undefined) ? { cachedInputTokens: sum("cachedInputTokens") } : {}),
    ...(values.some((value) => value.reasoningTokens !== undefined) ? { reasoningTokens: sum("reasoningTokens") } : {}),
  } };
}
