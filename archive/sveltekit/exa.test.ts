import { describe, expect, test } from "bun:test";
import { ExaClient } from "../src/search/exa";

describe("ExaClient", () => {
  test("posts search with contents and normalizes sources", async () => {
    let request: Request | undefined;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ results: [{ id: "s1", url: "https://example.com/a", title: "A", text: "Useful source text." }] });
    };
    const sources = await new ExaClient("secret", fetcher, "https://exa.test").search("topic", { numResults: 3, maxCharacters: 1234 });
    expect(request?.url).toBe("https://exa.test/search");
    expect(request?.headers.get("x-api-key")).toBe("secret");
    expect(await request?.json()).toEqual({ query: "topic", type: "auto", numResults: 3, contents: { text: { maxCharacters: 1234 } } });
    expect(sources).toEqual([{ id: "s1", url: "https://example.com/a", title: "A", text: "Useful source text." }]);
  });
});
