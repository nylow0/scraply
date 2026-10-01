import { z } from "zod";
import { SourceSchema, type Source } from "../shared/schemas";
import { ProviderFailure } from "./structured";
import type { SearchClient, SearchOptions, ValidationResult } from "./search";
import { EXCLUDED_SOURCE_DOMAINS, filterRoutedSources } from "./source-routes";

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

const ExaErrorSchema = z.object({
  requestId: z.string().optional(),
  tag: z.string().optional(),
  error: z.string().optional(),
});

// Failed search receipts retain Error.message. Keep only bounded provider diagnostics,
// never headers, arbitrary error pages, or an API key echoed in the response.
async function readExaErrorDetails(response: Response, apiKey: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, 2000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (expired) return "";
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) return "";
      body += decoder.decode(value, { stream: true });
    }
    const payload: unknown = JSON.parse(body + decoder.decode());
    const parsed = ExaErrorSchema.safeParse(payload);
    if (!parsed.success) return "";
    const details: Partial<Record<"requestId" | "tag" | "error", string>> = {};
    for (const field of ["requestId", "tag", "error"] as const) {
      const text = parsed.data[field];
      if (!text) continue;
      const redacted = apiKey ? text.replaceAll(apiKey, "[redacted]") : text;
      const value = redacted.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim()
        .slice(0, field === "error" ? 1000 : 200);
      if (value) details[field] = value;
    }
    if (!Object.keys(details).length) return "";
    let encoded = JSON.stringify(details);
    // Search terminals cap messages at 2000 characters, including JSON escaping.
    while (encoded.length > 1800 && details.error?.length) {
      details.error = details.error.slice(0, -100);
      encoded = JSON.stringify(details);
    }
    return encoded;
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const EXA_CATEGORIES = [
  "company",
  "publication",
  "news",
  "personal site",
  "people",
  "financial report",
] as const;

export type ExaCategory = (typeof EXA_CATEGORIES)[number];

export interface ExaSearchOptions extends SearchOptions {
  category?: ExaCategory;
}

export class ExaClient implements SearchClient {
  readonly provider = "exa" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://api.exa.ai",
  ) {}

  async search(query: string, options: ExaSearchOptions = {}): Promise<Source[]> {
    const excludeDomains = [...new Set([...EXCLUDED_SOURCE_DOMAINS, ...options.excludeDomains ?? []])];
    if (options.signal?.aborted) {
      throw new ProviderFailure("cancelled", "Exa search was cancelled", false, { cause: options.signal.reason });
    }
    const controller = new AbortController();
    const timeout = options.timeoutMs === undefined ? undefined
      : setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs);
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
          ...(options.includeDomains?.length ? { includeDomains: options.includeDomains.slice(0, 1200) } : {}),
          ...(options.category !== "company" && options.category !== "people"
            ? { excludeDomains: excludeDomains.slice(0, 1200) } : {}),
          ...(options.category ? { category: options.category } : {}),
          ...(options.startPublishedDate && options.category !== "company" && options.category !== "people"
            ? { startPublishedDate: options.startPublishedDate } : {}),
          ...(options.userLocation ? { userLocation: options.userLocation } : {}),
          contents: { text: { maxCharacters: options.maxCharacters ?? 6000 } },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = await readExaErrorDetails(response, this.apiKey);
        const suffix = details ? `: ${details}` : "";
        if (response.status === 401 || response.status === 403) {
          throw new ProviderFailure("auth", `Exa API key was rejected${suffix}`, false);
        }
        if (response.status === 429) {
          throw new ProviderFailure("rate-limit", `Exa rate limit reached${suffix}`, true);
        }
        throw new ProviderFailure("failed", `Exa search failed (${response.status})${suffix}`, response.status >= 500 || response.status === 408);
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
      return filterRoutedSources(parsed.data.results
        .filter((result): result is typeof result & { text: string } => Boolean(result.text?.trim()))
        .map((result, index) => SourceSchema.parse({
          id: result.id ?? `source-${index + 1}`,
          url: result.url,
          title: result.title?.trim() || result.url,
          text: result.text.trim().slice(0, options.maxCharacters ?? 6000),
          ...(result.author ? { author: result.author } : {}),
          ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
        })), options);
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

  async validateKey(): Promise<ValidationResult> {
    try {
      await this.search("test connectivity", { numResults: 1, maxCharacters: 500, timeoutMs: 10_000 });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "Exa validation failed" };
    }
  }
}
