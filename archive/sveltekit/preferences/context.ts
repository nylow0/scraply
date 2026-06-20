import type { KnowledgeStore, StoredIdea } from "../store/schema";

export interface PreferenceExample {
  title: string;
  description: string;
  bucket: StoredIdea["bucket"];
  rating: number;
  scores: StoredIdea["scores"];
}

export interface PreferenceContext {
  ratedCount: number;
  positiveExamples: PreferenceExample[];
  negativeExamples: PreferenceExample[];
  instructions: string[];
  summary: string;
}

const toExample = (idea: StoredIdea): PreferenceExample => ({
  title: idea.title,
  description: idea.description,
  bucket: idea.bucket,
  rating: idea.rating ?? 0,
  scores: idea.scores,
});

function strongest(ideas: StoredIdea[], direction: "high" | "low"): PreferenceExample[] {
  return ideas
    .filter((idea) => idea.rating !== null)
    .sort((left, right) => direction === "high"
      ? (right.rating ?? 0) - (left.rating ?? 0)
      : (left.rating ?? 0) - (right.rating ?? 0))
    .slice(0, 4)
    .map(toExample);
}

export function buildPreferenceContext(store: KnowledgeStore): PreferenceContext {
  const rated = store.ideas.filter((idea) => idea.rating !== null);
  const positive = rated.filter((idea) => (idea.rating ?? 0) >= 0.8);
  const negative = rated.filter((idea) => (idea.rating ?? 0) <= 0.4);
  const positiveExamples = strongest(positive, "high");
  const negativeExamples = strongest(negative, "low");
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
    instructions.push("Use ratings as a creative prior, not a score override: preserve the four independent axes and supporting-claim requirements.");
  }

  const summary = rated.length === 0
    ? "No preference history yet. Generate from the active branch evidence without guessing user taste."
    : `${rated.length} rated idea${rated.length === 1 ? "" : "s"}; ${positive.length} strong positive and ${negative.length} clear negative signal${negative.length === 1 ? "" : "s"}.`;

  return { ratedCount: rated.length, positiveExamples, negativeExamples, instructions, summary };
}
