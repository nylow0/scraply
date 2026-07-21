import { afterEach, describe, expect, test } from "bun:test";
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

  test("parses markdown-fenced structured output", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          choices: [{
            message: {
              content: "```json\n{\"claims\":[{\"text\":\"Students pay for workflow fixes.\",\"sourceIds\":[\"s1\"],\"evidence\":[{\"sourceId\":\"s1\",\"quote\":\"Students pay for workflow fixes\"}],\"confidence\":0.8}]}\n```",
            },
          }],
        });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    const output = await client.extractClaims("mimo-v2.5", "student workflow", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Students pay for workflow fixes.",
    }]);

    expect(output.claims[0]?.text).toBe("Students pay for workflow fixes.");
  });

  test("unwraps common structured output envelopes", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                output: {
                  claims: [{
                    text: "Small teams buy automation.",
                    sourceIds: ["s1"],
                    evidence: [{ sourceId: "s1", quote: "Small teams buy automation" }],
                    confidence: 0.75,
                  }],
                },
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
    const output = await client.extractClaims("mimo-v2.5", "automation", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Small teams buy automation.",
    }]);

    expect(output.claims).toHaveLength(1);
  });

  test("uses tool call arguments when content is absent", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  arguments: JSON.stringify({
                    claims: [{
                      text: "Founders validate pricing with pilots.",
                      sourceIds: ["s1"],
                      evidence: [{ sourceId: "s1", quote: "Founders validate pricing with pilots" }],
                      confidence: 0.7,
                    }],
                  }),
                },
              }],
            },
          }],
        });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    const output = await client.extractClaims("mimo-v2.5", "pricing", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Founders validate pricing with pilots.",
    }]);

    expect(output.claims).toHaveLength(1);
  });

  test("accepts null tool calls from OpenAI-compatible responses", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                claims: [{
                  text: "Students prefer fast setup.",
                  sourceIds: ["s1"],
                  evidence: [{ sourceId: "s1", quote: "Students prefer fast setup" }],
                  confidence: 0.82,
                }],
              }),
              tool_calls: null,
            },
          }],
        });
      },
    });

    const client = new OpenCodeClient({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    const output = await client.extractClaims("mimo-v2.5", "setup", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Students prefer fast setup.",
    }]);

    expect(output.claims).toHaveLength(1);
  });

  test("retries transient chat failures", async () => {
    let calls = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        if (calls === 1) return new Response("temporary upstream failure", { status: 500 });
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                claims: [{
                  text: "Retries recover transient failures.",
                  sourceIds: ["s1"],
                  evidence: [{ sourceId: "s1", quote: "Retries recover transient failures" }],
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
    const output = await client.extractClaims("mimo-v2.5", "retries", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Retries recover transient failures.",
    }]);

    expect(calls).toBe(2);
    expect(output.claims).toHaveLength(1);
  });

  test("repairs missing required claims", async () => {
    let calls = 0;
    let repairBody: Record<string, unknown> | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        calls += 1;
        const body = await request.json() as Record<string, unknown>;
        if (calls === 2) repairBody = body;
        return Response.json({
          choices: [{
            message: {
              content: calls === 1
                ? JSON.stringify({ findings: [] })
                : JSON.stringify({
                  claims: [{
                    text: "Users abandon tools with slow setup.",
                    sourceIds: ["s1"],
                    evidence: [{ sourceId: "s1", quote: "Users abandon tools with slow setup" }],
                    confidence: 0.85,
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
    const output = await client.extractClaims("mimo-v2.5", "setup friction", [{
      id: "s1",
      url: "https://example.com",
      title: "Example",
      text: "Users abandon tools with slow setup.",
    }]);

    expect(calls).toBe(2);
    expect(output.claims[0]?.confidence).toBe(0.85);
    expect(JSON.stringify(repairBody?.messages)).toContain("Required JSON Schema");
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
});
