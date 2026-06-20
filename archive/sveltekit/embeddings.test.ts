import { describe, expect, test } from "bun:test";
import { createEmbeddingsClient, GoogleEmbeddingsClient } from "../src/models/embeddings";

describe("embeddings", () => {
  test("uses Google batch embedding request shape", async () => {
    let body: unknown;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] });
    };
    const result = await new GoogleEmbeddingsClient("key", "text-embedding-004", fetcher, "https://google.test").embed(["one", "two"]);
    expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(body).toEqual({ requests: ["one", "two"].map((text) => ({
      model: "models/text-embedding-004",
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    })) });
  });

  test("factory selects the production Google client", () => {
    expect(createEmbeddingsClient({ provider: "google", googleApiKey: "key", googleModel: "google-model" })).toBeInstanceOf(GoogleEmbeddingsClient);
  });
});
