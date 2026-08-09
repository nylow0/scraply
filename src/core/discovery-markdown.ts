import type {
  DiscoveryArmResult,
  DiscoveryProblem,
  FactorRejection,
  HarvestedSource,
  HarvestMode,
  Phase1AblationResult,
} from "./discovery";

export interface Phase1MarkdownArtifacts {
  armA: string;
  armC: string;
}

export function renderPhase1AblationMarkdown(result: Phase1AblationResult): Phase1MarkdownArtifacts {
  return {
    armA: renderDiscoveryArmMarkdown(result, result.armA),
    armC: renderDiscoveryArmMarkdown(result, result.armC),
  };
}

export function renderDiscoveryArmMarkdown(
  result: Phase1AblationResult,
  arm: DiscoveryArmResult,
): string {
  const controlNote = arm.arm === "C"
    ? "Arm C is the scope-only control. It receives no harvested factors."
    : "Arm A evaluates the harvested factor pool.";
  // A verdict may cite a harvest source that the kill search rediscovered, so both pools resolve here.
  const sourcesById = new Map(
    [...result.harvest.sources, ...arm.killSources].map((source) => [source.id, source]),
  );
  const sections = [
    `# Phase 1 ablation — Arm ${arm.arm}`,
    controlNote,
    "> Arm overlap is a human product judgment. No overlap score, string-similarity score, or model grader is used.",
    renderScope(result),
    renderMetrics(result, arm),
    renderProblems(arm, sourcesById),
    renderBlockedCandidates(arm),
  ];

  return `${sections.join("\n\n")}\n`;
}

function renderScope(result: Phase1AblationResult): string {
  const { scope } = result;
  const offLimits = scope.offLimits.length > 0
    ? scope.offLimits.map((item) => `  - ${inline(item)}`).join("\n")
    : "  - None";

  return [
    "## Scope",
    `- **Title:** ${inline(scope.title)}`,
    `- **Audience:** ${inline(scope.audience)}`,
    `- **Domain:** ${inline(scope.domain)}`,
    `- **Observations:** ${inline(scope.observations) || "None"}`,
    "- **Off limits:**",
    offLimits,
  ].join("\n");
}

function renderMetrics(result: Phase1AblationResult, arm: DiscoveryArmResult): string {
  const modes: HarvestMode[] = ["domain", "audience"];
  const rows = modes.map((mode) => {
    const metrics = result.harvest.metrics;
    return `| ${capitalize(mode)} | ${metrics.extracted[mode]} | ${metrics.accepted[mode]} | ${metrics.retained[mode]} | ${metrics.rejected[mode]} | ${metrics.quoteRejected[mode]} | ${percent(metrics.quoteRejectionRate[mode])} |`;
  });
  const rejectionDetails = modes.map((mode) => renderRejectionReasons(mode, result.harvest.rejections));

  return [
    "## Metrics",
    `- **Factor utilization:** ${percent(arm.factorUtilizationRate)}`,
    "",
    "### Quote verification by harvest mode",
    "| Mode | Extracted | Accepted | Retained after cap | All rejections | Quote rejections | Quote rejection rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "### Rejection reasons",
    ...rejectionDetails,
  ].join("\n");
}

function renderRejectionReasons(mode: HarvestMode, rejections: FactorRejection[]): string {
  const matching = rejections.filter((rejection) => rejection.harvestMode === mode);
  if (matching.length === 0) return `- **${capitalize(mode)}:** None`;

  const byReason = new Map<FactorRejection["reason"], string[]>();
  for (const rejection of matching) {
    const sourceIds = byReason.get(rejection.reason) ?? [];
    sourceIds.push(rejection.sourceId);
    byReason.set(rejection.reason, sourceIds);
  }
  const details = [...byReason.entries()].map(([reason, sourceIds]) =>
    `  - \`${reason}\`: ${sourceIds.length} (${sourceIds.map((id) => `\`${inline(id)}\``).join(", ")})`
  );
  return [`- **${capitalize(mode)}:**`, ...details].join("\n");
}

function renderProblems(arm: DiscoveryArmResult, sourcesById: Map<string, HarvestedSource>): string {
  if (arm.problems.length === 0) return "## Problems\n\nNo problems survived the gate.";
  return [
    "## Problems",
    ...arm.problems.map((problem, index) => renderProblem(problem, sourcesById, index)),
  ].join("\n\n");
}

function renderProblem(
  problem: DiscoveryProblem,
  sourcesById: Map<string, HarvestedSource>,
  index: number,
): string {
  const warning = problem.singleHarvestModeWarning
    ? "- **Warning:** Cited factors come from only one harvest mode."
    : "- **Harvest-mode warning:** None";
  const verdictSources = problem.verdictSourceIds.map((sourceId) => {
    const source = sourcesById.get(sourceId);
    return source ? `  - <${source.url}>` : `  - Unknown source \`${inline(sourceId)}\``;
  });

  return [
    `### Problem ${index + 1}`,
    `- **Statement:** ${inline(problem.statement)}`,
    `- **Verdict:** \`${problem.verdict}\``,
    `- **Verdict reason:** ${inline(problem.verdictReason)}`,
    `- **Why it persists:** ${inline(problem.whyItPersists)}`,
    `- **Affected:** ${inline(problem.affected)}`,
    `- **Scale estimate:** ${inline(problem.scaleEstimate)}`,
    `- **Source hostnames:** ${problem.sourceHostnames.length > 0 ? problem.sourceHostnames.map((hostname) => `\`${inline(hostname)}\``).join(", ") : "None (scope-only control)"}`,
    warning,
    "",
    "#### Verdict sources",
    ...(verdictSources.length > 0 ? verdictSources : ["- None cited"]),
    "",
    renderEvidenceTuples(problem),
    "",
    renderFactors(problem),
  ].join("\n");
}

function renderEvidenceTuples(problem: DiscoveryProblem): string {
  if (problem.factors.length === 0) {
    return "#### Verified evidence tuples\n\nNone — this problem has no harvested-factor evidence.";
  }
  const tuples = problem.factors.flatMap((factor, index) => [
    `${index + 1}. **Source URL:** <${factor.source.url}>`,
    "   **Quote (verbatim-verified):**",
    indentQuote(factor.quote, "   "),
  ]);
  return ["#### Verified evidence tuples", ...tuples].join("\n");
}

function renderFactors(problem: DiscoveryProblem): string {
  if (problem.factors.length === 0) return "#### Factor list\n\nNone (scope-only control).";
  const factors = problem.factors.flatMap((factor, index) => [
    `${index + 1}. **${inline(factor.subject)}** — ${inline(factor.behavior)}`,
    `   - Harvest mode: \`${factor.harvestMode}\``,
    `   - Source URL: <${factor.source.url}>`,
    "   - Quote:",
    indentQuote(factor.quote, "     "),
  ]);
  return ["#### Factor list", ...factors].join("\n");
}

function renderBlockedCandidates(arm: DiscoveryArmResult): string {
  if (arm.blockedCandidates.length === 0) return "## Blocked candidates\n\nNone.";
  const candidates = arm.blockedCandidates.flatMap((candidate, index) => [
    `${index + 1}. **${inline(candidate.statement)}**`,
    `   - Reason: ${inline(candidate.reason)}`,
  ]);
  return ["## Blocked candidates", ...candidates].join("\n");
}

function percent(value: number): string {
  return `${(Number.isFinite(value) ? value * 100 : 0).toFixed(1)}%`;
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([\\|])/g, "\\$1");
}

function indentQuote(value: string, indent: string): string {
  return value.trim().split(/\r?\n/).map((line) => `${indent}> ${line}`).join("\n");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
