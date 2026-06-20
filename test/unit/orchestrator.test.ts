import { describe, expect, test } from "bun:test";
import { renderSynthesisReportHtml } from "../../src/core/orchestrator";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import type { ProjectBrief } from "../../src/shared/schemas";

const brief: ProjectBrief = {
  projectName: "Widget Studio",
  theme: "Widgets",
  description: "Explore widget opportunities",
  desiredOutput: "Actionable ideas",
  successDefinition: "Clear next steps",
  constraints: [],
  resources: [],
  avoidList: [],
  researchNeeds: "Landscape and gaps",
  finalDecision: "Choose direction",
  deadline: "Q3",
  availableEffort: "Medium",
  ideaStylePreference: "Balanced",
};

describe("orchestrator synthesis report", () => {
  test("renders composite HTML from coverage review and synthesis output", () => {
    const html = renderSynthesisReportHtml(
      brief,
      DEFAULT_RUN_CONFIG,
      [{
        streamId: "landscape",
        streamName: "Landscape",
        status: "completed",
        coverage: 0.82,
        reportHtml: "<p>Market is fragmented.</p>",
      }],
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
});
