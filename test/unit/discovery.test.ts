import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  batchSources,
  discoveryProjection,
  harvestFactors,
  normalizeEvidenceText,
  quoteAppearsVerbatim,
  runPhase1Ablation,
  type HarvestedSource,
} from "../../src/core/discovery";
import type { StructuredModelClient } from "../../src/providers/structured";
import { ProviderFailure } from "../../src/providers/structured";
import { QueryPlanOutputSchema } from "../../src/shared/structured-output-schemas";

describe("Phase 1 discovery", () => {
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

  test("runs factor-backed and scope-only arms without leaking observations into stage 2", async () => {
    const candidateInputs: string[] = [];
    const client: StructuredModelClient = {
      async structuredCompletion<T>(
        _model: string,
        _system: string,
        user: string,
        schema: z.ZodType<T>,
      ): Promise<T> {
        if (schema._def === QueryPlanOutputSchema._def) {
          return schema.parse({ queries: ["one", "two", "three"] });
        }
        if (user.startsWith("Harvest mode:")) {
          const sourceId = user.match(/\[([0-9a-f-]{36})\]/)?.[1];
          return schema.parse({ factors: [{
            subject: "Operators",
            behavior: "repeat manual filing",
            quote: "repeat manual filing every week",
            sourceId,
            modelConfidence: 0.8,
          }] });
        }
        if (user.startsWith("Scope:")) {
          candidateInputs.push(user);
          const factorIds = [...user.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((match) => match[1]);
          return schema.parse({ problems: [{
            statement: factorIds.length > 0 ? "Operators duplicate recurring filings." : "The scope may contain a generic bottleneck.",
            whyItPersists: "Systems do not share state.",
            affected: "Operators",
            scaleEstimate: "Recurring",
            scaleBasisFactorId: factorIds[0] ?? null,
            factorIds,
          }] });
        }
        const verdictSourceId = user.match(/\[([0-9a-f-]{36})\]/)?.[1];
        return schema.parse({
          verdict: "confirmed",
          verdictReason: "Contrary search did not find a complete solution.",
          verdictSourceIds: verdictSourceId ? [verdictSourceId] : [],
        });
      },
    };
    let searchIndex = 0;
    const result = await runPhase1Ablation({
      title: "Filing workflow",
      audience: "small operators",
      domain: "regulated filing",
      observations: "PRIVATE OBSERVATION MUST NOT REACH STAGE TWO",
      offLimits: [],
    }, {
      modelClient: client,
      model: "test-model",
      depth: "quick",
      random: () => 0.5,
      search: {
        async search(_query, options = {}) {
          searchIndex += 1;
          const hostname = searchIndex % 2 === 0 ? "other.test" : "example.test";
          return [{
            id: `provider-${searchIndex}`,
            url: `https://${hostname}/${searchIndex}`,
            title: `Source ${searchIndex}`,
            text: "Operators repeat manual filing every week.",
            ...(options.includeDomains ? { author: "Audience" } : {}),
          }];
        },
      },
    });

    expect(result.harvest.factors).toHaveLength(2);
    expect(result.harvest.factors.map((factor) => factor.harvestMode).sort()).toEqual(["audience", "domain"]);
    expect(result.armA.problems).toHaveLength(1);
    expect(result.armA.problems[0]?.sourceHostnames).toHaveLength(2);
    expect(result.armC.problems).toHaveLength(1);
    expect(result.armC.problems[0]?.factorIds).toEqual([]);
    expect(candidateInputs).toHaveLength(2);
    expect(candidateInputs.every((input) => !input.includes("PRIVATE OBSERVATION"))).toBe(true);
    expect(result.armA.factorUtilizationRate).toBe(1);
  });

  test("a kill source already in the harvest corpus still reaches the kill prompt", async () => {
    // Arm A holds the whole harvest corpus and Arm C holds nothing. If a rediscovered URL were
    // dropped from the prompt, Arm A would judge its candidates on less contrary evidence than the
    // control, which would confound the only comparison the ablation exists to make.
    const killInputs: string[] = [];
    const expectedVerdictSourceIds: string[][] = [];
    const result = await runPhase1Ablation(scope(), {
      model: "test-model",
      depth: "quick",
      random: () => 0.5,
      modelClient: modelClient(async (user, schema) => {
        if (schema._def === QueryPlanOutputSchema._def) {
          return schema.parse({ queries: ["one", "two", "three"] });
        }
        if (user.startsWith("Harvest mode:")) {
          // One factor per source, so Arm A's candidate clears the two-hostname diversity gate.
          const sourceIds = [...user.matchAll(/^\[([0-9a-f-]{36})\] /gm)].map((match) => match[1]);
          return schema.parse({ factors: sourceIds.map((sourceId) => ({
            subject: "Operators",
            behavior: "repeat manual filing",
            quote: "repeat manual filing every week",
            sourceId,
            modelConfidence: 0.8,
          })) });
        }
        if (user.startsWith("Scope:")) {
          const factorIds = [...user.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((match) => match[1]);
          return schema.parse({ problems: [{
            statement: "Operators duplicate recurring filings.",
            whyItPersists: "Systems do not share state.",
            affected: "Operators",
            scaleEstimate: "Recurring",
            scaleBasisFactorId: null,
            factorIds,
          }] });
        }
        killInputs.push(user);
        const verdictSourceIds = [...user.matchAll(/\[([0-9a-f-]{36})\]/g)].map((match) => match[1]!);
        const duplicated = verdictSourceIds.length > 1
          ? [verdictSourceIds[1]!, verdictSourceIds[0]!, verdictSourceIds[1]!]
          : verdictSourceIds;
        expectedVerdictSourceIds.push([...new Set(duplicated)]);
        return schema.parse({
          verdict: "confirmed",
          verdictReason: "Contrary search did not find a complete solution.",
          verdictSourceIds: duplicated,
        });
      }),
      search: {
        // Every query — harvest and kill, both arms — returns the same two URLs.
        async search() {
          return ["https://example.test/shared", "https://other.test/shared"].map((url) => ({
            id: url,
            url,
            title: url,
            text: "Operators repeat manual filing every week.",
          }));
        },
      },
    });

    expect(killInputs).toHaveLength(2);
    const [armAKill, armCKill] = killInputs;
    expect(armAKill).toContain("https://example.test/shared");
    expect(armAKill).toContain("https://other.test/shared");
    // Arm C is the control: it must see the same number of kill sources as Arm A.
    expect(countRenderedSources(armAKill!)).toBe(countRenderedSources(armCKill!));
    // Only genuinely new sources are queued for insertion, so the run-scoped URL uniqueness holds.
    expect(result.armA.killSources).toEqual([]);
    expect(result.armC.killSources).toHaveLength(2);
    expect(result.armA.problems[0]?.verdictSourceIds).toEqual(expectedVerdictSourceIds[0]);
    expect(result.armC.problems[0]?.verdictSourceIds).toEqual(expectedVerdictSourceIds[1]);
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

  test("projects kill searches and per-batch model calls, not just the harvest floor", () => {
    const projection = discoveryProjection("standard", 4);
    expect(projection).toEqual({
      harvestSearches: 12,
      killSearches: 8,
      searches: 20,
      // 2 query plans + 3 harvest batches per mode + 1 candidate call per arm + 8 kill calls.
      modelCalls: 18,
      factorCap: 80,
    });
  });
});

function countRenderedSources(prompt: string): number {
  return [...prompt.matchAll(/^\[[0-9a-f-]{36}\] /gm)].length;
}

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
