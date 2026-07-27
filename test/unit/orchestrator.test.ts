import { describe, expect, test } from "bun:test";
import {
  renderSynthesisReportHtml,
  reviewCoverage,
  synthesizeResearch,
} from "../../src/core/orchestrator";
import type { StructuredModelClient } from "../../src/providers/structured";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import type { ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const brief: ProjectBrief = makeProjectBrief({
  title: "Widget Studio",
  objective: "Widgets",
  context: "Explore widget opportunities",
  desiredOutput: { type: "options", notes: "Actionable ideas" },
  successCriteria: ["Clear next steps"],
  evidenceRequirements: ["Landscape and gaps"],
  decisionToSupport: "Choose direction",
  deadline: "Q3",
  availableEffort: "Medium",
});

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

  test("passes centralized brief context to coverage and synthesis consumers", async () => {
    const userPrompts: string[] = [];
    const responses = [
      {
        overallCoverage: 0.8,
        summary: "Enough evidence",
        streamReviews: [{
          streamId: "landscape",
          coverage: 0.8,
          gaps: [],
          needsFollowUp: false,
        }],
      },
      {
        summary: "A synthesis",
        keyThemes: ["Theme"],
        opportunities: [],
        risks: [],
        recommendedNextSteps: [],
      },
    ];
    const client: StructuredModelClient = {
      async structuredCompletion(_model, _system, user) {
        userPrompts.push(user);
        return responses.shift() as never;
      },
    };
    const consequentialBrief: ProjectBrief = {
      ...brief,
      desiredOutput: { type: "decision-memo", notes: "Decision memo" },
      hardConstraints: ["Must work offline"],
      resources: ["One developer"],
      antiGoals: ["Advertising"],
      decisionToSupport: "Choose the launch segment",
      availableEffort: "Ten hours weekly",
    };
    const reports = [{
      streamId: "landscape",
      streamName: "Landscape",
      status: "completed",
      coverage: 0.8,
      reportHtml: "<p>Evidence</p>",
    }];

    const coverage = await reviewCoverage(client, "test-model", consequentialBrief, reports);
    await synthesizeResearch(client, "test-model", consequentialBrief, reports, coverage);

    expect(userPrompts[0]).toContain("Hard constraints (must satisfy): Must work offline");
    expect(userPrompts[0]).toContain("Decision to support: Choose the launch segment");
    expect(userPrompts[0]).toContain("Explicit exclusions (must not recommend or pursue): Advertising");
    expect(userPrompts[1]).toContain("Desired output/package: Decision memo");
    expect(userPrompts[1]).toContain("Available effort: Ten hours weekly");
  });
});
