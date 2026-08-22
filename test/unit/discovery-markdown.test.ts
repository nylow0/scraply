import { describe, expect, test } from "bun:test";
import {
  renderDiscoveryArmMarkdown,
  renderPhase1AblationMarkdown,
} from "../../src/core/discovery-markdown";
import type {
  HarvestedFactor,
  HarvestedSource,
  Phase1AblationResult,
} from "../../src/core/discovery";

const source = (id: string, hostname: string): HarvestedSource => ({
  id,
  providerSourceId: id,
  url: `https://${hostname}/original/${id}`,
  canonicalUrl: `https://${hostname}/source/${id}`,
  title: `Source ${id}`,
  retrievedText: `Retrieved text for ${id}`,
  author: null,
  publishedAt: null,
  contentHash: `hash-${id}`,
  retrievedAt: "2026-08-04T12:00:00.000Z",
});

const factor = (
  id: string,
  subject: string,
  behavior: string,
  quote: string,
  harvestMode: "domain" | "audience",
  factorSource: HarvestedSource,
): HarvestedFactor => ({
  id,
  subject,
  behavior,
  quote,
  sourceId: factorSource.id,
  harvestMode,
  modelConfidence: 0.8,
  source: factorSource,
});

const domainSource = source("domain-1", "rules.example.com");
const audienceSource = source("audience-1", "forum.example.com");
const unusedDomainSource = source("domain-2", "filings.example.com");
const unusedAudienceSource = source("audience-2", "community.example.com");
const killSource = source("kill-1", "counter.example.com");
const domainFactor = factor(
  "factor-domain-1",
  "Independent sellers",
  "file duplicate reimbursement forms",
  "Sellers must submit the same invoice in both portals.",
  "domain",
  domainSource,
);
const audienceFactor = factor(
  "factor-audience-1",
  "Store owners",
  "repeat claims after silent denials",
  "I had to submit the claim three times before anyone answered.",
  "audience",
  audienceSource,
);
const allFactors = [
  domainFactor,
  audienceFactor,
  factor("factor-domain-2", "Platforms", "publish filing rules", "Rules are published quarterly.", "domain", unusedDomainSource),
  factor("factor-audience-2", "Operators", "compare denial notes", "We compare notes after denials.", "audience", unusedAudienceSource),
];

const result: Phase1AblationResult = {
  scope: {
    title: "Marketplace reimbursement",
    audience: "Independent online sellers",
    domain: "Marketplace reimbursement operations",
    observations: "Sellers mention repeated paperwork.",
    offLimits: ["Do not propose lending products"],
  },
  harvest: {
    factors: allFactors,
    sources: [domainSource, audienceSource, unusedDomainSource, unusedAudienceSource],
    rejections: [
      { harvestMode: "domain", sourceId: "domain-rejected", reason: "quote-mismatch" },
      { harvestMode: "audience", sourceId: "audience-rejected", reason: "length-ceiling" },
    ],
    metrics: {
      extracted: { domain: 3, audience: 3 },
      accepted: { domain: 2, audience: 2 },
      retained: { domain: 2, audience: 2 },
      rejected: { domain: 1, audience: 1 },
      quoteRejected: { domain: 1, audience: 0 },
      quoteRejectionRate: { domain: 1 / 3, audience: 0 },
    },
  },
  armA: {
    arm: "A",
    problems: [{
      id: "problem-a",
      statement: "Reimbursement claims require duplicated work",
      whyItPersists: "Marketplaces operate separate claim systems.",
      affected: "Independent sellers",
      scaleEstimate: "Repeated across multiple marketplaces",
      scaleBasisFactorId: domainFactor.id,
      factorIds: [domainFactor.id, audienceFactor.id],
      verdict: "confirmed",
      verdictReason: "Contrary evidence did not show a complete solution.",
      verdictSourceIds: [killSource.id],
      factors: [domainFactor, audienceFactor],
      sourceHostnames: ["rules.example.com", "forum.example.com"],
      singleHarvestModeWarning: false,
    }],
    blockedCandidates: [{
      statement: "A candidate supported by one site",
      reason: "Corpus diversity failed: cited factors span 1 source hostname(s); 2 required.",
    }],
    killSources: [killSource],
    factorUtilizationRate: 0.5,
  },
  armC: {
    arm: "C",
    problems: [{
      id: "problem-c",
      statement: "Seller workflows contain administrative friction",
      whyItPersists: "The control inferred this from scope alone.",
      affected: "Independent sellers",
      scaleEstimate: "Unknown",
      scaleBasisFactorId: null,
      factorIds: [],
      verdict: "insufficient-evidence",
      verdictReason: "The scope-only control has no factor evidence.",
      verdictSourceIds: [killSource.id],
      factors: [],
      sourceHostnames: [],
      singleHarvestModeWarning: false,
    }],
    blockedCandidates: [],
    killSources: [killSource],
    factorUtilizationRate: 0,
  },
};

describe("Phase 1 discovery Markdown", () => {
  test("renders paired Arm A/C artifacts for manual judgment", () => {
    const artifacts = renderPhase1AblationMarkdown(result);

    expect(artifacts.armA).toContain("# Phase 1 ablation — Arm A");
    expect(artifacts.armC).toContain("# Phase 1 ablation — Arm C");
    for (const markdown of [artifacts.armA, artifacts.armC]) {
      expect(markdown).toContain("Marketplace reimbursement");
      expect(markdown).toContain("Arm overlap is a human product judgment");
      expect(markdown).toContain("No overlap score, string-similarity score, or model grader is used.");
      expect(markdown).toContain("Quote verification by harvest mode");
      expect(markdown).toContain("`quote-mismatch`: 1 (`domain-rejected`)");
      expect(markdown).toContain("`length-ceiling`: 1 (`audience-rejected`)");
    }
    expect(artifacts.armA).not.toContain("Overlap score:");
    expect(artifacts.armC).toContain("scope-only control");
  });

  test("renders problem evidence, factors, metrics, and blocked candidates", () => {
    const markdown = renderDiscoveryArmMarkdown(result, result.armA);

    expect(markdown).toContain("**Statement:** Reimbursement claims require duplicated work");
    expect(markdown).toContain("**Verdict:** `confirmed`");
    expect(markdown).toContain("**Verdict reason:** Contrary evidence did not show a complete solution.");
    expect(markdown).toContain("**Source URL:** <https://rules.example.com/original/domain-1>");
    expect(markdown).toContain("> Sellers must submit the same invoice in both portals.");
    expect(markdown).toContain("#### Factor list");
    expect(markdown).toContain("**Store owners** — repeat claims after silent denials");
    expect(markdown).toContain("**Factor utilization:** 50.0%");
    expect(markdown).toContain("| Domain | 3 | 2 | 2 | 1 | 1 | 33.3% |");
    expect(markdown).toContain("## Blocked candidates");
    expect(markdown).toContain("A candidate supported by one site");
    expect(markdown).toContain("Corpus diversity failed");
    expect(markdown).toContain("<https://counter.example.com/original/kill-1>");
  });

  test("labels an omitted audience rather than leaving the field blank", () => {
    // The audience is optional now, so a blank one must read as a deliberate "None" in the artifact
    // instead of a dangling label a reader would mistake for a rendering bug.
    const markdown = renderDiscoveryArmMarkdown({ ...result, scope: { ...result.scope, audience: "" } }, result.armA);

    expect(markdown).toContain("- **Audience:** None");
  });

  test("makes missing factor evidence explicit in the control arm", () => {
    const markdown = renderDiscoveryArmMarkdown(result, result.armC);

    expect(markdown).toContain("None — this problem has no harvested-factor evidence.");
    expect(markdown).toContain("None (scope-only control).");
    expect(markdown).toContain("**Factor utilization:** 0.0%");
    expect(markdown).toContain("## Blocked candidates\n\nNone.");
  });
});
