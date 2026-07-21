import type { z } from "zod";

export type ProviderFailureCode =
  | "cancelled"
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
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderFailure";
  }
}

export interface StructuredCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StructuredModelClient {
  structuredCompletion<T>(
    model: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    jsonSchema: object,
    options?: StructuredCallOptions,
  ): Promise<T>;
}

export function toProviderFailure(error: unknown, fallback = "Provider request failed"): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderFailure("cancelled", "Provider request was cancelled", false, { cause: error });
  }
  const message = error instanceof Error ? error.message : fallback;
  return new ProviderFailure("failed", message, false, { cause: error });
}
