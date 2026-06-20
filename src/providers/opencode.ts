import { z } from "zod";
import { OPENCODE_BASE_URL } from "../shared/schemas";
import { ClaimExtractionSchema, type ClaimExtraction, type Source } from "../shared/schemas";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })).optional(),
  object: z.string().optional(),
}).passthrough();

const ChatCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable(),
    }),
  })).min(1),
});

export interface OpenCodeClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetcher?: Fetcher;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: Fetcher;

  constructor(options: OpenCodeClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? OPENCODE_BASE_URL).replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetcher(`${this.baseUrl}/models`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`OpenCode model list failed (${response.status})`);
    }
    const parsed = ModelsResponseSchema.parse(await response.json());
    const ids = parsed.data?.map((m) => m.id) ?? [];
    if (ids.length === 0) throw new Error("OpenCode returned no models");
    return ids.sort();
  }

  async validateKey(): Promise<{ valid: true; models: string[] } | { valid: false; error: string }> {
    try {
      const models = await this.listModels();
      return { valid: true, models };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "OpenCode validation failed" };
    }
  }

  async chatCompletion(model: string, messages: Array<{ role: string; content: string }>, jsonSchema?: object): Promise<string> {
    const body: Record<string, unknown> = { model, messages };
    if (jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "structured_output", schema: jsonSchema, strict: true },
      };
    }
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`OpenCode chat failed (${response.status})`);
    }
    const parsed = ChatCompletionSchema.parse(await response.json());
    const content = parsed.choices[0]?.message.content;
    if (!content) throw new Error("OpenCode returned empty content");
    return content;
  }

  async structuredCompletion<T>(
    model: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    jsonSchema: object,
  ): Promise<T> {
    const raw = await this.chatCompletion(model, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], jsonSchema);
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      const repair = await this.chatCompletion(model, [
        { role: "system", content: "Return only valid JSON matching the requested schema." },
        { role: "user", content: `Fix this JSON:\n${raw}` },
      ], jsonSchema);
      return schema.parse(JSON.parse(repair));
    }
  }

  async extractClaims(model: string, query: string, sources: Source[]): Promise<ClaimExtraction> {
    const sourceText = sources.map((source) =>
      `<source id="${source.id}" title=${JSON.stringify(source.title)} url=${JSON.stringify(source.url)}>\n${source.text}\n</source>`,
    ).join("\n\n");
    return this.structuredCompletion(
      model,
      "Extract only useful atomic factual claims that directly answer the research query. Every claim must cite source IDs with short evidence quotes.",
      `Research query: ${query}\n\nSources:\n${sourceText}`,
      ClaimExtractionSchema,
      {
        type: "object",
        properties: {
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                sourceIds: { type: "array", items: { type: "string" } },
                evidence: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      sourceId: { type: "string" },
                      quote: { type: "string" },
                    },
                    required: ["sourceId", "quote"],
                  },
                },
                confidence: { type: "number" },
              },
              required: ["text", "sourceIds", "evidence", "confidence"],
            },
          },
        },
        required: ["claims"],
      },
    );
  }
}
