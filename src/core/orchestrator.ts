import { z } from "zod";
import type { OpenCodeClient } from "../providers/opencode";
import { wrapReportHtml } from "./sanitize";
import { RESEARCH_STREAMS } from "../research/streams";
import type { ProjectBrief, RunConfig } from "../shared/schemas";

export const StreamCoverageReviewSchema = z.object({
  streamId: z.string().min(1),
  coverage: z.number().min(0).max(1),
  gaps: z.array(z.string()),
  needsFollowUp: z.boolean(),
});

export const CoverageReviewSchema = z.object({
  overallCoverage: z.number().min(0).max(1),
  streamReviews: z.array(StreamCoverageReviewSchema).min(1),
  summary: z.string().min(1),
});

export const SynthesisOutputSchema = z.object({
  summary: z.string().min(1),
  keyThemes: z.array(z.string()).min(1),
  opportunities: z.array(z.string()),
  risks: z.array(z.string()),
  recommendedNextSteps: z.array(z.string()),
});

export type CoverageReview = z.infer<typeof CoverageReviewSchema>;
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

export interface StreamReportSummary {
  streamId: string;
  streamName: string;
  status: string;
  coverage: number;
  reportHtml: string;
  error?: string;
}

const coverageJsonSchema = {
  type: "object",
  properties: {
    overallCoverage: { type: "number" },
    summary: { type: "string" },
    streamReviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          streamId: { type: "string" },
          coverage: { type: "number" },
          gaps: { type: "array", items: { type: "string" } },
          needsFollowUp: { type: "boolean" },
        },
        required: ["streamId", "coverage", "gaps", "needsFollowUp"],
      },
    },
  },
  required: ["overallCoverage", "streamReviews", "summary"],
} as const;

const synthesisJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keyThemes: { type: "array", items: { type: "string" } },
    opportunities: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    recommendedNextSteps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "keyThemes", "opportunities", "risks", "recommendedNextSteps"],
} as const;

export async function reviewCoverage(
  client: OpenCodeClient,
  model: string,
  brief: ProjectBrief,
  streamReports: StreamReportSummary[],
): Promise<CoverageReview> {
  const rubric = RESEARCH_STREAMS.map((stream) => `- ${stream.id}: ${stream.focus}`).join("\n");
  const evidence = streamReports.map((report) => [
    `Stream: ${report.streamName} (${report.streamId})`,
    `Status: ${report.status}`,
    `Recorded coverage: ${Math.round(report.coverage * 100)}%`,
    report.error ? `Error: ${report.error}` : "",
    `Report excerpt: ${stripHtml(report.reportHtml).slice(0, 1200)}`,
  ].filter(Boolean).join("\n")).join("\n\n");

  return client.structuredCompletion(
    model,
    "Assess evidence coverage against the brief using an explicit rubric. Return calibrated coverage from 0 to 1, explicit gaps, and whether each stream needs follow-up research. Do not generate final ideas.",
    [
      `Project: ${brief.projectName}`,
      `Theme: ${brief.theme}`,
      `Description: ${brief.description}`,
      `Research needs: ${brief.researchNeeds}`,
      "",
      "Coverage rubric:",
      rubric,
      "",
      "Stream reports:",
      evidence,
    ].join("\n"),
    CoverageReviewSchema,
    coverageJsonSchema,
  );
}

export async function synthesizeResearch(
  client: OpenCodeClient,
  model: string,
  brief: ProjectBrief,
  streamReports: StreamReportSummary[],
  coverageReview: CoverageReview,
): Promise<SynthesisOutput> {
  const evidence = streamReports.map((report) =>
    `${report.streamName}: ${Math.round(report.coverage * 100)}% coverage — ${stripHtml(report.reportHtml).slice(0, 800)}`,
  ).join("\n\n");

  return client.structuredCompletion(
    model,
    "Synthesize cross-stream research into a coherent narrative. Highlight convergent themes, actionable opportunities, risks, and next steps grounded in the evidence.",
    [
      `Project: ${brief.projectName}`,
      `Theme: ${brief.theme}`,
      `Overall coverage: ${Math.round(coverageReview.overallCoverage * 100)}%`,
      `Coverage summary: ${coverageReview.summary}`,
      "",
      "Stream evidence:",
      evidence,
    ].join("\n"),
    SynthesisOutputSchema,
    synthesisJsonSchema,
  );
}

export function renderSynthesisReportHtml(
  brief: ProjectBrief,
  config: RunConfig,
  streamReports: StreamReportSummary[],
  coverageReview: CoverageReview,
  synthesis: SynthesisOutput,
): string {
  const streamRows = streamReports.map((report) => {
    const review = coverageReview.streamReviews.find((item) => item.streamId === report.streamId);
    const gaps = review?.gaps.length ? `<ul>${review.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul>` : "<p>None noted.</p>";
    return `
      <section>
        <h2>${escapeHtml(report.streamName)}</h2>
        <p><strong>Status:</strong> ${escapeHtml(report.status)} · <strong>Coverage:</strong> ${Math.round(report.coverage * 100)}%</p>
        ${report.error ? `<p><strong>Error:</strong> ${escapeHtml(report.error)}</p>` : ""}
        <h3>Gaps</h3>${gaps}
      </section>
    `;
  }).join("");

  const list = (items: string[]) => items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>None noted.</p>";

  const body = `
    <h2>Executive summary</h2>
    <p>${escapeHtml(synthesis.summary)}</p>
    <h2>Coverage review</h2>
    <p>${escapeHtml(coverageReview.summary)}</p>
    <p><strong>Overall coverage:</strong> ${Math.round(coverageReview.overallCoverage * 100)}%</p>
    <h2>Key themes</h2>
    ${list(synthesis.keyThemes)}
    <h2>Opportunities</h2>
    ${list(synthesis.opportunities)}
    <h2>Risks and uncertainty</h2>
    ${list(synthesis.risks)}
    <h2>Recommended next steps</h2>
    ${list(synthesis.recommendedNextSteps)}
    <h2>Stream breakdown</h2>
    ${streamRows}
    <h2>Run configuration</h2>
    <p>Orchestrator: ${escapeHtml(config.orchestratorModel)} · Worker: ${escapeHtml(config.workerModel)}</p>
  `;

  return wrapReportHtml(`${brief.projectName} — Research synthesis`, body);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
