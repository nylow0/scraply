import { describe, expect, test } from "bun:test";
import { reviewCoverage, renderSynthesisReportHtml, synthesizeResearch } from "../../src/core/orchestrator";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import { DEFAULT_RESEARCHERS, type ProjectBrief } from "../../src/shared/schemas";
import type { OpenCodeClient } from "../../src/providers/opencode";

const brief: ProjectBrief = {
  projectName: "Widget Studio",
  goal: "Find widget product ideas",
  theme: "Widgets",
  description: "Explore widget opportunities",
  successDefinition: "Clear next steps",
  desiredOutput: "Actionable ideas",
  successDecider: "Founder",
  motivation: "Grow revenue",
  constraints: [],
  resources: [],
  avoidList: [],
  researchNeeds: "Landscape and gaps",
  finalDecision: "Choose direction",
  deadline: "Q3",
  availableEffort: "Medium",
  ideaStylePreference: "Balanced",
  examples: "",
  scoringCriteria: "",
  anythingElse: "",
};

const streamReport = {
  streamId: "landscape",
  streamName: "Landscape",
  status: "completed",
  coverage: 0.82,
  reportHtml: "<p>Market is fragmented.</p>",
};

describe("orchestrator synthesis report", () => {
  test("renders composite HTML from coverage review and synthesis output", () => {
    const html = renderSynthesisReportHtml(
      brief,
      DEFAULT_RUN_CONFIG,
      [streamReport],
      {
        overallCoverage: 0.82,
        summary: "Evidence is strong enough to proceed.",
        streamReviews: [{
          streamId: "landscape",
          coverage: 0.82,
          gaps: ["Pricing benchmarks"],
          needsFollowUp: false,
        }],
      },
      {
        summary: "Widgets remain underserved in small-team workflows.",
        keyThemes: ["Workflow friction", "Integration gaps"],
        opportunities: ["Vertical-specific bundles"],
        risks: ["Crowded incumbents"],
        recommendedNextSteps: ["Validate with 5 user interviews"],
      },
    );

    expect(html).toContain("Widget Studio — Research synthesis");
    expect(html).toContain("Executive summary");
    expect(html).toContain("Workflow friction");
    expect(html).toContain("Pricing benchmarks");
  });

  test("reviewCoverage rejects empty stream reports", async () => {
    const client = { structuredCompletion: async () => ({}) } as unknown as OpenCodeClient;
    await expect(reviewCoverage(client, "test-model", brief, [], []))
      .rejects.toThrow("No stream reports available for coverage review");
  });

  test("reviewCoverage forwards brief and stream evidence to structured completion", async () => {
    let capturedUser = "";
    const client = {
      structuredCompletion: async (_model: string, _system: string, user: string) => {
        capturedUser = user;
        return {
          overallCoverage: 0.75,
          summary: "Solid baseline.",
          streamReviews: [{ streamId: "landscape", coverage: 0.75, gaps: ["Pricing"], needsFollowUp: true }],
        };
      },
    } as unknown as OpenCodeClient;

    const review = await reviewCoverage(client, "glm-5.2", brief, [streamReport], [DEFAULT_RESEARCHERS[0]!]);
    expect(review.overallCoverage).toBe(0.75);
    expect(capturedUser).toContain("Widget Studio");
    expect(capturedUser).toContain("Market is fragmented.");
  });

  test("synthesizeResearch returns structured narrative output", async () => {
    const client = {
      structuredCompletion: async () => ({
        summary: "Widgets show promise.",
        keyThemes: ["Workflow friction"],
        opportunities: ["Vertical bundles"],
        risks: ["Incumbents"],
        recommendedNextSteps: ["Interview users"],
      }),
    } as unknown as OpenCodeClient;

    const synthesis = await synthesizeResearch(
      client,
      "glm-5.2",
      brief,
      [streamReport],
      {
        overallCoverage: 0.82,
        summary: "Enough evidence.",
        streamReviews: [{ streamId: "landscape", coverage: 0.82, gaps: [], needsFollowUp: false }],
      },
    );

    expect(synthesis.keyThemes).toContain("Workflow friction");
    expect(synthesis.recommendedNextSteps).toContain("Interview users");
  });
});
