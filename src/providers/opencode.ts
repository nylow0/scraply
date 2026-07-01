import { z } from "zod";
import { loadPrompt } from "../core/prompts";
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
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()),
      ]).nullable().optional(),
      tool_calls: z.array(z.object({
        function: z.object({
          arguments: z.string(),
        }).passthrough(),
      }).passthrough()).nullable().optional(),
    }).passthrough(),
  })).min(1),
}).passthrough();

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
        json_schema: { name: "structured_output", schema: strictJsonSchema(jsonSchema), strict: true },
      };
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`OpenCode chat failed (${response.status})`);
    }
    const parsed = ChatCompletionSchema.parse(await response.json());
    const message = parsed.choices[0]?.message;
    const toolArguments = message?.tool_calls?.[0]?.function.arguments;
    if (toolArguments) return toolArguments;
    const content = message?.content;
    if (!content) throw new Error("OpenCode returned empty content");
    if (typeof content === "string") return content;
    const text = content.map((part) => part.text).filter(Boolean).join("\n").trim();
    if (!text) throw new Error("OpenCode returned empty content");
    return text;
  }

  private async fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
    let lastResponse: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetcher(input, init);
        if (!isRetryableStatus(response.status) || attempt === 2) return response;
        lastResponse = response;
      } catch (error) {
        lastError = error;
        if (attempt === 2) break;
      }
      await sleep(750 * 2 ** attempt);
    }

    if (lastResponse) return lastResponse;
    throw lastError instanceof Error ? lastError : new Error("OpenCode chat request failed");
  }

  async structuredCompletion<T>(
    model: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    jsonSchema: object,
  ): Promise<T> {
    const strictSchema = strictJsonSchema(jsonSchema);
    const raw = await this.chatCompletion(model, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], strictSchema);
    try {
      return parseStructured(raw, schema);
    } catch (firstError) {
      const repair = await this.chatCompletion(model, [
        {
          role: "system",
          content: [
            system,
            loadPrompt("structured-output-repair", [
              "Return only one valid JSON object. It must exactly match the supplied JSON Schema.",
              "Do not use markdown, prose, tool wrappers, or omit required keys.",
            ].join("\n")),
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "Original task:",
            user,
            "",
            "Required JSON Schema:",
            JSON.stringify(strictSchema),
            "",
            "Invalid previous response:",
            raw,
            "",
            "Validation error:",
            formatValidationError(firstError),
          ].join("\n"),
        },
      ], strictSchema);
      try {
        return parseStructured(repair, schema);
      } catch (repairError) {
        throw new Error(`OpenCode structured output failed validation after repair: ${formatValidationError(repairError)}`);
      }
    }
  }

  async extractClaims(model: string, query: string, sources: Source[], systemPrompt?: string): Promise<ClaimExtraction> {
    const sourceText = sources.map((source) =>
      `<source id="${source.id}" title=${JSON.stringify(source.title)} url=${JSON.stringify(source.url)}>\n${source.text}\n</source>`,
    ).join("\n\n");
    return this.structuredCompletion(
      model,
      systemPrompt ?? loadPrompt(
        "researcher-default",
        "Extract only useful atomic factual claims that directly answer the research query. Every claim must cite source IDs with short evidence quotes.",
      ),
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

function parseStructured<T>(raw: string, schema: z.ZodType<T>): T {
  const parsed = JSON.parse(extractJson(raw));
  return schema.parse(unwrapStructuredPayload(parsed));
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return trimmed.slice(objectStart, objectEnd + 1);

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) return trimmed.slice(arrayStart, arrayEnd + 1);

  return trimmed;
}

function unwrapStructuredPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.parsed)) return value.parsed;
  if (isRecord(value.output)) return value.output;
  if (isRecord(value.result)) return value.result;
  if (isRecord(value.data)) return value.data;
  if (isRecord(value.arguments)) return value.arguments;
  if (typeof value.arguments === "string") {
    try {
      return unwrapStructuredPayload(JSON.parse(value.arguments));
    } catch {
      return value;
    }
  }
  return value;
}

function strictJsonSchema(value: object): object;
function strictJsonSchema(value: unknown): unknown;
function strictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictJsonSchema);
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = strictJsonSchema(child);
  }

  if (next.type === "object") {
    next.additionalProperties ??= false;
  }

  return next;
}

function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) return JSON.stringify(error.errors);
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
