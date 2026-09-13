import { describe, expect, test } from "bun:test";
import {
  batchSources,
  discoverProblems,
  harvestFactors,
  normalizeEvidenceText,
  quoteAppearsVerbatim,
  type HarvestedFactor,
  type HarvestedSource,
} from "../../src/core/discovery";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import { ProviderFailure } from "../../src/providers/structured";
import { QueryPlanOutputSchema } from "../../src/shared/structured-output-schemas";

describe("discovery", () => {
  test.each([
    ["STUDENTS WHO FELL BEHIND EARLY STRUGGLED TO CATCH UP", "Students who fell behind early struggled to catch up"],
    ["most respondents (31%) keep a mental list of tasks, while 29%rely on digital reminders", "most respondents (31%) keep a mental list of tasks, while 29% rely on digital reminders"],
    ["Students donot submit assignments", "Students do not submit assignments"],
    ["There is noway to recover", "There is no way to recover"],
    ["They cannot proceed", "They can not proceed"],
    ["Context: They cannot proceed today.", "They can not proceed"],
    ["They can not proceed", "They cannot proceed"],
    ["There is no way to recover", "There is noway to recover"],
  ])("accepts extraction formatting without changing quoted characters: %s", (source, quote) => {
    expect(quoteAppearsVerbatim(source, quote)).toBe(true);
  });

  test.each([
    ["43% of respondents struggle", "44% of respondents struggle"],
    ["Students do not submit assignments", "Students do submit assignments"],
    ["Students miss deadlines. Teachers assign homework.", "Students miss homework"],
    ["Scores were 1 00 in the table", "Scores were 100 in the table"],
    ["The outcome was notable.", "The outcome was not able."],
    ["The system was not able to recover.", "The system was notable to recover."],
    ["The system was not able without manual help.", "The system was notable without manual help."],
    ["They do notability assessments.", "They do not ability assessments."],
    ["Students do notsubmit assignments", "Students do not submit assignments"],
    ["Noresults were found", "No results were found"],
    ["Report: Noresults returned", "No results returned"],
    ["No table was available.", "Not able was available."],
    ["xNoresults returned", "No results returned"],
    ["The outcome isnotable.", "The outcome is not able."],
    ["The support is now\nhere.", "The support is nowhere."],
    ["therapist", "the rapist"],
    ["therapist", "rapist"],
    ["therapist", "thera"],
    ["They cannot proceed", "an not proceed"],
    ["They cannot proceed", "not proceed"],
    ["There is noway to recover", "way to recover"],
    ["\u{10400}rapist", "rapist"],
    ["thera\u{10400}", "thera"],
    ["43% of respondents find academic assignments to be the mostchallenging tasks to prioritize", "43% of respondents find academic assignments to be the most challenging tasks to prioritize"],
    ["This did not fail. The mostchallenging tasks still persist.", "The most challenging tasks still persist."],
    ["Studentsdonotsubmit assignments", "Students do not submit assignments"],
    ["Students miss deadlines", "  "],
  ])("rejects unsupported quotes despite formatting tolerance: %s", (source, quote) => {
    expect(quoteAppearsVerbatim(source, quote)).toBe(false);
  });

  const model = { providerId: "test-provider", modelId: "test-model" };
  const reasoningEffort = "medium" as const;
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

  test.each([
    { includeDomains: undefined },
    { includeDomains: [] },
    { includeDomains: ["reddit.com", "news.ycombinator.com"] },
  ])("passes audience domain policy %j to the planner and search provider", async ({ includeDomains }) => {
    let plannerCalls = 0;
    let searches = 0;
    const plannerInputs: Array<Record<string, unknown>> = [];
    const searchDomains: Array<string[] | undefined> = [];
    const result = await harvestFactors(scope(), {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      ...(includeDomains === undefined ? {} : { audienceSearch: { includeDomains: [...includeDomains] } }),
      modelClient: modelClient(async (request) => {
        if (request.schema._def === QueryPlanOutputSchema._def) {
          plannerCalls += 1;
          plannerInputs.push(request.workOrder.inputs as Record<string, unknown>);
          return request.schema.parse({ queries: ["one", "two", "three"] });
        }
        return request.schema.parse({ factors: [] });
      }),
      search: {
        async search(_query, options) {
          searches += 1;
          searchDomains.push(options?.includeDomains);
          return [];
        },
      },
    });

    expect(result.factors).toEqual([]);
    expect(plannerCalls).toBe(2);
    expect(searches).toBe(6);
    expect(plannerInputs).toEqual([
      { harvestMode: "domain", queryCount: 3, sourcePolicy: { includeDomains: [] } },
      { harvestMode: "audience", queryCount: 3, sourcePolicy: { includeDomains: includeDomains ?? ["reddit.com", "news.ycombinator.com"] } },
    ]);
    expect(searchDomains).toEqual([
      undefined, undefined, undefined,
      ...Array.from({ length: 3 }, () => [...(includeDomains ?? ["reddit.com", "news.ycombinator.com"])]),
    ]);
  });

  test("keeps native envelope IDs bounded when a harvest batch contains many source IDs", async () => {
    const harvestRequests: StructuredStageRequest<unknown>[] = [];
    let nextId = 0;
    await harvestFactors(scope(), {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model, reasoningEffort, depth: "quick",
      idFactory: () => String(nextId++).padStart(64, "0"),
      modelClient: modelClient(async (request) => {
        if (request.schema._def === QueryPlanOutputSchema._def) return { queries: ["one", "two", "three"] };
        harvestRequests.push(request);
        return { factors: [] };
      }),
      search: { async search() {
        return Array.from({ length: 12 }, (_, index) => ({
          id: String(index), url: `https://example.test/source/${index}`, title: `Source ${index}`, text: "Observed evidence.",
        }));
      } },
    });
    expect(harvestRequests.length).toBeGreaterThan(0);
    for (const request of harvestRequests) {
      expect(request.deadlineMs).toBe(300_000);
      expect(request.stage.length).toBeGreaterThan(256);
      expect(Buffer.byteLength(request.evidence[0]!.sourceId)).toBeLessThanOrEqual(256);
      const content = request.evidence[0]!.content as { sources: Array<{ id: string }> };
      expect(content.sources).toHaveLength(12);
      expect(new Set(content.sources.map((source) => source.id)).size).toBe(12);
    }
  });

  test("fails clearly without an app-owned retry when a query plan is underfilled", async () => {
    let plannerCalls = 0;
    const run = harvestFactors(scope(), {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => {
        plannerCalls += 1;
        return request.schema.parse({ queries: ["one", " one "] });
      }),
      search: { async search() { return []; } },
    });

    await expect(run).rejects.toEqual(expect.objectContaining({
      code: "schema",
      message: "Query planner returned 1 unique non-empty queries; expected 3",
    } satisfies Partial<ProviderFailure>));
    expect(plannerCalls).toBe(1);
  });

  test("caps each evidence mode before generation instead of discarding generated factors", async () => {
    const domainFactorLimits: number[] = [];
    const domainSearches: string[] = [];
    const result = await harvestFactors(scope(), {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      random: () => 0.5,
      modelClient: modelClient(async (request) => {
        if (request.schema._def === QueryPlanOutputSchema._def) {
          return request.schema.parse({ queries: [
            { query: "one", intent: "firsthand-experience", uncertainty: "experience", intendedSourceType: "buyer account" },
            { query: "two", intent: "current-alternative", uncertainty: "alternative", intendedSourceType: "workflow account" },
            { query: "three", intent: "contrary-evidence", uncertainty: "contrary", intendedSourceType: "independent report" },
          ] });
        }
        const evidence = request.evidence[0]!.content as { sources: Array<{ id: string }> };
        const sourceId = evidence.sources[0]?.id;
        const inputs = request.workOrder.inputs as { harvestMode: string; factorLimit: number };
        if (inputs.harvestMode === "domain") domainFactorLimits.push(inputs.factorLimit);
        const count = inputs.harvestMode === "domain" ? inputs.factorLimit : 0;
        return request.schema.parse({ factors: Array.from({ length: count }, () => ({
          subject: "Operators",
          behavior: "repeat manual filing",
          quote: "repeat manual filing every week",
          sourceId,
          modelConfidence: 0.8,
          uncertainty: "Vendor-authored passage.", sourceRole: "vendor", audienceFit: "intended-buyer",
          independentSourceKey: "vendor-one", supportsDemand: true,
          demandEvidenceUncertainty: "No attributable buyer purchase behavior.",
        })) });
      }),
      search: {
        async search(query) {
          if (domainSearches.length < 3) domainSearches.push(query);
          return [{
            id: query,
            url: `https://example.test/${query}`,
            title: query,
            text: "Operators repeat manual filing every week.",
          }];
        },
      },
    });

    expect(result.factors).toHaveLength(15);
    expect(domainFactorLimits).toEqual([11, 4]);
    expect(domainSearches).toEqual(["two", "three", "one"]);
    expect(result.factors.every((factor) => factor.supportsDemand === false)).toBe(true);
    expect(result.metrics).toMatchObject({
      extracted: { domain: 15, audience: 0 },
      accepted: { domain: 15, audience: 0 },
      retained: { domain: 15, audience: 0 },
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
      { id: "factor-1", subject: "Operators", behavior: "repeat filing", quote: "Contrary evidence.", sourceId: existing.id, harvestMode: "domain", modelConfidence: 0.8, sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: "operator-one", supportsDemand: false, source: existing },
      { id: "factor-2", subject: "Operators", behavior: "repeat filing", quote: "Supporting evidence.", sourceId: other.id, harvestMode: "audience", modelConfidence: 0.8, sourceRole: "measured", audienceFit: "intended-buyer", independentSourceKey: "study-two", supportsDemand: false, source: other },
    ];
    let killEvidence: unknown;
    const result = await discoverProblems(scope(), factors, [existing, other], {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => {
        if (request.stage === "problem-candidates") {
          return request.schema.parse({ problems: [{
            statement: "Operators duplicate recurring filings.",
            whyItPersists: "Systems do not share state.",
            affected: "Operators",
            scaleEstimate: "Recurring",
            scaleBasisFactorId: null,
            factorIds: factors.map((factor) => factor.id),
            intendedBuyerEvidenceFactorIds: factors.map((factor) => factor.id), evidenceGap: null,
          }] });
        }
        killEvidence = request.evidence;
        return request.schema.parse({
          verdict: "confirmed",
          verdictReason: "Contrary evidence does not resolve the problem.",
          verdictSourceIds: [existing.id],
          intendedBuyerEvidenceFactorIds: factors.map((factor) => factor.id), evidenceGap: null,
        });
      }),
      search: {
        async search() {
          return [{ id: "rediscovered", url: existing.url, title: existing.title, text: existing.retrievedText }];
        },
      },
    });

    expect(JSON.stringify(killEvidence)).toContain(existing.canonicalUrl);
    expect(result.killSources).toEqual([]);
    expect(result.problems[0]?.verdictSourceIds).toEqual([existing.id]);
    expect(result.problems[0]?.verdict).toBe("confirmed");
  });

  test("skips a search result whose URL cannot be parsed instead of failing the run", async () => {
    const skipped: string[] = [];
    const result = await harvestFactors(scope(), {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => {
        if (request.schema._def === QueryPlanOutputSchema._def) {
          return request.schema.parse({ queries: ["one", "two", "three"] });
        }
        return request.schema.parse({ factors: [] });
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
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => {
        if (request.schema._def === QueryPlanOutputSchema._def) {
          return request.schema.parse({ queries: ["one", "two", "three"] });
        }
        return request.schema.parse({ factors: [] });
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
  completion: (request: StructuredStageRequest<unknown>) => unknown | Promise<unknown>,
): StructuredModelClient {
  return {
    async structuredCompletion<T>(request: StructuredStageRequest<T>) {
      return {
        output: await completion(request as StructuredStageRequest<unknown>) as T,
        metadata: { model: request.model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [] },
      };
    },
  };
}
