import { z } from "zod";
import { SourceSchema, type Source } from "../shared/schemas";
import { ProviderFailure } from "./structured";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ExaResponseSchema = z.object({
  results: z.array(z.object({
    id: z.string().optional(),
    url: z.string().url(),
    title: z.string().nullish(),
    text: z.string().nullish(),
    author: z.string().nullish(),
    publishedDate: z.string().nullish(),
  })),
});

export const EXA_CATEGORIES = [
  "company",
  "research paper",
  "news",
  "pdf",
  "github",
  "tweet",
  "personal site",
  "linkedin profile",
  "financial report",
] as const;

export type ExaCategory = (typeof EXA_CATEGORIES)[number];

export interface ExaSearchOptions {
  numResults?: number;
  maxCharacters?: number;
  includeDomains?: string[];
  category?: ExaCategory;
  startPublishedDate?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ExaClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://api.exa.ai",
  ) {}

  async search(query: string, options: ExaSearchOptions = {}): Promise<Source[]> {
    if (options.signal?.aborted) {
      throw new ProviderFailure("cancelled", "Exa search was cancelled", false, { cause: options.signal.reason });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs ?? 30_000);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify({
          query,
          type: "auto",
          numResults: options.numResults ?? 5,
          ...(options.includeDomains ? { includeDomains: options.includeDomains } : {}),
          ...(options.category ? { category: options.category } : {}),
          ...(options.startPublishedDate ? { startPublishedDate: options.startPublishedDate } : {}),
          contents: { text: { maxCharacters: options.maxCharacters ?? 6000 } },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderFailure("auth", "Exa API key was rejected", false);
        }
        if (response.status === 429) {
          throw new ProviderFailure("rate-limit", "Exa rate limit reached", true);
        }
        throw new ProviderFailure("failed", `Exa search failed (${response.status})`, response.status >= 500 || response.status === 408);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ProviderFailure("schema", "Exa returned invalid JSON", true, { cause: error });
      }
      const parsed = ExaResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ProviderFailure("schema", "Exa returned an unexpected response", true, { cause: parsed.error });
      }
      return parsed.data.results
        .filter((result): result is typeof result & { text: string } => Boolean(result.text?.trim()))
        .map((result, index) => SourceSchema.parse({
          id: result.id ?? `source-${index + 1}`,
          url: result.url,
          title: result.title?.trim() || result.url,
          text: result.text.trim(),
          ...(result.author ? { author: result.author } : {}),
          ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
        }));
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (options.signal?.aborted) throw new ProviderFailure("cancelled", "Exa search was cancelled", false, { cause: error });
      if (controller.signal.aborted) throw new ProviderFailure("timeout", "Exa search timed out", true, { cause: error });
      throw new ProviderFailure("failed", "Exa search failed", true, { cause: error });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async validateKey(): Promise<{ valid: true } | { valid: false; error: string }> {
    try {
      await this.search("test connectivity", { numResults: 1, maxCharacters: 500, timeoutMs: 10_000 });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "Exa validation failed" };
    }
  }
}
