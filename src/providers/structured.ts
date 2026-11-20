/** Why a search provider call failed. Exa and Perplexity throw this; `src/cli/pages.ts` turns it into a CLI error. */
export type ProviderFailureCode =
  | "cancelled"
  | "timeout"
  | "auth"
  | "rate-limit"
  | "schema"
  | "failed";

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
    /** True when the same request might succeed if sent again. */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderFailure";
  }
}
