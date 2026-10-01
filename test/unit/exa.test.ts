import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { ExaClient } from "../../src/providers/exa";
import { ProviderFailure } from "../../src/providers/structured";

describe("ExaClient", () => {
  test("retains redacted Exa rejection details for the exact Clinics request without retrying", async () => {
    const apiKey = "offline-clinics-secret";
    let dispatches = 0;
    let body: unknown;
    const client = new ExaClient(apiKey, async (_input, init) => {
      dispatches += 1;
      body = JSON.parse(String(init?.body));
      return Response.json({ requestId: "clinics-rejection-1", tag: "INVALID_REQUEST",
        error: `Rejected\nrequest using ${apiKey}`, ignored: apiKey }, { status: 400 });
    });
    await expect(client.search(
      "electronic patient records small primary care clinics low-resource settings donor-funded pilot ended follow-up record use discontinued continued",
      { category: "publication", includeDomains: ["bmchealthservres.biomedcentral.com", "mhealth.jmir.org"],
        excludeDomains: ["worldmetrics.org", "linkedin.com"], languages: ["en"],
        maxCharacters: 6000, numResults: 4, route: "studies-official" },
    )).rejects.toMatchObject({ code: "failed", retryable: false,
      message: 'Exa search failed (400): {"requestId":"clinics-rejection-1","tag":"INVALID_REQUEST","error":"Rejected request using [redacted]"}' });
    expect(dispatches).toBe(1);
    expect(body).toEqual({
      query: "electronic patient records small primary care clinics low-resource settings donor-funded pilot ended follow-up record use discontinued continued",
      type: "auto", numResults: 4,
      includeDomains: ["bmchealthservres.biomedcentral.com", "mhealth.jmir.org"],
      excludeDomains: ["worldmetrics.org", "linkedin.com"], category: "publication",
      contents: { text: { maxCharacters: 6000 } },
    });
  });

  test("keeps malformed or oversized Exa error bodies out of failure messages", async () => {
    for (const text of ["<html>secret provider failure</html>", JSON.stringify({ error: "x".repeat(9000) })]) {
      const client = new ExaClient("secret", async () => new Response(text, { status: 400 }));
      await expect(client.search("topic")).rejects.toMatchObject({ retryable: false, message: "Exa search failed (400)" });
    }
    const locked = Response.json({ error: "Already consumed" }, { status: 400 });
    const reader = locked.body!.getReader();
    try {
      await expect(new ExaClient("secret", async () => locked).search("topic"))
        .rejects.toMatchObject({ retryable: false, message: "Exa search failed (400)" });
    } finally { reader.releaseLock(); }
  });

  test("bounds parsed Exa diagnostic fields and cancels a stalled rejected body", async () => {
    const bounded = new ExaClient("secret", async () => Response.json({ requestId: "r".repeat(300),
      tag: "t".repeat(300), error: "e".repeat(1500) }, { status: 400 }));
    await expect(bounded.search("topic")).rejects.toMatchObject({ message: `Exa search failed (400): ${JSON.stringify({
      requestId: "r".repeat(200), tag: "t".repeat(200), error: "e".repeat(1000),
    })}` });
    const escaped = new ExaClient("secret", async () => Response.json({ requestId: '"'.repeat(200),
      tag: "\\".repeat(200), error: '"\\'.repeat(500) }, { status: 400 }));
    try {
      await escaped.search("topic");
      throw new Error("Expected Exa rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      const message = (error as ProviderFailure).message;
      expect(message.length).toBeLessThan(2000);
      expect(() => JSON.parse(message.slice("Exa search failed (400): ".length))).not.toThrow();
    }
    let cancelled = false;
    const stalled = new ExaClient("secret", async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":"unfinished')); },
      cancel() { cancelled = true; },
    }), { status: 400 }));
    await expect(stalled.search("topic")).rejects.toMatchObject({ retryable: false, message: "Exa search failed (400)" });
    expect(cancelled).toBe(true);
  });

  test("sends current categories and bounded domain filters, location, and recency", async () => {
    const bodies: unknown[] = [];
    const client = new ExaClient("secret", async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ url: "https://worldmetrics.org/page", text: "Blocked quote" },
        { url: "https://github.com/tool/issues/1", text: "Undated user report" }] });
    });
    const result = await client.search("topic", { includeDomains: Array.from({ length: 1201 }, (_, index) => `forum${index}.test`),
      excludeDomains: ["vendor.test"], category: "publication", userLocation: "UA", startPublishedDate: "2023-09-30T00:00:00.000Z" });
    expect(result).toHaveLength(1);
    expect(result[0]?.publishedDate).toBeUndefined();
    expect(bodies[0]).toMatchObject({ excludeDomains: ["worldmetrics.org", "linkedin.com", "vendor.test"], category: "publication",
      userLocation: "UA", startPublishedDate: "2023-09-30T00:00:00.000Z" });
    expect((bodies[0] as { includeDomains: string[] }).includeDomains).toHaveLength(1200);
    await client.search("topic", { category: "people", startPublishedDate: "2023-09-30T00:00:00.000Z" });
    expect((bodies[1] as { excludeDomains?: string[] }).excludeDomains).toBeUndefined();
    expect((bodies[1] as { startPublishedDate?: string }).startPublishedDate).toBeUndefined();
  });
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
      category: "publication",
      excludeDomains: ["worldmetrics.org", "linkedin.com"],
      startPublishedDate: "2025-01-01T00:00:00.000Z",
    });
    expect(request?.url).toBe("https://exa.test/search");
    expect(request?.headers.get("x-api-key")).toBe("secret");
    expect(await request?.json()).toEqual({
      query: "topic",
      type: "auto",
      numResults: 3,
      includeDomains: ["reddit.com"],
      category: "publication",
      excludeDomains: ["worldmetrics.org", "linkedin.com"],
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
