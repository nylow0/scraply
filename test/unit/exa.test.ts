import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { ExaClient } from "../../src/providers/exa";
import { ProviderFailure } from "../../src/providers/structured";

describe("ExaClient", () => {
  test("posts search with contents and normalizes sources", async () => {
    let request: Request | undefined;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ results: [{ id: "s1", url: "https://example.com/a", title: "A", text: "Useful source text." }] });
    };
    const sources = await new ExaClient("secret", fetcher, "https://exa.test").search("topic", {
      numResults: 3,
      maxCharacters: 1234,
      includeDomains: ["reddit.com"],
      startPublishedDate: "2025-01-01T00:00:00.000Z",
    });
    expect(request?.url).toBe("https://exa.test/search");
    expect(request?.headers.get("x-api-key")).toBe("secret");
    expect(await request?.json()).toEqual({
      query: "topic",
      type: "auto",
      numResults: 3,
      includeDomains: ["reddit.com"],
      startPublishedDate: "2025-01-01T00:00:00.000Z",
      contents: { text: { maxCharacters: 1234 } },
    });
    expect(sources).toEqual([{ id: "s1", url: "https://example.com/a", title: "A", text: "Useful source text." }]);
  });

  test("applies the request timeout while reading the response body", async () => {
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    }));

    try {
      await new ExaClient("secret", fetcher, "https://exa.test").search("topic", { timeoutMs: 10 });
      throw new Error("Expected Exa search to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      expect((error as ProviderFailure).code).toBe("timeout");
    }
  });

  test("exercises success, HTTP errors, and abort through a real local server", async () => {
    let apiKey: string | undefined;
    let releaseHangingRequest!: () => void;
    const hangingRequest = new Promise<void>((resolve) => { releaseHangingRequest = resolve; });
    const server = createServer(async (request, response) => {
      apiKey = request.headers["x-api-key"] as string | undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string };
      if (body.query === "rate limited") {
        response.writeHead(429).end("slow down");
        return;
      }
      if (body.query === "hang") {
        releaseHangingRequest();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: [{ id: "local", url: "https://example.com/local", title: "Local", text: "Hermetic response" }] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const client = new ExaClient("local-secret", fetch, `http://127.0.0.1:${address.port}`);
    try {
      await expect(client.search("success")).resolves.toEqual([
        { id: "local", url: "https://example.com/local", title: "Local", text: "Hermetic response" },
      ]);
      expect(apiKey).toBe("local-secret");
      await expect(client.search("rate limited")).rejects.toMatchObject({ code: "rate-limit", retryable: true });

      const controller = new AbortController();
      const pending = client.search("hang", { signal: controller.signal });
      await hangingRequest;
      controller.abort(new Error("test abort"));
      await expect(pending).rejects.toMatchObject({ code: "cancelled", retryable: false });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });
});
