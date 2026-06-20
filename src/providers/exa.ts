import { z } from "zod";
import { SourceSchema, type Source } from "../shared/schemas";

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

export interface ExaSearchOptions {
  numResults?: number;
  maxCharacters?: number;
}

export class ExaClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://api.exa.ai",
  ) {}

  async search(query: string, options: ExaSearchOptions = {}): Promise<Source[]> {
    const response = await this.fetcher(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: options.numResults ?? 5,
        contents: { text: { maxCharacters: options.maxCharacters ?? 6000 } },
      }),
    });

    if (!response.ok) {
      throw new Error(`Exa search failed (${response.status})`);
    }

    const parsed = ExaResponseSchema.parse(await response.json());
    return parsed.results
      .filter((result): result is typeof result & { text: string } => Boolean(result.text?.trim()))
      .map((result, index) => SourceSchema.parse({
        id: result.id ?? `source-${index + 1}`,
        url: result.url,
        title: result.title?.trim() || result.url,
        text: result.text.trim(),
        ...(result.author ? { author: result.author } : {}),
        ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      }));
  }

  async validateKey(): Promise<{ valid: true } | { valid: false; error: string }> {
    try {
      await this.search("test connectivity", { numResults: 1, maxCharacters: 500 });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "Exa validation failed" };
    }
  }
}
