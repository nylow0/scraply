import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../db/client";
import { buildPreferenceContext, formatPreferencePrompt } from "./preferences";
import type { OpenCodeClient } from "../providers/opencode";
import { IdeaBucketSchema, IdeaSchema, IdeaScoresSchema, type Idea, type ProjectBrief } from "../shared/schemas";

const LENSES = [
  "direct gaps",
  "analogies",
  "combinations",
  "constraint relaxation",
  "inversion",
] as const;

const GeneratedIdeaSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  bucket: IdeaBucketSchema,
  scores: IdeaScoresSchema,
});

const IdeaBatchSchema = z.object({
  ideas: z.array(GeneratedIdeaSchema).min(1),
});

export function buildIdeaPrompt(
  brief: ProjectBrief,
  preferencePrompt: string,
  existing: Array<{ title: string; description: string }>,
  batchSize: number,
  lens: string,
  evidenceContext?: string,
): string {
  return [
    `Project: ${brief.projectName}`,
    brief.goal ? `Generating ideas for: ${brief.goal}` : "",
    `Theme: ${brief.theme}`,
    `Description: ${brief.description}`,
    brief.successDefinition ? `What makes an idea good: ${brief.successDefinition}` : "",
    `Desired output: ${brief.desiredOutput}`,
    brief.motivation ? `Motivation / reward that matters: ${brief.motivation}` : "",
    brief.scoringCriteria ? `Weight these scoring criteria: ${brief.scoringCriteria}` : "",
    brief.examples ? `Examples to take into account: ${brief.examples}` : "",
    brief.constraints.length ? `Hard constraints: ${brief.constraints.join("; ")}` : "",
    brief.resources.length ? `Available resources: ${brief.resources.join("; ")}` : "",
    `Avoid: ${brief.avoidList.join("; ") || "none"}`,
    `Creative lens: ${lens}`,
    `Generate ${batchSize} distinct ideas.`,
    existing.length ? `Avoid duplicating: ${existing.map((i) => i.title).slice(0, 20).join("; ")}` : "",
    evidenceContext ? ["", "Research evidence (ground ideas in this):", evidenceContext].join("\n") : "",
    "",
    "User preference history:",
    preferencePrompt,
  ].join("\n");
}

/** Pull report excerpts from completed research to ground idea generation. */
export function buildResearchEvidenceContext(
  db: DatabaseClient,
  threadId: string,
  maxChars = 6000,
): string {
  const rows = db.db.prepare(`
    SELECT stream_id, title, html FROM reports
    WHERE thread_id = ?
    ORDER BY CASE WHEN stream_id = 'synthesis' THEN 0 ELSE 1 END, created_at ASC
  `).all(threadId) as Array<{ stream_id: string | null; title: string; html: string }>;

  if (rows.length === 0) return "";

  const parts: string[] = [];
  let used = 0;
  for (const row of rows) {
    const label = row.stream_id === "synthesis" ? "Synthesis" : row.title;
    const excerpt = stripHtml(row.html).slice(0, 1200);
    if (!excerpt) continue;
    const block = `[${label}]\n${excerpt}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

export async function generateIdeas(
  db: DatabaseClient,
  client: OpenCodeClient,
  threadId: string,
  brief: ProjectBrief,
  model: string,
  count: number,
  batchSize: number,
  evidenceContext?: string,
): Promise<Idea[]> {
  const existing = db.db.prepare("SELECT title, description FROM ideas WHERE thread_id = ?")
    .all(threadId) as Array<{ title: string; description: string }>;
  const preferenceContext = buildPreferenceContext(db);
  const preferencePrompt = formatPreferencePrompt(preferenceContext);
  const researchEvidence = evidenceContext ?? buildResearchEvidenceContext(db, threadId);
  const ideas: Idea[] = [];
  const batches = Math.ceil(count / batchSize);

  for (let batch = 0; batch < batches; batch++) {
    const lens = LENSES[batch % LENSES.length] ?? LENSES[0];
    const prompt = buildIdeaPrompt(
      brief,
      preferencePrompt,
      existing,
      Math.min(batchSize, count - ideas.length),
      lens,
      researchEvidence || undefined,
    );

    const generated = await client.structuredCompletion(
      model,
      "Generate distinct, evidence-informed project ideas with separate quality scores from 0-10.",
      prompt,
      IdeaBatchSchema,
      {
        type: "object",
        properties: {
          ideas: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                bucket: { type: "string", enum: ["strong-fit", "creative-outlier", "safe-bet", "needs-evidence"] },
                scores: {
                  type: "object",
                  properties: {
                    relevance: { type: "number" },
                    novelty: { type: "number" },
                    evidenceStrength: { type: "number" },
                    feasibility: { type: "number" },
                    demand: { type: "number" },
                    saturation: { type: "number" },
                  },
                  required: ["relevance", "novelty", "evidenceStrength", "feasibility", "demand", "saturation"],
                },
              },
              required: ["title", "description", "bucket", "scores"],
            },
          },
        },
        required: ["ideas"],
      },
    );

    for (const item of generated.ideas) {
      if (isDuplicate(existing, item.title, item.description)) continue;
      const idea: Idea = {
        id: randomUUID(),
        threadId,
        title: item.title,
        description: item.description,
        bucket: item.bucket,
        scores: IdeaScoresSchema.parse(item.scores),
        supportingClaimIds: [],
        createdAt: new Date().toISOString(),
      };
      db.db.prepare(`
        INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idea.id,
        idea.threadId,
        idea.title,
        idea.description,
        idea.bucket,
        JSON.stringify(idea.scores),
        JSON.stringify(idea.supportingClaimIds),
        idea.createdAt,
      );
      ideas.push(IdeaSchema.parse(idea));
      existing.push({ title: idea.title, description: idea.description });
      if (ideas.length >= count) break;
    }
  }

  return ideas;
}

function isDuplicate(existing: Array<{ title: string; description: string }>, title: string, description: string): boolean {
  const normalized = `${title} ${description}`.toLowerCase();
  return existing.some((item) => {
    const other = `${item.title} ${item.description}`.toLowerCase();
    return jaccard(normalized, other) > 0.72;
  });
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(/\W+/).filter(Boolean));
  const setB = new Set(b.split(/\W+/).filter(Boolean));
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
