import { z } from "zod";
import { SourceSchema, type Source } from "../shared/schemas";
import type { SearchClient, SearchOptions, ValidationResult } from "./search";
import { ProviderFailure } from "./structured";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const PerplexityResponseSchema = z.object({
  id: z.string().optional(),
  results: z.array(z.object({
    title: z.string().nullish(),
    url: z.string().url(),
    snippet: z.string().nullish(),
    date: z.string().nullish(),
    last_updated: z.string().nullish(),
  })),
});

function formatSearchDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

export class PerplexityClient implements SearchClient {
  readonly provider = "perplexity" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://api.perplexity.ai",
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<Source[]> {
    if (options.signal?.aborted) {
      throw new ProviderFailure("cancelled", "Perplexity search was cancelled", false, { cause: options.signal.reason });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs ?? 30_000);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(options.numResults ?? 5, 20),
          max_tokens_per_page: 2_000,
          ...(options.includeDomains ? { search_domain_filter: options.includeDomains } : {}),
          ...(options.startPublishedDate
            ? { search_after_date_filter: formatSearchDate(options.startPublishedDate) }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderFailure("auth", "Perplexity API key was rejected", false);
        }
        if (response.status === 429) {
          throw new ProviderFailure("rate-limit", "Perplexity rate limit reached", true);
        }
        throw new ProviderFailure(
          "failed",
          `Perplexity search failed (${response.status})`,
          response.status >= 500 || response.status === 408,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ProviderFailure("schema", "Perplexity returned invalid JSON", true, { cause: error });
      }
      const parsed = PerplexityResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ProviderFailure("schema", "Perplexity returned an unexpected response", true, { cause: parsed.error });
      }
      const maxCharacters = options.maxCharacters ?? 6000;
      return parsed.data.results
        .filter((result): result is typeof result & { snippet: string } => Boolean(result.snippet?.trim()))
        .map((result, index) => SourceSchema.parse({
          id: parsed.data.id ? `${parsed.data.id}-${index + 1}` : `source-${index + 1}`,
          url: result.url,
          title: result.title?.trim() || result.url,
          text: result.snippet.trim().slice(0, maxCharacters),
          ...(result.date ? { publishedDate: result.date } : {}),
        }));
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (options.signal?.aborted) {
        throw new ProviderFailure("cancelled", "Perplexity search was cancelled", false, { cause: error });
      }
      if (controller.signal.aborted) {
        throw new ProviderFailure("timeout", "Perplexity search timed out", true, { cause: error });
      }
      throw new ProviderFailure("failed", "Perplexity search failed", true, { cause: error });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async validateKey(): Promise<ValidationResult> {
    try {
      await this.search("test connectivity", { numResults: 1, maxCharacters: 500, timeoutMs: 10_000 });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "Perplexity validation failed" };
    }
  }
}
