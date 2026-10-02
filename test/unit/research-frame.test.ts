import { describe, expect, it } from "bun:test";
import { canonicalJson } from "../../src/shared/content-identity";
import { deriveJsonSchema, type JsonSchema } from "../../src/shared/json-schema";
import {
  FrameSearchPlanSchema, parseResearchFrame, ResearchFrameOutputSchema, ResearchFrameSchema,
  scopeResearchArea, selectResearchAreas, type ResearchAreaRanking, type ResearchFrame,
} from "../../src/shared/research-frame";

function sampleFrame(): ResearchFrame {
  return {
    goal: "Reduce deposit disputes in a small bakery",
    goalKind: "process-improvement",
    contextFacts: [{ fact: "The source describes nonrefundable custom order deposits.", sourceIds: ["policy"] }],
    successCriteria: [{ id: "disputes", name: "Fewer observed disputes", weight: "must", howJudged: "Compare disputes before and after a pilot", basis: "brief" }],
    constraints: [{ text: "Use the existing order system", kind: "resources", basis: "brief" }],
    languages: ["en"],
    areas: [{ id: "deposits", name: "Deposit expectations", whyRelevant: "Owners and customers dispute whether a deposit is refundable", affectedPeople: "Owners of small custom-order bakeries",
      venues: [{ name: "r/Baking", domain: "reddit.com", kind: "community" }], exampleProblems: ["Unclear refund expectations"], included: true, priority: 1 }],
    exclusions: ["Replacing the accounting system"],
    openQuestions: [{ id: "scope", question: "One bakery or a product for many?", whyItMatters: "Changes the build and demand test", options: ["One bakery", "Many bakeries"] }],
  };
}

describe("research frame boundary", () => {
  it("accepts complete source identities without changing entity-ID limits or accepting truncated citations", () => {
    const sourceId = `provider-source:${"a".repeat(4_096)}`;
    const frame = sampleFrame();
    frame.contextFacts[0]!.sourceIds = [sourceId];
    frame.successCriteria[0]!.basis = [sourceId];
    frame.constraints[0]!.basis = [sourceId];
    expect(parseResearchFrame(frame, { sourceIds: [sourceId], purpose: "discovery" })).toEqual(frame);
    const shape = deriveJsonSchema(ResearchFrameOutputSchema).properties!.frame!.properties!;
    expect(shape.contextFacts!.items!.properties!.sourceIds!.items).toEqual({ type: "string" });
    expect(shape.successCriteria!.items!.properties!.basis!.anyOf![1]!.items).toEqual({ type: "string" });
    expect(shape.constraints!.items!.properties!.basis!.anyOf![1]!.items).toEqual({ type: "string" });
    frame.contextFacts[0]!.sourceIds = [sourceId.slice(0, 128)];
    expect(() => parseResearchFrame(frame, { sourceIds: [sourceId], purpose: "discovery" })).toThrow("unknown source");
    frame.successCriteria[0]!.id = "a".repeat(129);
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("keeps sourced context separate from brief-based decisions and rejects fabricated citation IDs", () => {
    const frame = sampleFrame();
    expect(parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "discovery" })).toEqual(frame);
    frame.successCriteria[0]!.basis = ["made-up-source"];
    expect(() => parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "discovery" })).toThrow("unknown source");
    frame.successCriteria[0]!.basis = "brief";
    frame.constraints[0]!.basis = ["made-up-source"];
    expect(() => parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "discovery" })).toThrow("unknown source");
    frame.constraints[0]!.basis = "brief";
    frame.contextFacts[0]!.sourceIds = [];
    expect(() => parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "discovery" })).toThrow();
  });

  it("requires discovery coverage and prevents known-problem runs from launching a scan", () => {
    const frame = sampleFrame();
    expect(() => parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "known-problem" })).toThrow("no research areas");
    frame.areas = [];
    expect(parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "known-problem" }).areas).toEqual([]);
    expect(() => parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "discovery" })).toThrow("included research area");
    frame.areas = sampleFrame().areas.map(area => ({ ...area, included: false }));
    expect(() => parseResearchFrame(frame, { sourceIds: ["policy"], purpose: "discovery" })).toThrow("included research area");
  });

  it("rejects duplicate areas, unsupported regions and invalid language choices", () => {
    const frame = sampleFrame();
    frame.areas.push({ ...frame.areas[0]!, name: "Refund disputes" });
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
    frame.areas.pop();
    frame.areas.push({ ...frame.areas[0]!, id: "refunds", name: "DEPOSIT EXPECTATIONS" });
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
    frame.areas.pop();
    frame.areas[0]!.region = "ZZ";
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
    frame.areas[0]!.region = "UA";
    frame.languages = ["uk"];
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
    frame.languages = ["en", "uk"];
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(true);
    frame.languages = ["en", "zz"];
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
    frame.languages = ["en", "uk", "fr", "de"];
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
    frame.languages = ["en"];
    frame.areas = Array.from({ length: 13 }, (_, index) => ({ ...frame.areas[0]!, id: `area-${index}`, name: `Area ${index}`, priority: 1 }));
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("normalizes provider nulls without allowing a URL as a venue domain", () => {
    const frame = sampleFrame();
    const wire = { ...frame, version: null, areas: [{ ...frame.areas[0], region: null, venues: [{ ...frame.areas[0]!.venues[0], domain: null }] }],
      openQuestions: [{ ...frame.openQuestions[0], answer: null }] };
    const parsed = ResearchFrameOutputSchema.parse({ frame: wire }).frame;
    expect(parsed.areas[0]!.region).toBeUndefined();
    expect(parsed.areas[0]!.venues[0]!.domain).toBeUndefined();
    expect(parsed.openQuestions[0]!.answer).toBeUndefined();
    expect(Object.hasOwn(parsed, "version")).toBe(false);
    expect(Object.hasOwn(parsed.areas[0]!, "region")).toBe(false);
    expect(Object.hasOwn(parsed.areas[0]!.venues[0]!, "domain")).toBe(false);
    expect(Object.hasOwn(parsed.openQuestions[0]!, "answer")).toBe(false);
    expect(JSON.parse(canonicalJson(parsed))).toEqual(parsed);
    frame.areas[0]!.venues[0]!.domain = "https://reddit.com/r/Baking";
    expect(ResearchFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("keeps the context probe bounded and derives strict provider shapes while retaining app refinements", () => {
    expect(FrameSearchPlanSchema.safeParse({ queries: Array.from({ length: 6 }, (_, index) => ({ query: `Question ${index}`, reason: "Clarify scope" })) }).success).toBe(false);
    const schema = deriveJsonSchema(ResearchFrameOutputSchema);
    const visit = (node: JsonSchema) => {
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(node.properties ?? {}));
      }
      Object.values(node.properties ?? {}).forEach(visit);
      node.anyOf?.forEach(visit);
      if (node.items) visit(node.items);
    };
    visit(schema);
    const region = schema.properties!.frame!.properties!.areas!.items!.properties!.region!;
    expect(region.anyOf?.some(item => item.type === "null")).toBe(true);
    expect(() => ResearchFrameSchema.parse({ ...sampleFrame(), languages: ["uk"] })).toThrow();
  });
});

describe("scoped research and area selection", () => {
  it("narrows the audience and domain, carries exclusions, and keeps hypotheses out of observations", () => {
    const frame = sampleFrame();
    const scoped = scopeResearchArea({ title: "Bakery", domain: "Custom orders", audience: "", observations: "One owner reported a dispute", offLimits: ["New hardware"] }, frame.areas[0]!, frame);
    expect(scoped.domain).toBe("Deposit expectations. Owners and customers dispute whether a deposit is refundable");
    expect(scoped.audience).toBe("Owners of small custom-order bakeries");
    expect(scoped.observations).toBe("One owner reported a dispute");
    expect(scoped.offLimits).toEqual(["New hardware", "Replacing the accounting system"]);
  });

  it("selects evidence-bearing areas by rank and depth, excludes removed areas, and falls back honestly when all are empty", () => {
    const frame = sampleFrame();
    frame.areas = Array.from({ length: 5 }, (_, index) => ({ ...frame.areas[0]!, id: `area-${index}`, name: `Area ${index}`, priority: index + 1, included: index !== 4 }));
    const ranking: ResearchAreaRanking = { areas: frame.areas.filter(area => area.included).map((area, index) => ({ areaId: area.id, rank: index + 1,
      reason: "Observed relevance", evidenceStrength: "strong", fit: "meets" })) };
    expect(selectResearchAreas(frame, ranking, { "area-1": 1, "area-2": 2 }, "standard").map(area => area.id)).toEqual(["area-1", "area-2"]);
    // Standard investigates three evidence-bearing areas; live runs stopped at two while this count lived in two places.
    expect(selectResearchAreas(frame, ranking, { "area-0": 1, "area-1": 1, "area-2": 2, "area-3": 4 }, "standard").map(area => area.id))
      .toEqual(["area-0", "area-1", "area-2"]);
    expect(selectResearchAreas(frame, ranking, { "area-1": 1, "area-2": 2 }, "quick").map(area => area.id)).toEqual(["area-1"]);
    expect(selectResearchAreas(frame, ranking, {}, "deep").map(area => area.id)).toEqual(["area-0", "area-1", "area-2", "area-3"]);
    expect(() => selectResearchAreas(frame, { areas: ranking.areas.slice(1) }, {}, "quick")).toThrow("missing");
  });
});
