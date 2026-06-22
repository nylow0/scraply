import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { OpenCodeClient } from "../../src/providers/opencode";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => server?.stop(true));

describe("OpenCodeClient", () => {
  test("uses Chat Completions and parses structured output", async () => {
    let requestBody: Record<string, unknown> | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                claims: [{
                  text: "Revenue grew by 20 percent.",
                  sourceIds: ["s1"],
                  evidence: [{ sourceId: "s1", quote: "Revenue grew by 20 percent" }],
                  confidence: 0.9,
                }],
              }),
            },
          }],
        });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    const output = await client.extractClaims("mimo-v2.5", "revenue", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Revenue grew by 20 percent.",
    }]);

    expect(output.claims).toHaveLength(1);
    expect(requestBody?.model).toBe("mimo-v2.5");
    expect(requestBody?.response_format).toMatchObject({ type: "json_schema" });
  });

  test("reports chat and structured capability checks", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        const structured = Boolean(body.response_format);
        return Response.json({
          choices: [{
            message: {
              content: structured ? JSON.stringify({ ok: true }) : "Scraply model OK",
            },
          }],
        });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    const result = await client.testModelCapabilities("glm-5.2");
    expect(result.chatOk).toBe(true);
    expect(result.structuredOk).toBe(true);
  });

  test("lists models from /models", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ id: "glm-5.2" }, { id: "mimo-v2.5" }] });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    await expect(client.listModels()).resolves.toEqual(["glm-5.2", "mimo-v2.5"]);
  });

  test("normalizes retryable OpenCode HTTP errors", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: "rate limit exceeded for account" }, { status: 429 });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });

    await expect(client.chatCompletion("glm-5.2", [{ role: "user", content: "Ping" }]))
      .rejects.toThrow("OpenCode chat failed (429): rate limit exceeded for account. Try again in a moment.");
  });

  test("accepts structured JSON wrapped in a markdown fence", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          choices: [{
            message: { content: "```json\n{\"ok\":true}\n```" },
          }],
        });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });

    await expect(client.structuredCompletion(
      "glm-5.2",
      "Return JSON only.",
      "Set ok to true.",
      z.object({ ok: z.boolean() }),
      { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    )).resolves.toEqual({ ok: true });
  });
});
