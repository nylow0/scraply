import type { Ledger } from "./ledger";

type ProjectExport = ReturnType<Ledger["exportProject"]>;

const retractedMark = (item: { retracted?: string }) => item.retracted ? ` (retracted: ${item.retracted})` : "";
const block = (text: string) => text.split(/\r?\n/).map(line => `> ${line}`).join("\n");

/**
 * A readable Markdown report of a whole project: ideas with the status of every claim they rest on,
 * then each claim with its tests, verdicts, the quotes they cite, and their reviews, then every
 * search and source, including the ones that failed. Built from `exportProject`, so it never says
 * more than the JSON export does.
 */
export function renderReport(project: ProjectExport): string {
  const quotes = new Map(project.quotes.map(quote => [quote.id, quote]));
  const sources = new Map(project.sources.map(source => [source.id, source]));
  const lines = [`# ${project.project.name}`, "", `**Seed:** ${project.project.seed}`, "", `Exported ${project.exportedAt}.`, ""];

  if (project.notes.length) {
    lines.push("## Notes", "");
    for (const note of project.notes) lines.push(`- **${note.id}** ${note.kind}: ${note.text}${note.quotes ? ` (${note.quotes.join(", ")})` : ""}${retractedMark(note)}`);
    lines.push("");
  }

  lines.push("## Ideas", "");
  if (!project.ideas.length) lines.push("No ideas saved.", "");
  for (const idea of project.ideas) {
    lines.push(`### ${idea.id}: ${idea.title} (${idea.status})${retractedMark(idea)}`, "", idea.pitch, "");
    if (idea.revises) lines.push(`Revises ${idea.revises}.`, "");
    for (const claim of idea.claims) lines.push(`- ${claim.id}: ${claim.status} now, ${claim.statusWhenSaved} when saved`);
    lines.push("");
  }

  lines.push("## Claims", "");
  if (!project.claims.length) lines.push("No claims saved.", "");
  for (const claim of project.claims) {
    lines.push(`### ${claim.id} (${claim.kind}): ${claim.status}${retractedMark(claim)}`, "", claim.statement, "", `**Kill if:** ${claim.killIf}`, "");
    for (const test of claim.tests) {
      lines.push(`- **${test.id}** (${test.kind}), written ${test.predictedAt}${retractedMark(test)}`, `  - Method: ${test.method}`, `  - Prediction: ${test.prediction}`, `  - Stops when: ${test.stopWhen}`);
      if (test.kind === "experiment") lines.push(`  - Sanity check: ${test.sanity}`, `  - Control: ${test.control}`, `  - Held out: ${test.holdout}`);
    }
    if (claim.tests.length) lines.push("");
    for (const verdict of claim.verdicts) {
      const tested = verdict.test ? `, answers ${verdict.test} with ${verdict.quotesNewSincePrediction} quote(s) new since the prediction` : "";
      lines.push(`#### ${verdict.id}: ${verdict.result} by ${verdict.by}, ${verdict.decidedAt}${tested}${verdict.stale ? " (stale: cites retracted evidence)" : ""}`, "", verdict.note, "");
      for (const id of verdict.quotes) {
        const quote = quotes.get(id);
        const source = quote ? sources.get(quote.source) : undefined;
        if (!quote) continue;
        lines.push(block(quote.text), `> — ${quote.speaker} (${quote.kind}), ${quote.id} from [${source?.title ?? source?.url ?? quote.source}](${source?.url ?? ""})${retractedMark(quote)}`, "");
      }
      for (const review of verdict.reviews) lines.push(`- Review ${review.id}: **${review.result}** by ${review.by}. ${review.note}`);
      if (verdict.reviews.length) lines.push("");
      else if (verdict.result !== "unclear") lines.push("- Not reviewed yet.", "");
    }
  }

  lines.push("## Searches", "");
  if (!project.searches.length) lines.push("No searches.", "");
  for (const search of project.searches) lines.push(`- ${search.id} ${search.provider}: ${search.query} (${search.status}${search.error ? `: ${search.error}` : ""})`);
  lines.push("", "## Sources", "");
  for (const source of project.sources) {
    const state = source.status === "ok" ? `${source.chars} chars${source.truncated ? ", truncated" : ""}` : `failed: ${source.error}`;
    lines.push(source.command
      ? `- ${source.id} run of ${source.test}: \`${source.command}\`, exit code ${source.exitCode}, ${state}`
      : `- ${source.id} [${source.title ?? source.url}](${source.url}), ${source.kind} via ${source.via}, ${state}`);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
