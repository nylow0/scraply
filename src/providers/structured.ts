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
  reasoningEffort?: string;
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
