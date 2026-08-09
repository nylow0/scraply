import type {
  DevelopedMitigation,
  DevelopedRisk,
  DevelopedSolution,
  DevelopmentResult,
} from "./development";

export function renderDevelopmentMarkdown(result: DevelopmentResult): string {
  const sections = [
    `# ${result.scope.title} — Developed idea chain`,
    renderProblem(result),
    renderFactors(result),
    ...result.solutions.map((solution, index) => renderSolution(solution, index)),
    `## Run measurement\n\n- Model calls: ${result.modelCalls}\n- Solutions: ${result.solutions.length}`,
  ];
  return `${sections.join("\n\n")}\n`;
}

function renderProblem(result: DevelopmentResult): string {
  const problem = result.problem;
  return [
    "## Problem",
    problem.statement,
    `- **Affected:** ${problem.affected}`,
    `- **Why it persists:** ${problem.whyItPersists}`,
    `- **Scale:** ${problem.scaleEstimate}`,
    `- **Verdict:** ${problem.verdict} — ${problem.verdictReason}`,
  ].join("\n\n");
}

function renderFactors(result: DevelopmentResult): string {
  if (result.factors.length === 0) return "## Factors\n\nNone (user-stated or factor-optional problem).";
  return [
    "## Factors",
    ...result.factors.map((factor) => [
      `- **${factor.subject}** ${factor.behavior}`,
      `  - Quote: “${factor.quote}”`,
      `  - Source: ${factor.sourceId} · harvest: ${factor.harvestMode} · model confidence: ${factor.modelConfidence}`,
    ].join("\n")),
  ].join("\n");
}

function renderSolution(solution: DevelopedSolution, index: number): string {
  const offLimits = solution.respectsOffLimits ? "respects" : "may violate";
  return [
    `## Idea ${index + 1}: ${solution.mechanism}`,
    solution.description,
    `**Off-limits self-check:** ${offLimits} — ${solution.respectsOffLimitsWhy}`,
    renderOutcomes(solution),
    renderRisks(solution),
    renderMitigations(solution),
    renderRiskSummary(solution),
  ].join("\n\n");
}

function renderOutcomes(solution: DevelopedSolution): string {
  return [
    "### Outcomes",
    ...solution.outcomes.map((outcome) => {
      const core = outcome.addressesCore ? "addresses core" : "does not independently address core";
      return `- **${outcome.direction}** — ${outcome.description} (${outcome.affects}; ${core})`;
    }),
  ].join("\n");
}

function renderRisks(solution: DevelopedSolution): string {
  if (solution.risks.length === 0) return "### Risks\n\nNo risks were returned.";
  const mitigationsByRisk = linkMitigations(solution.mitigations);
  return [
    "### Risks",
    ...solution.risks.map((risk) => {
      const linked = mitigationsByRisk.get(risk.id) ?? [];
      const catastrophic = risk.impact === "project ends" && linked.length === 0
        ? " **[unaddressed catastrophic risk]**"
        : "";
      const mitigationLines = linked.map((mitigation) =>
        `  - Proposed response: ${mitigation.approach} | Cost: ${mitigation.cost} | Fails if: ${mitigation.failsIf}`
      );
      return [`- **${risk.likelihood} × ${risk.impact}** — ${risk.description}${catastrophic}`, ...mitigationLines].join("\n");
    }),
  ].join("\n");
}

function renderMitigations(solution: DevelopedSolution): string {
  if (solution.mitigations.length === 0) return "### Proposed mitigations\n\nNone proposed.";
  return [
    "### Proposed mitigations",
    ...solution.mitigations.map((mitigation) =>
      `- ${mitigation.approach} (risks: ${mitigation.riskIds.join(", ")}; cost: ${mitigation.cost}; fails if: ${mitigation.failsIf})`
    ),
  ].join("\n");
}

function renderRiskSummary(solution: DevelopedSolution): string {
  const catastrophic = solution.risks.filter((risk) => risk.impact === "project ends");
  const linkedRiskIds = new Set(solution.mitigations.flatMap((mitigation) => mitigation.riskIds));
  const unaddressed = catastrophic.filter((risk) => !linkedRiskIds.has(risk.id));
  return [
    "### Risk summary",
    `- Highest single cell: ${highestRiskCell(solution.risks) ?? "none"}`,
    `- Total risks: ${solution.risks.length}`,
    `- Project-ends risks: ${catastrophic.length}`,
    `- Unaddressed catastrophic risks: ${unaddressed.length}`,
    `- Proposed mitigations: ${solution.mitigations.length}`,
  ].join("\n");
}

function linkMitigations(mitigations: DevelopedMitigation[]): Map<string, DevelopedMitigation[]> {
  const links = new Map<string, DevelopedMitigation[]>();
  for (const mitigation of mitigations) {
    for (const riskId of mitigation.riskIds) links.set(riskId, [...(links.get(riskId) ?? []), mitigation]);
  }
  return links;
}

export function highestRiskCell(risks: DevelopedRisk[]): string | null {
  const highest = [...risks].sort((left, right) => right.sortKey - left.sortKey)[0];
  return highest ? `${highest.likelihood} × ${highest.impact}` : null;
}
