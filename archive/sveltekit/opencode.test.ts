import { afterEach, describe, expect, test } from "bun:test";
import { OpenCodeClaimExtractor } from "../src/models/opencode";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => server?.stop(true));

describe("OpenCodeClaimExtractor", () => {
  test("uses Chat Completions and parses Zod structured output", async () => {
    let requestBody: Record<string, unknown> | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "mimo-v2.5",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                claims: [{
                  text: "Revenue grew by 20 percent.",
                  sourceIds: ["s1"],
                  evidence: [{ sourceId: "s1", quote: "Revenue grew by 20 percent" }],
                  confidence: 0.9,
                }],
              }),
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      },
    });

    const extractor = new OpenCodeClaimExtractor({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "mimo-v2.5",
    });
    const output = await extractor.extract("revenue", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Revenue grew by 20 percent.",
    }]);

    expect(output.claims).toHaveLength(1);
    expect(requestBody?.model).toBe("mimo-v2.5");
    expect(requestBody?.messages).toBeArray();
    expect(requestBody?.response_format).toMatchObject({ type: "json_schema" });
  });
});
