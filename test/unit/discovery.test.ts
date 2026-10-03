import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  batchSources,
  discoverProblems,
  harvestEvidenceFollowUp,
  harvestFactors,
  normalizeEvidenceText,
  qualifiesAsProblemObservation,
  quoteAppearsVerbatim,
  type HarvestedFactor,
  type HarvestedSource,
} from "../../src/core/discovery";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import { ProviderFailure } from "../../src/providers/structured";
import { QueryPlanOutputSchema } from "../../src/shared/structured-output-schemas";
import { AUDIENCE_SOURCE_BATCH_CHARACTERS, DISCOVERY_DEPTHS, discoveryRunProjection } from "../../src/shared/discovery-projection";
import { researchSearchAllocation } from "../../src/shared/research-revisions";

describe("discovery", () => {
  test.each(["quick", "standard", "deep"] as const)("budgets the candidate limit for %s depth", (depth) => {
    const expected = ({ quick: 3, standard: 4, deep: 8 } as const)[depth];
    expect(DISCOVERY_DEPTHS[depth].candidateLimit).toBe(expected);
    expect(discoveryRunProjection(depth).searches).toBe(({ quick: 11, standard: 20, deep: 36 } as const)[depth]);
    const allocation = researchSearchAllocation(20, depth);
    expect(allocation.candidateLimit).toBe(expected);
    expect(allocation.domainQueries + allocation.audienceQueries + allocation.candidateLimit).toBeLessThanOrEqual(20);
  });

  test.each([true, false])("accounts for all nine candidates while preserving the ranked policy (%s)", async (rankCandidates) => {
    const sources = Array.from({ length: 9 }, (_, index) => source(`support-${index}`, "Operators repeat filing."));
    const factors: HarvestedFactor[] = sources.map((item, index) => ({
      id: `factor-${index}`, subject: "Operators", behavior: "repeat filing", quote: item.retrievedText,
      sourceId: item.id, harvestMode: index < 5 ? "domain" : "audience", modelConfidence: 0.8,
      independentSourceKey: `operator-${index}`, sourceRole: "firsthand", audienceFit: "intended-buyer", source: item,
    }));
    const candidates = factors.map((factor, index) => ({
      statement: `Candidate ${index}`, whyItPersists: "Disconnected state", affected: "Operators", scaleEstimate: "Unknown",
      scaleBasisFactorId: null, factorIds: index === 5 ? [factor.id, "factor-6"] : [factor.id],
      intendedBuyerEvidenceFactorIds: [], evidenceGap: "More direct accounts needed",
      alternativeExplanations: ["An existing workflow may suffice"], unknowns: ["How often it happens"],
    }));
    let searches = 0;
    const result = await discoverProblems(scope(), factors, sources, {
      depth: "standard", workflowVersion: 2, rankCandidates, model, reasoningEffort, prompt: () => "Fixture instructions",
      modelClient: modelClient(request => request.schema.parse(request.stage === "problem-candidates"
        ? { problems: candidates } : { verdict: "insufficient-evidence", verdictReason: "More support needed", verdictSourceIds: [] })),
      search: { async search() { searches++; return []; } },
    });
    expect(result.problems.map((problem) => problem.statement)).toEqual(rankCandidates
      ? ["Candidate 5", "Candidate 0", "Candidate 6", "Candidate 1"]
      : ["Candidate 0", "Candidate 1", "Candidate 2", "Candidate 3"]);
    expect(searches).toBe(4);
    expect(result.blockedCandidates).toHaveLength(5);
    expect(result.blockedCandidates.map((candidate) => candidate.statement)).toEqual(rankCandidates
      ? ["Candidate 7", "Candidate 2", "Candidate 8", "Candidate 3", "Candidate 4"]
      : ["Candidate 4", "Candidate 5", "Candidate 6", "Candidate 7", "Candidate 8"]);
    for (const skipped of result.blockedCandidates) {
      expect(skipped.disposition).toBe("not-assessed");
      expect(skipped.reason).toContain("up to 4");
      expect(skipped.candidate).toEqual(candidates.find((candidate) => candidate.statement === skipped.statement));
    }
  });

  test("checking candidates side by side keeps the same problems, sources and IDs as checking them one by one", async () => {
    const sources = Array.from({ length: 4 }, (_, index) => source(`support-${index}`, "Operators repeat filing."));
    const factors: HarvestedFactor[] = sources.map((item, index) => ({
      id: `factor-${index}`, subject: "Operators", behavior: "repeat filing", quote: item.retrievedText,
      sourceId: item.id, harvestMode: "domain", modelConfidence: 0.8,
      independentSourceKey: `operator-${index}`, sourceRole: "firsthand", audienceFit: "intended-buyer", source: item,
    }));
    const candidates = factors.map((factor, index) => ({
      statement: `Candidate ${index}`, whyItPersists: "Disconnected state", affected: "Operators", scaleEstimate: "Unknown",
      scaleBasisFactorId: null, factorIds: [factor.id], intendedBuyerEvidenceFactorIds: [], evidenceGap: "More direct accounts needed",
    }));
    const run = async (parallelChecks: boolean) => {
      let active = 0;
      let peak = 0;
      let next = 0;
      const verdictEvidence: string[] = [];
      const result = await discoverProblems(scope(), factors, sources, {
        depth: "standard", workflowVersion: 2, rankCandidates: true, parallelChecks, model, reasoningEffort,
        prompt: () => "Fixture instructions", idFactory: () => `id-${next++}`,
        modelClient: modelClient(async request => {
          if (request.stage === "problem-candidates") return request.schema.parse({ problems: candidates });
          verdictEvidence.push(JSON.stringify(request.evidence));
          peak = Math.max(peak, ++active);
          await Bun.sleep(5);
          active--;
          return request.schema.parse({ verdict: "insufficient-evidence", verdictReason: "More support needed", verdictSourceIds: [] });
        }),
        // Every contrary search returns one shared page, so its source ID depends on the order candidates are recorded in.
        search: { async search(query) {
          await Bun.sleep(query.length % 4);
          return [{ id: "shared", url: "https://example.test/shared", title: "Shared", text: "Operators repeat filing." },
            { id: query, url: `https://example.test/${encodeURIComponent(query)}`, title: query, text: `Contrary page for ${query}.` }];
        } },
      });
      return { result, peak, verdictEvidence: verdictEvidence.sort() };
    };
    const sequential = await run(false);
    const parallel = await run(true);
    expect(sequential.peak).toBe(1);
    expect(parallel.peak).toBeGreaterThan(1);
    // Retrieval timestamps are wall-clock; everything else, including every ID, must match.
    const comparable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, field) => key === "retrievedAt" ? undefined : field));
    expect(comparable(parallel.result)).toEqual(comparable(sequential.result));
    expect(parallel.verdictEvidence).toEqual(sequential.verdictEvidence);
  });

  test("does not inflate independent support with duplicate citations or transport URLs", async () => {
    const sources = [source("one", "One report"), source("mirror", "Same report"), source("two", "Second report")];
    const factors: HarvestedFactor[] = sources.map((item, index) => ({
      id: `factor-${index}`, subject: "Operators", behavior: "repeat filing", quote: item.retrievedText,
      sourceId: item.id, harvestMode: "domain", modelConfidence: 0.8,
      independentSourceKey: index === 2 ? "operator-two" : "operator-one", source: item,
    }));
    const base = { whyItPersists: "Disconnected state", affected: "Operators", scaleEstimate: "Unknown", scaleBasisFactorId: null };
    const result = await discoverProblems(scope(), factors, sources, {
      candidateLimit: 1, workflowVersion: 2, model, reasoningEffort, prompt: () => "Fixture instructions",
      modelClient: modelClient(request => request.schema.parse(request.stage === "problem-candidates" ? { problems: [
        { ...base, statement: "One origin repeated", factorIds: ["factor-0", "factor-0", "factor-1"] },
        { ...base, statement: "Two independent origins", factorIds: ["factor-0", "factor-2"] },
      ] } : { verdict: "insufficient-evidence", verdictReason: "Unknown", verdictSourceIds: [] })),
      search: { async search() { return []; } },
    });
    expect(result.problems[0]?.statement).toBe("Two independent origins");
    expect(result.blockedCandidates[0]?.statement).toBe("One origin repeated");
  });

  test("sends actual Ukrainian queries through both firsthand legs and retains the planner's reason", async () => {
    const searches: Array<{ query: string; route?: string; languages?: string[] }> = [];
    const planned: Array<{ query: string; uncertainty?: string; intendedSourceType?: string }> = [];
    await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2,
      queryCountByMode: { domain: 1, audience: 0 }, sourceRouting: { goalKind: "community-or-personal", languages: ["en", "uk"] },
      prompt: () => "Plan translated fixture evidence",
      modelClient: modelClient(async () => ({ queries: [{ query: "Dorm kitchen wasted food", intent: "firsthand-experience",
        uncertainty: "Shared food discarded", intendedSourceType: "Student accounts",
        translations: [{ language: "uk", query: "Харчові відходи на спільній кухні гуртожитку" }] }] })),
      onPlannedQueries: (_mode, queries) => planned.push(...queries),
      search: { async search(query, options) {
        searches.push({ query, ...(options?.route ? { route: options.route } : {}), ...(options?.languages ? { languages: options.languages } : {}) });
        return [];
      } },
    });
    expect(searches).toEqual([
      { query: "Dorm kitchen wasted food", route: "open-web", languages: ["en"] },
      { query: "Dorm kitchen wasted food", route: "community", languages: ["en"] },
      { query: "Харчові відходи на спільній кухні гуртожитку", route: "open-web", languages: ["uk"] },
      { query: "Харчові відходи на спільній кухні гуртожитку", route: "community", languages: ["uk"] },
    ]);
    expect(planned[0]).toMatchObject({ uncertainty: "Shared food discarded", intendedSourceType: "Student accounts" });
  });

  test("a missing translation searches in English instead of ending the run", async () => {
    const searched: string[] = [];
    await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2,
      queryCountByMode: { domain: 1, audience: 0 }, sourceRouting: { goalKind: "research-question", languages: ["en", "uk"] },
      prompt: () => "Plan fixture evidence",
      modelClient: modelClient(async () => ({ queries: [{ query: "Observed clinic retention", intent: "measured-behavior",
        uncertainty: "Retention rate", intendedSourceType: "Field studies" }] })),
      search: { async search(query) { searched.push(query); return []; } },
    });
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every(query => query.includes("Observed clinic retention"))).toBe(true);
  });

  test("an evidence read that runs too long is split into smaller reads, and one unreadable source is skipped", async () => {
    // Live Bookkeepers ended when one follow-up read of every search result ran 38 minutes into the output limit.
    const stages: string[] = [];
    const projections: string[] = [];
    const result = await harvestEvidenceFollowUp(scope(), "Do operators repeat filing?", {
      model, reasoningEffort, workflowVersion: 2, followUpKey: "gap-1", prompt: () => "Extract fixture evidence",
      onProjection: (message) => projections.push(message),
      modelClient: modelClient(request => {
        stages.push(request.stage);
        const sources = (request.evidence[0]!.content as { sources: Array<{ id: string; url: string; text: string }> }).sources;
        if (sources.length > 1) throw new ProviderFailure("output-limit", "Output limit reached", false);
        if (sources[0]!.url.endsWith("/stalls")) throw new ProviderFailure("timeout", "Call time limit reached", false);
        return { factors: [{ subject: "Operators", behavior: "repeat filing", quote: sources[0]!.text, sourceId: sources[0]!.id, modelConfidence: 0.8 }] };
      }),
      search: { async search() { return ["first", "second", "stalls"].map(name => ({ id: name, url: `https://example.test/${name}`,
        title: name, text: `Operators repeat filing at ${name}.` })); } },
    });
    expect(result.factors.map(factor => factor.source.canonicalUrl)).toEqual(["https://example.test/first", "https://example.test/second"]);
    // The whole batch, its first half, each single source, and one restart of the stalled source.
    expect(stages).toHaveLength(6);
    expect(stages[0]).toBe("factor-harvest:follow-up:gap-1");
    expect(new Set(stages).size).toBe(5);
    expect(stages[5]).toBe(stages[4]);
    expect(projections.filter(message => message.includes("two smaller batches"))).toHaveLength(2);
    expect(projections).toContain("Reading 1 source stalled; starting it again.");
    expect(projections).toContain("Skipped https://example.test/stalls: the model could not finish reading it.");
  });

  test("a stalled evidence read starts over with the same sources instead of splitting them", async () => {
    // In live Bookkeepers runs, every read that hit the time limit finished in seconds on its next try.
    const stages: string[] = [];
    let stalls = 1;
    const result = await harvestEvidenceFollowUp(scope(), "Do operators repeat filing?", {
      model, reasoningEffort, workflowVersion: 2, followUpKey: "gap-1", prompt: () => "Extract fixture evidence",
      modelClient: modelClient(request => {
        stages.push(request.stage);
        if (stalls-- > 0) throw new ProviderFailure("timeout", "Call time limit reached", false);
        const sources = (request.evidence[0]!.content as { sources: Array<{ id: string; text: string }> }).sources;
        return { factors: sources.map(source => ({ subject: "Operators", behavior: "repeat filing", quote: source.text,
          sourceId: source.id, modelConfidence: 0.8 })) };
      }),
      search: { async search() { return ["first", "second"].map(name => ({ id: name, url: `https://example.test/${name}`,
        title: name, text: `Operators repeat filing at ${name}.` })); } },
    });
    expect(stages).toEqual(["factor-harvest:follow-up:gap-1", "factor-harvest:follow-up:gap-1"]);
    expect(result.factors.map(factor => factor.source.canonicalUrl)).toEqual(["https://example.test/first", "https://example.test/second"]);
  });

  test("reading source batches in parallel keeps the same facts, in the same order, as reading them one by one", async () => {
    const run = async (parallelReads: number) => {
      let active = 0;
      let peak = 0;
      let next = 0;
      const result = await harvestFactors(scope(), {
        model, reasoningEffort, depth: "standard", workflowVersion: 2, guided: true, smallHarvestBatches: true, parallelReads,
        queryCountByMode: { domain: 1, audience: 0 }, prompt: () => "Read fixture evidence", idFactory: () => `fact-${next++}`, random: () => 0.5,
        modelClient: modelClient(async request => {
          if (request.stage.startsWith("query-plan")) return { queries: [{ query: "operators repeat filing", intent: "firsthand-experience",
            uncertainty: "Frequency", intendedSourceType: "Operator reports" }] };
          active += 1;
          peak = Math.max(peak, active);
          const sources = (request.evidence[0]!.content as { sources: Array<{ id: string; text: string }> }).sources;
          // Earlier batches answer later, so completion order differs from batch order.
          await Bun.sleep(5 * (10 - sources[0]!.text.length % 10));
          active -= 1;
          return { factors: sources.map(item => ({ subject: "Operators", behavior: "repeat filing", quote: item.text, sourceId: item.id, modelConfidence: 0.8 })) };
        }),
        search: { async search() { return Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, url: `https://example.test/${index}`,
          title: "Operator", text: `Operators repeat filing ${"x".repeat(index)}.` })); } },
      });
      return { peak, facts: result.factors.map(factor => [factor.id, factor.source.canonicalUrl]) };
    };
    const sequential = await run(1);
    const parallel = await run(3);
    expect(sequential.peak).toBe(1);
    expect(parallel.peak).toBe(3);
    expect(parallel.facts.length).toBeGreaterThan(3);
    expect(parallel.facts).toEqual(sequential.facts);
  });

  test("new runs read follow-up sources in small capped batches", async () => {
    const batches: Array<{ size: number; factorLimit: unknown }> = [];
    await harvestEvidenceFollowUp(scope(), "Do operators repeat filing?", {
      model, reasoningEffort, workflowVersion: 2, boundedFollowUpHarvest: true, prompt: () => "Extract fixture evidence",
      modelClient: modelClient(request => {
        const sources = (request.evidence[0]!.content as { sources: unknown[] }).sources;
        batches.push({ size: sources.length, factorLimit: (request.workOrder.inputs as { factorLimit?: unknown }).factorLimit });
        return { factors: [] };
      }),
      search: { async search() { return Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, url: `https://example.test/${index}`,
        title: "Owner", text: "Operators repeat filing." })); } },
    });
    expect(batches.map(batch => batch.size)).toEqual([3, 2]);
    expect(batches.every(batch => batch.factorLimit === 6)).toBe(true);
  });

  test("a buying-intent search planned for a research question is skipped, not run-ending", async () => {
    const searched: string[] = [];
    await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2,
      queryCountByMode: { domain: 1, audience: 0 }, sourceRouting: { goalKind: "research-question", languages: ["en"] },
      prompt: () => "Plan fixture evidence",
      modelClient: modelClient(async () => ({ queries: [
        { query: "Clinic software pricing", intent: "buying-signal", uncertainty: "Budget", intendedSourceType: "Vendor pages" },
        { query: "Observed clinic retention", intent: "measured-behavior", uncertainty: "Retention rate", intendedSourceType: "Field studies" },
      ] })),
      search: { async search(query) { searched.push(query); return []; } },
    });
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.some(query => query.includes("pricing"))).toBe(false);
  });

  test("rediscovered evidence keeps the saved source ID and quote before extraction", async () => {
    const saved = source("saved-context", "Operators repeat filing.");
    const result = await harvestEvidenceFollowUp(scope(), "What did the operator report?", {
      model, reasoningEffort, workflowVersion: 2, existingSources: () => [saved],
      prompt: () => "Extract fixture evidence",
      modelClient: modelClient(request => {
        const evidence = request.evidence[0]!.content as { sources: Array<{ id: string; text: string }> };
        expect(evidence.sources[0]).toMatchObject({ id: saved.id, text: saved.retrievedText });
        return { factors: [{ subject: "Operators", behavior: "repeat filing", quote: saved.retrievedText,
          sourceId: saved.id, modelConfidence: 0.8 }] };
      }),
      search: { async search() { return [{ id: "provider-new", url: saved.url, title: "Updated page", text: "A different new summary." }]; } },
    });
    expect(result.sources).toEqual([saved]);
    expect(result.factors[0]).toMatchObject({ sourceId: saved.id, quote: saved.retrievedText });
  });

  test("saved measured observations prevent one new vendor page from demoting the whole domain", async () => {
    const exclusions: string[][] = [];
    await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2,
      queryCountByMode: { domain: 1, audience: 1 }, sourceRouting: {},
      existingFactors: () => Array.from({ length: 4 }, () => ({ sourceRole: "measured", source: { url: "https://example.test/study" } })),
      prompt: () => "Extract fixture evidence",
      modelClient: modelClient(request => {
        if (request.stage.startsWith("query-plan")) return { queries: [{ query: request.stage, intent: "firsthand-experience",
          uncertainty: "Operator workflow", intendedSourceType: "Operator report" }] };
        const evidence = request.evidence[0]!.content as { sources: Array<{ id: string; text: string }> };
        return { factors: [{ subject: "Vendor", behavior: "claims workflow savings", quote: evidence.sources[0]!.text,
          sourceId: evidence.sources[0]!.id, modelConfidence: 0.8, sourceRole: "vendor", audienceFit: "not-intended-buyer",
          uncertainty: "Vendor claim", independentSourceKey: null, supportsDemand: false, demandEvidenceUncertainty: "Not a buyer report" }] };
      }),
      search: { async search(query, options) {
        exclusions.push(options?.excludeDomains ?? []);
        return [{ id: query, url: `https://example.test/${query.includes("audience") ? "audience" : "domain"}`, title: "Vendor page", text: "We automate filing." }];
      } },
    });
    expect(exclusions).toHaveLength(4);
    expect(exclusions.every(domains => !domains.includes("example.test"))).toBe(true);
  });
  test("permits a measured-only scan for a research question without a buyer intent", async () => {
    const searches: string[] = [];
    await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2,
      queryCountByMode: { domain: 1, audience: 0 }, sourceRouting: { goalKind: "research-question" },
      prompt: () => "Plan fixture measurements",
      modelClient: modelClient(async () => ({ queries: [{ query: "Measured clinic outcomes", intent: "measured-behavior",
        uncertainty: "Observed retention", intendedSourceType: "Field studies" }] })),
      search: { async search(_query, options) { searches.push(options?.route ?? "missing"); return []; } },
    });
    expect(searches).toEqual(["studies-official"]);
  });
  test("routes each planned firsthand question through two legs and excludes content farms before extraction", async () => {
    const routes: string[] = [];
    let extractionCalls = 0;
    const result = await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2, sourceRouting: { now: new Date("2026-09-30T00:00:00.000Z") },
      prompt: () => "Plan and read fixture evidence",
      modelClient: modelClient(async (request) => {
        if (request.stage.startsWith("query-plan:")) return { queries: ["current-alternative", "measured-behavior", "firsthand-experience"].map((intent) => ({
          query: `${request.stage} ${intent}`, intent, uncertainty: "An unknown", intendedSourceType: "Evidence",
        })) };
        extractionCalls += 1;
        return { factors: [] };
      }),
      search: { async search(_query, options) {
        routes.push(options?.route ?? "missing");
        return [{ id: "farm", url: "https://worldmetrics.org/page", title: "Content farm", text: "Untrusted statistics" }];
      } },
    });
    expect(routes).toEqual(["alternatives", "studies-official", "open-web", "community", "alternatives", "studies-official", "open-web", "community"]);
    expect(extractionCalls).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.factors).toEqual([]);
  });
  test("retains historical source packets when reopening an older completed extraction", async () => {
    let extractionCalls = 0;
    const result = await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", workflowVersion: 2,
      queryCountByMode: { domain: 1, audience: 0 },
      sourceRouting: { preserveHistoricalSources: true },
      prompt: () => "Read a saved source packet",
      modelClient: modelClient(async (request) => {
        if (request.stage.startsWith("query-plan:")) return { queries: [{ query: "Saved question", intent: "firsthand-experience", uncertainty: "Saved uncertainty", intendedSourceType: "Saved reports" }] };
        extractionCalls += 1;
        return { factors: [] };
      }),
      search: { async search() { return [{ id: "historical", url: "https://worldmetrics.org/saved", title: "Historical result", text: "Saved source contents" }]; } },
    });
    expect(extractionCalls).toBe(1);
    expect(result.sources.map((source) => source.url)).toEqual(["https://worldmetrics.org/saved"]);
  });
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
  test.each([1, 5])("guided depth accepts %s useful queries instead of enforcing the three-query estimate", async (count) => {
    const searches: string[] = [];
    await harvestFactors(scope(), {
      model, reasoningEffort, depth: "quick", guided: true, workflowVersion: 2,
      prompt: () => "Plan useful searches.",
      modelClient: modelClient(async (request) => request.schema.parse({
        queries: Array.from({ length: count }, (_, index) => `Question ${index + 1}`),
      })),
      search: { async search(query) { searches.push(query); return []; } },
    });
    expect(searches).toHaveLength(count * 2);
  });

  test("normalizes typography and whitespace before checking a quote", () => {
    const source = "People said “this\u00a0takes — far too long” after filing.";
    expect(normalizeEvidenceText(source)).toBe('People said "this takes - far too long" after filing.');
    expect(quoteAppearsVerbatim(source, 'this takes - far too long')).toBe(true);
    expect(quoteAppearsVerbatim(source, "this is fast")).toBe(false);
  });

  test.each(["vendor", "recommendation", "illustration", "unknown"] as const)(
    "does not treat %s evidence as an observed intended-buyer behavior",
    (sourceRole) => {
    expect(qualifiesAsProblemObservation({
      id: "factor", subject: "Teams", behavior: "compare prices", quote: "Pricing details", sourceId: "source",
      harvestMode: "domain", modelConfidence: 0.8, sourceRole, audienceFit: "intended-buyer",
      independentSourceKey: "comparison", supportsDemand: false,
    })).toBe(false);
  });

  test("defines measured evidence as observed outcomes and keeps catalog facts illustrative", () => {
    const prompt = readFileSync("prompts/workflow-v2-factor-harvest.md", "utf8");
    expect(prompt).toContain("measured reports actual observed behavior or outcomes");
    expect(prompt).toContain("advertised prices, plan limits, feature catalogs, and arithmetic based on those facts");
    expect(prompt).toContain("Never turn \"Use structured logs\" into the observed behavior \"uses structured logs.\"");
    expect(prompt).toContain("Buying inventory, raw materials, replacement parts, or other core-business inputs does not establish demand");
    expect(prompt).toContain("Preserve such purchases as workflow evidence when relevant, but set supportsDemand false.");
  });

  test("keeps intended-buyer problem observations separate from demand in synthesis prompts", () => {
    const candidates = readFileSync("prompts/workflow-v2-problem-candidates.md", "utf8");
    const kill = readFileSync("prompts/workflow-v2-problem-kill.md", "utf8");
    for (const prompt of [candidates, kill]) {
      expect(prompt).toMatch(/audienceFit (?:is )?intended-buyer/);
      expect(prompt).toContain("sourceRole");
      expect(prompt).toContain("regardless of supportsDemand");
      expect(prompt).not.toContain("supportsDemand true");
    }
    expect(candidates).toMatch(/willingness to pay is an uncertainty about a product opportunity/i);
    expect(kill).toContain("missing willingness-to-pay evidence as a separate unresolved assumption");
  });

  test("keeps a genuine buyer outcome when only prevalence is unmeasured", () => {
    expect(qualifiesAsProblemObservation({
      id: "factor", subject: "One shop", behavior: "paid $50 after leaving the free plan", quote: "We paid $50", sourceId: "source",
      harvestMode: "audience", modelConfidence: 0.9, sourceRole: "firsthand", audienceFit: "intended-buyer",
      independentSourceKey: "shop-one", supportsDemand: true,
      uncertainty: "One shop paid $50 after leaving the free plan; prevalence was not measured.",
    })).toBe(true);
    expect(qualifiesAsProblemObservation({
      id: "factor-two", subject: "One small repair shop", behavior: "loses two hours each week copying repair status",
      quote: "I lose two hours each week", sourceId: "source", harvestMode: "audience", modelConfidence: 0.9,
      sourceRole: "firsthand", audienceFit: "intended-buyer", independentSourceKey: "shop-one",
      supportsDemand: false, uncertainty: "No observed purchase or payment; one shop reported the workaround.",
    })).toBe(true);
  });

  test("keeps firsthand problem evidence separate from missing purchase evidence", () => {
    expect(qualifiesAsProblemObservation({
      id: "factor", subject: "One small repair shop", behavior: "loses two hours each week copying repair status into spreadsheets",
      quote: "I lose two hours each week copying repair status into spreadsheets", sourceId: "source",
      harvestMode: "audience", modelConfidence: 0.9, sourceRole: "firsthand", audienceFit: "intended-buyer",
      independentSourceKey: "shop-one", supportsDemand: false,
      uncertainty: "One shop; prevalence was not measured.",
      demandEvidenceUncertainty: "No observed purchase or payment.",
    })).toBe(true);
  });

  test("preserves every classification field from a follow-up harvest", async () => {
    const result = await harvestEvidenceFollowUp(scope(), "Which operators pay for this workaround?", {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => {
        const evidence = request.evidence[0]!.content as { sources: Array<{ id: string }> };
        return request.schema.parse({ factors: [{
          subject: "Repair shops",
          behavior: "paid for a delivery tracking service",
          quote: "We paid for delivery tracking last year.",
          sourceId: evidence.sources[0]!.id,
          modelConfidence: 0.91,
          uncertainty: "One shop reported the purchase; prevalence is unknown.",
          sourceRole: "firsthand",
          audienceFit: "intended-buyer",
          independentSourceKey: "repair-shop-one",
          supportsDemand: true,
          demandEvidenceUncertainty: "The renewal decision was not reported.",
        }] });
      }),
      search: {
        async search() {
          return [{
            id: "follow-up-source",
            url: "https://example.test/follow-up",
            title: "Repair shop interview",
            text: "We paid for delivery tracking last year.",
          }];
        },
      },
    });

    expect(result.factors[0]).toMatchObject({
      uncertainty: "One shop reported the purchase; prevalence is unknown.",
      sourceRole: "firsthand",
      audienceFit: "intended-buyer",
      independentSourceKey: "repair-shop-one",
      supportsDemand: true,
      demandEvidenceUncertainty: "The renewal decision was not reported.",
    });
  });

  test("batches sources without splitting a source", () => {
    const sources = [source("one", "a".repeat(30)), source("two", "b".repeat(30))];
    const batches = batchSources(sources, 90);
    expect(batches).toHaveLength(2);
    expect(batches.flat().map((item) => item.id)).toEqual(["one", "two"]);
  });

  test("guided discovery processes a 23-source result in small complete evidence batches", async () => {
    const batches: Array<{ sources: Array<{ id: string }>; factorLimit: number }> = [];
    const activity: string[] = [];
    await harvestFactors(scope(), {
      model, reasoningEffort: "xhigh", guided: true, depth: "standard", workflowVersion: 2,
      prompt: () => "Extract verified observations.", onProjection: message => activity.push(message),
      modelClient: modelClient(async request => {
        if (request.stage.startsWith("query-plan")) return { queries: ["one"] };
        expect(request.model).toEqual(model);
        expect(request.reasoningEffort).toBe("xhigh");
        const content = request.evidence[0]!.content as { sources: Array<{ id: string }> };
        const factorLimit = Number((request.workOrder.inputs as { factorLimit: number }).factorLimit);
        batches.push({ ...content, factorLimit });
        expect(content.sources.length).toBeLessThanOrEqual(3);
        expect(factorLimit).toBeLessThanOrEqual(6);
        return { factors: [] };
      }),
      search: { async search() { return Array.from({ length: 23 }, (_, index) => ({
        id: String(index), url: `https://example.test/source/${index}`, title: `Source ${index}`, text: "Evidence. ".repeat(200),
      })); } },
    });
    expect(batches.length).toBeGreaterThanOrEqual(8);
    expect(new Set(batches.flatMap(batch => batch.sources.map(source => source.id))).size).toBe(23);
    expect(activity.some(message => message.includes("batch 1 of 8"))).toBe(true);
  });

  test("keeps standard audience extraction packets below the Sol timeout boundary", () => {
    const sources = Array.from({ length: 18 }, (_, index) => source(`audience-${index}`, "a".repeat(3_000)));
    const batches = batchSources(sources, AUDIENCE_SOURCE_BATCH_CHARACTERS);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((item) => item.id)).toEqual(sources.map((item) => item.id));
    expect(discoveryRunProjection("standard")).toMatchObject({ modelCalls: 19, searches: 20 });
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
      expect(request.deadlineMs).toBeUndefined();
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
        return request.schema.parse({ factors: Array.from({ length: count }, (_, index) => ({
          subject: "Operators",
          behavior: index === 0 ? "uses structured logs" : "repeat manual filing",
          quote: "repeat manual filing every week",
          sourceId,
          modelConfidence: 0.8,
          uncertainty: "This is a hypothetical calculation from advertised prices, not observed adoption.",
          sourceRole: index === 0 ? "recommendation" : index === 1 ? "vendor" : "illustration", audienceFit: "intended-buyer",
          independentSourceKey: "comparison-one", supportsDemand: true,
          demandEvidenceUncertainty: "No observed customer bill or purchase behavior.",
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
    expect(result.factors.some((factor) => factor.sourceRole === "vendor")).toBe(true);
    expect(result.factors.some((factor) => factor.behavior === "Recommendation: uses structured logs")).toBe(true);
    expect(result.factors.every((factor) => factor.behavior.length <= 280)).toBe(true);
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
    const synthesisDeadlines: Array<{ stage: string; deadlineMs: number | undefined }> = [];
    const result = await discoverProblems(scope(), factors, [existing, other], {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => {
        synthesisDeadlines.push({ stage: request.stage, deadlineMs: request.deadlineMs });
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
    expect(synthesisDeadlines).toEqual([
      { stage: "problem-candidates", deadlineMs: undefined },
      { stage: expect.stringMatching(/^problem-kill:/), deadlineMs: undefined },
    ]);
    expect(result.killSources).toEqual([]);
    expect(result.problems[0]?.verdictSourceIds).toEqual([existing.id]);
    expect(result.problems[0]?.verdict).toBe("confirmed");
  });

  test.each([
    ["accepts distinct buyer origins hosted on one forum", ["buyer-one", "buyer-two"], "confirmed", null],
    ["keeps a concrete gap when buyer origins are not independent", ["buyer-one", "buyer-one"], "insufficient-evidence", "More independent intended-buyer evidence is required."],
  ] as const)("%s", async (_name, sourceKeys, expectedVerdict, expectedGap) => {
    const sources = [source("one", "First buyer report."), source("two", "Second buyer report.")];
    const factors: HarvestedFactor[] = sources.map((item, index) => ({
      id: `factor-${index + 1}`,
      subject: "Operators",
      behavior: "repeat filing",
      quote: item.retrievedText,
      sourceId: item.id,
      harvestMode: "audience",
      modelConfidence: 0.8,
      sourceRole: "firsthand",
      audienceFit: "intended-buyer",
      independentSourceKey: sourceKeys[index]!,
      supportsDemand: false,
      source: item,
    }));
    const result = await discoverProblems(scope(), factors, sources, {
      prompt: () => "Fixture discovery instructions",
      workflowVersion: 2,
      model,
      reasoningEffort,
      depth: "quick",
      modelClient: modelClient(async (request) => request.schema.parse(request.stage === "problem-candidates"
        ? { problems: [{
            statement: "Operators duplicate recurring filings.",
            whyItPersists: "Systems do not share state.",
            affected: "Operators",
            scaleEstimate: "Recurring",
            scaleBasisFactorId: null,
            factorIds: factors.map((factor) => factor.id),
            intendedBuyerEvidenceFactorIds: factors.map((factor) => factor.id),
            evidenceGap: null,
          }] }
        : {
            verdict: "confirmed",
            verdictReason: "No contrary evidence resolves the problem.",
            verdictSourceIds: factors.map((factor) => factor.sourceId),
            intendedBuyerEvidenceFactorIds: factors.map((factor) => factor.id),
            evidenceGap: null,
            briefFit: "direct",
            contraryEvidence: "resolved",
            workflowKey: "operator: repeat filing after status change",
          })),
      search: { async search() { return []; } },
    });

    const problem = result.problems[0]!;
    expect(problem.sourceHostnames).toEqual(["example.test"]);
    expect(problem.verdict).toBe(expectedVerdict);
    expect(problem.evidenceGap).toBe(expectedGap);
    expect(problem).toMatchObject({
      briefFit: "direct", contraryEvidence: "resolved", workflowKey: "operator: repeat filing after status change",
    });
    expect(problem.verdictReason).not.toContain("null");
    if (expectedGap) expect(problem.verdictReason).toContain(expectedGap);
    else expect(problem.verdictReason).toBe("No contrary evidence resolves the problem.");
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

test.each([
  ["", ["study-one", "study-two"], "confirmed"],
  ["", ["same-study", "same-study"], "insufficient-evidence"],
  ["specified audience", ["study-one", "study-two"], "insufficient-evidence"],
] as const)("assesses discovered users without inventing independence or changing a named audience: %s", async (audience, keys, verdict) => {
  const sources = [source("one", "Operators repeat filing."), source("two", "Other operators repeat filing.")];
  const factors: HarvestedFactor[] = sources.map((item, index) => ({
    id: `factor-${index}`, subject: "Operators", behavior: "repeat filing", quote: item.retrievedText,
    sourceId: item.id, harvestMode: "domain", modelConfidence: 0.8, sourceRole: "unknown",
    audienceFit: "unknown", independentSourceKey: null, supportsDemand: false, source: item,
  }));
  const before = structuredClone(factors);
  const assessments = factors.map((factor, index) => ({ factorId: factor.id, sourceRole: "firsthand" as const,
    audienceFit: "intended-buyer" as const, independentSourceKey: keys[index]!, reason: "Direct account by the affected operators." }));
  const result = await discoverProblems({ ...scope(), audience }, factors, sources, {
    workflowVersion: 2, assessProblemAudience: true,
    model: { providerId: "openai-subscription", modelId: "gpt-6-astra" }, reasoningEffort: "xhigh", prompt: () => "Assess supplied evidence",
    search: { async search() { return []; } },
    modelClient: modelClient(async request => request.schema.parse(request.stage === "problem-candidates"
      ? { problems: [{ statement: "Operators duplicate recurring filings.", whyItPersists: "Systems do not share state.",
          affected: "Operators", scaleEstimate: "Unmeasured", scaleBasisFactorId: null,
          factorIds: factors.map(factor => factor.id), intendedBuyerEvidenceFactorIds: [], evidenceGap: "Audience was not specified." }] }
      : { verdict: "confirmed", verdictReason: "Direct accounts support the workflow problem.", verdictSourceIds: sources.map(item => item.id),
          intendedBuyerEvidenceFactorIds: factors.map(factor => factor.id), evidenceGap: null, briefFit: "direct",
          contraryEvidence: "resolved", workflowKey: "operators: recurring filing", factorAssessments: assessments })),
  });
  expect(result.problems[0]?.verdict).toBe(verdict);
  expect(factors).toEqual(before);
  expect(result.problems[0]?.factors.map(factor => factor.quote)).toEqual(before.map(factor => factor.quote));
  expect(result.problems[0]?.factors.every(factor => !factor.supportsDemand)).toBe(true);
  if (!audience) expect(result.problems[0]?.factorAssessments).toEqual(assessments);
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
