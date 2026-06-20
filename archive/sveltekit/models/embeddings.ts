import { z } from "zod";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EmbeddingBatch {
  vectors: number[][];
  provider: string;
  model: string;
}

export interface EmbeddingsClient {
  embed(texts: string[]): Promise<EmbeddingBatch>;
}

const GoogleResponseSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()).min(1) })),
});

export class GoogleEmbeddingsClient implements EmbeddingsClient {
  constructor(
    private readonly apiKey: string,
    private readonly model = "text-embedding-004",
    private readonly fetcher: Fetcher = fetch,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    if (texts.length === 0) return { vectors: [], provider: "google", model: this.model };
    const response = await this.fetcher(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:batchEmbedContents?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
        })) }),
      },
    );
    if (!response.ok) {
      throw new Error(`Google embeddings failed (${response.status}): ${await response.text()}`);
    }
    const parsed = GoogleResponseSchema.parse(await response.json());
    if (parsed.embeddings.length !== texts.length) throw new Error("Google returned the wrong number of embeddings");
    return { vectors: parsed.embeddings.map((item) => item.values), provider: "google", model: this.model };
  }
}

export function createEmbeddingsClient(options: {
  provider: "google";
  googleApiKey: string;
  googleModel: string;
}): EmbeddingsClient {
  return new GoogleEmbeddingsClient(options.googleApiKey, options.googleModel);
}
