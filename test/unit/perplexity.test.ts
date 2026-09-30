import { describe, expect, test } from "bun:test";
import { PerplexityClient } from "../../src/providers/perplexity";
import { ProviderFailure } from "../../src/providers/structured";

describe("PerplexityClient", () => {
  test("bounds allow or deny lists, filters blocked results locally, and sends language and region filters", async () => {
    const bodies: unknown[] = [];
    const client = new PerplexityClient("secret", async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ url: "https://worldmetrics.org/page", snippet: "Blocked quote" },
        { url: "https://reddit.com/page", snippet: "Undated firsthand quote" }] });
    });
    expect(await client.search("topic", { includeDomains: Array.from({ length: 25 }, (_, index) => `forum${index}.test`),
      excludeDomains: ["worldmetrics.org"], languages: ["en", "uk"], userLocation: "UA" }))
      .toEqual([{ id: "source-2", url: "https://reddit.com/page", title: "https://reddit.com/page", text: "Undated firsthand quote" }]);
    expect(bodies[0]).toMatchObject({ search_language_filter: ["en", "uk"], country: "UA",
      search_domain_filter: Array.from({ length: 20 }, (_, index) => `forum${index}.test`) });
    await client.search("topic", { excludeDomains: Array.from({ length: 25 }, (_, index) => `blocked${index}.test`) });
    const deny = (bodies[1] as { search_domain_filter: string[] }).search_domain_filter;
    expect(deny).toHaveLength(20);
    expect(deny[0]).toBe("-worldmetrics.org");
  });
  test("maps search options and normalizes non-empty sources", async () => {
    let request: Request | undefined;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({
        id: "request-1",
        results: [
          { url: "https://example.com/a", title: "  A  ", snippet: "Evidence that is longer than the limit.", date: "2026-08-20" },
          { url: "https://example.com/blank", title: "Blank", snippet: "   " },
        ],
      });
    };

    const client = new PerplexityClient("secret", fetcher, "https://perplexity.test");
    const sources = await client.search("topic", {
      numResults: 3,
      maxCharacters: 8,
      includeDomains: ["reddit.com"],
      startPublishedDate: "2026-01-02T00:00:00.000Z",
    });

    expect(client.provider).toBe("perplexity");
    expect(request?.url).toBe("https://perplexity.test/search");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(await request?.json()).toEqual({
      query: "topic",
      max_results: 3,
      max_tokens_per_page: 2000,
      search_domain_filter: ["reddit.com"],
      search_after_date_filter: "01/02/2026",
    });
    expect(sources).toEqual([{
      id: "request-1-1",
      url: "https://example.com/a",
      title: "A",
      text: "Evidence",
      publishedDate: "2026-08-20",
    }]);
  });

  test("classifies authentication, rate-limit, malformed JSON, and schema failures", async () => {
    const cases = [
      { response: new Response("unauthorized", { status: 401 }), code: "auth", retryable: false },
      { response: new Response("slow down", { status: 429 }), code: "rate-limit", retryable: true },
      { response: new Response("{"), code: "schema", retryable: true },
      { response: Response.json({ results: [{ url: "not-a-url", snippet: "text" }] }), code: "schema", retryable: true },
    ] as const;

    for (const item of cases) {
      const client = new PerplexityClient("secret", async () => item.response.clone());
      try {
        await client.search("topic");
        throw new Error("Expected search to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderFailure);
        expect(error).toMatchObject({ code: item.code, retryable: item.retryable });
      }
    }
  });

  test("distinguishes timeout from caller cancellation", async () => {
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    }));
    await expect(new PerplexityClient("secret", fetcher).search("topic", { timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "timeout", retryable: true });

    const controller = new AbortController();
    const pending = new PerplexityClient("secret", fetcher).search("topic", { signal: controller.signal });
    controller.abort(new Error("cancelled by test"));
    await expect(pending).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });
});
