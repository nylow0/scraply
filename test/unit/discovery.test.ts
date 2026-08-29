import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  batchSources,
  discoverProblems,
  harvestFactors,
  normalizeEvidenceText,
  quoteAppearsVerbatim,
  type HarvestedFactor,
  type HarvestedSource,
} from "../../src/core/discovery";
import type { StructuredModelClient } from "../../src/providers/structured";
import { ProviderFailure } from "../../src/providers/structured";
import { QueryPlanOutputSchema } from "../../src/shared/structured-output-schemas";

describe("discovery", () => {
  test("normalizes typography and whitespace before checking a quote", () => {
    const source = "People said “this\u00a0takes — far too long” after filing.";
    expect(normalizeEvidenceText(source)).toBe('People said "this takes - far too long" after filing.');
    expect(quoteAppearsVerbatim(source, 'this takes - far too long')).toBe(true);
    expect(quoteAppearsVerbatim(source, "this is fast")).toBe(false);
  });

  test("batches sources without splitting a source", () => {
    const sources = [source("one", "a".repeat(30)), source("two", "b".repeat(30))];
    const batches = batchSources(sources, 90);
    expect(batches).toHaveLength(2);
    expect(batches.flat().map((item) => item.id)).toEqual(["one", "two"]);
  });

  test("retries underfilled query plans and searches the requested count", async () => {
    let plannerCalls = 0;
    let searches = 0;
    const result = await harvestFactors(scope(), {
      model: "test-model",
      depth: "quick",
      modelClient: modelClient(async (_user, schema) => {
        if (schema._def === QueryPlanOutputSchema._def) {
          plannerCalls += 1;
          return schema.parse({
            queries: plannerCalls % 2 === 1 ? ["one", " one ", ""] : ["one", "two", "three"],
          });
        }
        return schema.parse({ factors: [] });
      }),
      search: {
        async search() {
          searches += 1;
          return [];
        },
      },
    });

    expect(result.factors).toEqual([]);
    expect(plannerCalls).toBe(4);
    expect(searches).toBe(6);
  });

  test("fails clearly when a retried query plan remains underfilled", async () => {
    let plannerCalls = 0;
    const run = harvestFactors(scope(), {
      model: "test-model",
      depth: "quick",
      modelClient: modelClient(async (_user, schema) => {
        plannerCalls += 1;
        return schema.parse({ queries: ["one", " one "] });
      }),
      search: { async search() { return []; } },
    });

    await expect(run).rejects.toEqual(expect.objectContaining({
      code: "schema",
      message: "Query planner returned 1 unique non-empty queries; expected 3",
    } satisfies Partial<ProviderFailure>));
    expect(plannerCalls).toBe(2);
  });

  test("reports accepted factors separately from factors retained by the cap", async () => {
    const result = await harvestFactors(scope(), {
      model: "test-model",
      depth: "quick",
      random: () => 0.5,
      modelClient: modelClient(async (user, schema) => {
        if (schema._def === QueryPlanOutputSchema._def) {
          return schema.parse({ queries: ["one", "two", "three"] });
        }
        const sourceId = user.match(/\[([0-9a-f-]{36})\]/)?.[1];
        const count = user.includes("Harvest mode: domain") ? 31 : 0;
        return schema.parse({ factors: Array.from({ length: count }, () => ({
          subject: "Operators",
          behavior: "repeat manual filing",
          quote: "repeat manual filing every week",
          sourceId,
          modelConfidence: 0.8,
        })) });
      }),
      search: {
        async search(query) {
          return [{
            id: query,
            url: `https://example.test/${query}`,
            title: query,
            text: "Operators repeat manual filing every week.",
          }];
        },
      },
    });

    expect(result.factors).toHaveLength(30);
    expect(result.metrics).toMatchObject({
      extracted: { domain: 31, audience: 0 },
      accepted: { domain: 31, audience: 0 },
      retained: { domain: 30, audience: 0 },
      rejected: { domain: 0, audience: 0 },
    });
  });

  test("keeps a rediscovered harvest source in the kill prompt without reinserting it", async () => {
    const existing = source("existing", "Contrary evidence.");
    const other = {
      ...source("other", "Supporting evidence."),
      canonicalUrl: "https://other.test/context",
      url: "https://other.test/context",
    };
    const factors: HarvestedFactor[] = [
      { id: "factor-1", subject: "Operators", behavior: "repeat filing", quote: "Contrary evidence.", sourceId: existing.id, harvestMode: "domain", modelConfidence: 0.8, source: existing },
      { id: "factor-2", subject: "Operators", behavior: "repeat filing", quote: "Supporting evidence.", sourceId: other.id, harvestMode: "audience", modelConfidence: 0.8, source: other },
    ];
    let killPrompt = "";
    const result = await discoverProblems(scope(), factors, [existing, other], {
      model: "test-model",
      depth: "quick",
      modelClient: modelClient(async (user, schema) => {
        if (user.startsWith("Scope:")) {
          return schema.parse({ problems: [{
            statement: "Operators duplicate recurring filings.",
            whyItPersists: "Systems do not share state.",
            affected: "Operators",
            scaleEstimate: "Recurring",
            scaleBasisFactorId: null,
            factorIds: factors.map((factor) => factor.id),
          }] });
        }
        killPrompt = user;
        return schema.parse({
          verdict: "confirmed",
          verdictReason: "Contrary evidence does not resolve the problem.",
          verdictSourceIds: [existing.id],
        });
      }),
      search: {
        async search() {
          return [{ id: "rediscovered", url: existing.url, title: existing.title, text: existing.retrievedText }];
        },
      },
    });

    expect(killPrompt).toContain(existing.canonicalUrl);
    expect(result.killSources).toEqual([]);
    expect(result.problems[0]?.verdictSourceIds).toEqual([existing.id]);
  });

  test("skips a search result whose URL cannot be parsed instead of failing the run", async () => {
    const skipped: string[] = [];
    const result = await harvestFactors(scope(), {
      model: "test-model",
      depth: "quick",
      modelClient: modelClient(async (_user, schema) => {
        if (schema._def === QueryPlanOutputSchema._def) {
          return schema.parse({ queries: ["one", "two", "three"] });
        }
        return schema.parse({ factors: [] });
      }),
      onProjection: (message) => skipped.push(message),
      search: {
        async search() {
          return [
            { id: "bad", url: "not a url", title: "Bad", text: "text" },
            { id: "good", url: "https://example.test/good", title: "Good", text: "text" },
          ];
        },
      },
    });

    expect(result.sources.map((source) => source.canonicalUrl)).toEqual(["https://example.test/good"]);
    expect(skipped.some((message) => message.includes("not a url"))).toBe(true);
  });

  test("treats trivially different URLs for one page as a single source", async () => {
    // Each variant differs only in casing, default port, trailing slash, query order,
    // tracking params, or fragment. Fetching and harvesting the same page more than
    // once inflates factor counts and burns model calls.
    const variants = [
      "https://Example.test/a/?b=2&a=1",
      "https://example.test:443/a?a=1&b=2&utm_source=news",
      "https://example.test/a?a=1&b=2#section",
    ];
    const result = await harvestFactors(scope(), {
      model: "test-model",
      depth: "quick",
      modelClient: modelClient(async (_user, schema) => {
        if (schema._def === QueryPlanOutputSchema._def) {
          return schema.parse({ queries: ["one", "two", "three"] });
        }
        return schema.parse({ factors: [] });
      }),
      search: {
        async search() {
          return variants.map((url) => ({ id: url, url, title: url, text: "text" }));
        },
      },
    });

    expect(result.sources.map((source) => source.canonicalUrl)).toEqual(["https://example.test/a?a=1&b=2"]);
  });
});

function source(id: string, text: string): HarvestedSource {
  return {
    id,
    providerSourceId: id,
    canonicalUrl: `https://example.test/${id}`,
    url: `https://example.test/${id}`,
    title: id,
    retrievedText: text,
    author: null,
    publishedAt: null,
    contentHash: id,
    retrievedAt: "2026-01-01T00:00:00.000Z",
  };
}

function scope() {
  return {
    title: "Filing workflow",
    audience: "small operators",
    domain: "regulated filing",
    observations: "",
    offLimits: [],
  };
}

function modelClient(
  completion: (user: string, schema: z.ZodTypeAny) => unknown | Promise<unknown>,
): StructuredModelClient {
  return {
    async structuredCompletion<T>(
      _model: string,
      _system: string,
      user: string,
      schema: z.ZodType<T>,
    ): Promise<T> {
      return await completion(user, schema) as T;
    },
  };
}
