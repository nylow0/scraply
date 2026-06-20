import type { DatabaseClient } from "../db/client";
import type { Idea } from "../shared/schemas";

export interface PreferenceExample {
  title: string;
  description: string;
  bucket: Idea["bucket"];
  rating: number;
  scores: Idea["scores"];
}

export interface PreferenceContext {
  ratedCount: number;
  positiveExamples: PreferenceExample[];
  negativeExamples: PreferenceExample[];
  instructions: string[];
  summary: string;
}

interface RatedIdeaRow {
  title: string;
  description: string;
  bucket: Idea["bucket"];
  scores_json: string;
  rating: number;
}

export function buildPreferenceContext(db: DatabaseClient): PreferenceContext {
  const rows = db.db.prepare(`
    SELECT i.title, i.description, i.bucket, i.scores_json, r.rating
    FROM ratings r
    JOIN ideas i ON i.id = r.idea_id
    ORDER BY r.created_at DESC
  `).all() as RatedIdeaRow[];

  const latestByTitle = new Map<string, RatedIdeaRow>();
  for (const row of rows) {
    const key = row.title.toLowerCase();
    if (!latestByTitle.has(key)) latestByTitle.set(key, row);
  }
  const rated = [...latestByTitle.values()].map((row) => ({
    title: row.title,
    description: row.description,
    bucket: row.bucket,
    rating: row.rating / 5,
    scores: JSON.parse(row.scores_json) as Idea["scores"],
  }));

  const positive = rated.filter((idea) => idea.rating >= 0.8);
  const negative = rated.filter((idea) => idea.rating <= 0.4);
  const positiveExamples = strongest(rated, "high");
  const negativeExamples = strongest(rated, "low");
  const instructions: string[] = [];

  if (positiveExamples.length > 0) {
    instructions.push("Use the highly rated examples as few-shot signals for specificity, scope, and opportunity shape; do not copy their wording or premise.");
  }
  if (negativeExamples.length > 0) {
    instructions.push("Avoid the structural traits of the low-rated examples unless current evidence strongly justifies them; never merely negate or rephrase them.");
  }
  if (rated.length < 3) {
    instructions.push("Treat the preference signal as weak because fewer than three ideas have been rated; research evidence remains the primary constraint.");
  } else {
    instructions.push("Use ratings as a creative prior, not a score override: preserve the independent score axes.");
  }

  const summary = rated.length === 0
    ? "No preference history yet. Generate from the active branch evidence without guessing user taste."
    : `${rated.length} rated idea${rated.length === 1 ? "" : "s"}; ${positive.length} strong positive and ${negative.length} clear negative signal${negative.length === 1 ? "" : "s"}.`;

  return { ratedCount: rated.length, positiveExamples, negativeExamples, instructions, summary };
}

export function formatPreferencePrompt(context: PreferenceContext): string {
  if (context.ratedCount === 0) return context.summary;
  const lines = [context.summary, ...context.instructions];
  if (context.positiveExamples.length > 0) {
    lines.push("Highly rated examples:");
    for (const example of context.positiveExamples) {
      lines.push(`- ${example.title}: ${example.description} (${Math.round(example.rating * 5)}/5)`);
    }
  }
  if (context.negativeExamples.length > 0) {
    lines.push("Low-rated examples to avoid resembling:");
    for (const example of context.negativeExamples) {
      lines.push(`- ${example.title}: ${example.description} (${Math.round(example.rating * 5)}/5)`);
    }
  }
  return lines.join("\n");
}

function strongest(examples: PreferenceExample[], direction: "high" | "low"): PreferenceExample[] {
  return [...examples]
    .sort((left, right) => direction === "high" ? right.rating - left.rating : left.rating - right.rating)
    .slice(0, 4);
}
