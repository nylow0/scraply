import type { KnowledgeStore } from "../store/schema";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function renderNodeReport(store: KnowledgeStore, nodeId: string): string {
  const node = store.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const sources = new Map(store.sources.map((source) => [source.id, source]));
  const claims = store.claims.filter((claim) => claim.nodeId === nodeId);
  const ideas = store.ideas.filter((idea) => idea.nodeId === nodeId);
  const lines = [
    `# ${node.brief.topic}`,
    "",
    node.brief.objective,
    "",
    "## Research run",
    "",
    `- Stream: ${node.stream ? `${node.stream.name} (${node.stream.lens})` : "Six-stream research"}`,
    ...(node.stream ? [`- Focus: ${node.stream.focus}`] : []),
    `- Coverage: ${percent(node.coverage)}`,
    `- Stop reason: ${node.stopReason ?? "in progress"}`,
    `- Budget: $${node.spentUsd.toFixed(2)} spent of $${node.brief.budgetUsd.toFixed(2)}`,
    `- Hops completed: ${node.hopsCompleted}`,
    "",
    "## Grounded claims",
    "",
  ];

  if (claims.length === 0) lines.push("No grounded claims were collected.", "");
  for (const claim of claims) {
    const links = claim.sourceIds.map((id) => {
      const source = sources.get(id);
      return source ? `[${source.title}](${source.url})` : id;
    }).join(", ");
    lines.push(`### ${claim.text}`, "", `Confidence: ${percent(claim.confidence)} · Sources: ${links}`, "");
    for (const evidence of claim.evidence) lines.push(`> ${evidence.quote.replace(/\n/g, " ")}`, "");
  }

  lines.push("## Director-produced ideas", "");
  if (ideas.length === 0) lines.push("No director ideas have been imported yet.", "");
  for (const bucket of ["sweet-spot", "creative-outlier", "safe-bet"] as const) {
    const bucketIdeas = ideas.filter((idea) => idea.bucket === bucket);
    if (bucketIdeas.length === 0) continue;
    lines.push(`### ${bucket}`, "");
    for (const idea of bucketIdeas) {
      const scores = Object.entries(idea.scores).map(([key, value]) => `${key} ${value.toFixed(2)}`).join(" · ");
      lines.push(`- **${idea.title}** — ${idea.description}`, `  ${scores}`);
    }
    lines.push("");
  }

  lines.push("## Sources", "");
  for (const sourceId of node.sourceIds) {
    const source = sources.get(sourceId);
    if (source) lines.push(`- [${source.title}](${source.url})`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderFullResearchReport(store: KnowledgeStore, nodeId: string): string {
  const node = store.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  if (node.streamRuns.length !== 6) throw new Error(`Full research node must contain six stream runs: ${nodeId}`);
  const sources = new Map(store.sources.map((source) => [source.id, source]));
  const claims = store.claims.filter((claim) => claim.nodeId === nodeId);
  const lines = [
    `# ${node.brief.topic}`,
    "",
    node.brief.objective,
    "",
    "## Complete run status",
    "",
    `- Status: ${node.status}`,
    `- Coverage: ${percent(node.coverage)}`,
    `- Budget: $${node.spentUsd.toFixed(2)} spent of $${node.brief.budgetUsd.toFixed(2)}`,
    `- Grounded claims: ${claims.length}`,
    ...(node.synthesisError ? [`- Synthesis warning: ${node.synthesisError}`] : []),
    ...(node.reportError ? [`- Publishing warning: ${node.reportError}`] : []),
    "",
    "## Synthesis",
    "",
    node.synthesis?.summary ?? "Synthesis was unavailable; the stream evidence below is preserved.",
    "",
  ];

  for (const run of node.streamRuns) {
    lines.push(
      `## ${run.stream.name}`,
      "",
      run.stream.instructions ?? run.stream.focus,
      "",
      `- Status: ${run.status}${run.error ? ` — ${run.error}` : ""}`,
      `- Coverage: ${percent(run.coverage)}`,
      `- Stop reason: ${run.stopReason ?? "error"}`,
      `- Budget: $${run.spentUsd.toFixed(2)} spent of $${run.budgetUsd.toFixed(2)}`,
      "",
    );
    const streamClaims = claims.filter((claim) => claim.streamId === run.stream.id);
    if (streamClaims.length === 0) lines.push("No grounded claims were collected.", "");
    for (const claim of streamClaims) {
      const links = claim.sourceIds.map((id) => {
        const source = sources.get(id);
        return source ? `[${source.title}](${source.url})` : id;
      }).join(", ");
      lines.push(`### ${claim.text}`, "", `Claim ID: ${claim.id} · Confidence: ${percent(claim.confidence)} · Sources: ${links}`, "");
      for (const evidence of claim.evidence) lines.push(`> ${evidence.quote.replace(/\n/g, " ")}`, "");
    }
  }

  lines.push("## Sources", "");
  for (const sourceId of node.sourceIds) {
    const source = sources.get(sourceId);
    if (source) lines.push(`- [${source.title}](${source.url})`);
  }
  lines.push("");
  return lines.join("\n");
}
