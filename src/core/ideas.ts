import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../db/client";
import { CostLedgerRepository } from "../db/repositories/cost-ledger";
import type { StructuredModelClient } from "../providers/structured";
import { ProviderFailure } from "../providers/structured";
import { loadPrompt } from "./prompts";
import { buildPreferenceContext, formatPreferencePrompt } from "./preferences";
import {
  IdeaBucketSchema,
  IdeaSchema,
  IdeaScoresSchema,
  RunConfigSchema,
  type Idea,
  type ModelProvider,
  type ProjectBrief,
} from "../shared/schemas";

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
  supportingClaimIds: z.array(z.string().min(1)).min(1),
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
  synthesis = "No synthesis supplied.",
  claims: Array<{ id: string; text: string; confidence: number }> = [],
  missingCoverage: string[] = [],
): string {
  return [
    `Project: ${brief.projectName}`,
    `Theme: ${brief.theme}`,
    `Description: ${brief.description}`,
    `Desired output: ${brief.desiredOutput}`,
    `Avoid: ${brief.avoidList.join("; ") || "none"}`,
    `Creative lens: ${lens}`,
    `Generate ${batchSize} distinct ideas.`,
    `Research mode: ${missingCoverage.length ? "partial" : "complete"}`,
    missingCoverage.length ? `Missing coverage: ${missingCoverage.join("; ")}` : "",
    `Synthesis: ${synthesis.slice(0, 8_000)}`,
    "Valid supporting claims (cite at least one ID per idea):",
    ...claims.map((claim) => `- ${claim.id}: ${claim.text} (${Math.round(claim.confidence * 100)}%)`),
    existing.length ? `Avoid duplicating: ${existing.map((i) => i.title).slice(0, 20).join("; ")}` : "",
    "",
    "User preference history:",
    preferencePrompt,
  ].join("\n");
}

export class IdeaGenerationBlockedError extends Error {
  readonly code = "IDEA_GENERATION_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "IdeaGenerationBlockedError";
  }
}

export interface IdeaGenerationCompleteness {
  mode: "complete" | "partial";
  synthesisReportId: string | null;
  missingLenses: string[];
  gaps: string[];
}

export interface IdeaGenerationResult {
  ideas: Idea[];
  completeness: IdeaGenerationCompleteness;
}

export async function generateIdeas(
  db: DatabaseClient,
  client: StructuredModelClient,
  runId: string,
  allowPartial = false,
): Promise<IdeaGenerationResult> {
  const run = db.db.prepare(`
    SELECT thread_id, status, brief_json, config_json FROM research_runs WHERE id = ?
  `).get(runId) as {
    thread_id: string;
    status: string;
    brief_json: string | null;
    config_json: string;
  } | undefined;
  if (!run) throw new IdeaGenerationBlockedError("Research run not found");
  const brief = run.brief_json ? JSON.parse(run.brief_json) as ProjectBrief : null;
  if (!brief) throw new IdeaGenerationBlockedError("The research run is missing its immutable brief snapshot");
  const config = RunConfigSchema.parse(JSON.parse(run.config_json));
  const synthesis = db.db.prepare(`
    SELECT id, html FROM reports
    WHERE research_run_id = ? AND report_kind = 'synthesis'
    ORDER BY created_at DESC LIMIT 1
  `).get(runId) as { id: string; html: string } | undefined;
  if (!synthesis && !allowPartial) {
    throw new IdeaGenerationBlockedError("Completed synthesis is required before generating ideas");
  }

  const coverageRows = db.db.prepare(`
    SELECT stream_id, status, gap_stop_reason, error
    FROM stream_runs WHERE research_run_id = ? ORDER BY round DESC, created_at DESC
  `).all(runId) as Array<{
    stream_id: string;
    status: string;
    gap_stop_reason: string | null;
    error: string | null;
  }>;
  const completedLenses = new Set(coverageRows.filter((row) => row.status === "completed").map((row) => row.stream_id));
  const allLenses = ["landscape", "exemplars", "pain-gaps", "resources", "analogies", "evaluation"];
  const missingLenses = allLenses.filter((lens) => !completedLenses.has(lens));
  const gaps = [...new Set(coverageRows.flatMap((row) => [row.error, row.gap_stop_reason].filter(Boolean) as string[]))];
  const mode = allowPartial ? "partial" as const : "complete" as const;

  const claimRows = db.db.prepare(`
    SELECT c.id, c.text, c.confidence, AVG(ce.evidence_quality) AS evidence_quality
    FROM claims c
    JOIN claim_evidence ce ON ce.claim_id = c.id
    WHERE c.research_run_id = ? AND c.validation_status = 'valid'
    GROUP BY c.id, c.text, c.confidence
    ORDER BY evidence_quality DESC, c.confidence DESC
    LIMIT 40
  `).all(runId) as Array<{ id: string; text: string; confidence: number; evidence_quality: number }>;
  if (claimRows.length === 0) {
    throw new IdeaGenerationBlockedError("At least one validated claim is required to generate evidence-informed ideas");
  }
  const allowedClaimIds = new Set(claimRows.map((claim) => claim.id));
  const threadId = run.thread_id;
  const model = config.ideaModel;
  const count = config.ideasRequested;
  const batchSize = config.batchSize;
  const existing = db.db.prepare("SELECT title, description FROM ideas").all() as Array<{ title: string; description: string }>;
  const preferenceContext = buildPreferenceContext(db);
  const preferencePrompt = formatPreferencePrompt(preferenceContext);
  const ideas: Idea[] = [];
  const batches = Math.ceil(count / batchSize);
  const ledger = new CostLedgerRepository(db);

  for (let batch = 0; batch < batches; batch++) {
    const lens = LENSES[batch % LENSES.length] ?? LENSES[0];
    const prompt = buildIdeaPrompt(
      brief,
      preferencePrompt,
      existing,
      Math.min(batchSize, count - ideas.length),
      lens,
      synthesis ? stripHtml(synthesis.html) : "Synthesis unavailable; use only the validated claims below.",
      claimRows,
      mode === "partial" ? [...missingLenses, ...gaps] : [],
    );

    enforceCodexCallLimit(db, runId, config.ideaProvider, config.maxCodexCalls);
    const reservation = ledger.reserve(
      runId,
      "idea-generation",
      config.ideaProvider,
      model,
      config.ideaProvider === "codex" ? 0 : 0.08,
    );
    let generated: z.infer<typeof IdeaBatchSchema>;
    try {
      generated = await client.structuredCompletion(
        model,
        loadPrompt(
          "idea-generator",
          "Generate distinct, evidence-informed project ideas with separate quality scores from 0-10. Every idea must cite one or more supplied claim IDs.",
        ),
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
                supportingClaimIds: { type: "array", items: { type: "string" }, minItems: 1 },
              },
              required: ["title", "description", "bucket", "scores", "supportingClaimIds"],
            },
          },
        },
        required: ["ideas"],
        },
      );
    } finally {
      ledger.commit(reservation.id);
    }

    for (const item of generated.ideas) {
      if (isDuplicate(existing, item.title, item.description)) continue;
      if (item.supportingClaimIds.some((claimId) => !allowedClaimIds.has(claimId))) continue;
      const claimIds = [...new Set(item.supportingClaimIds)];
      if (claimIds.length === 0) continue;
      const linkedQuality = claimRows
        .filter((claim) => claimIds.includes(claim.id))
        .reduce((sum, claim) => sum + claim.evidence_quality, 0) / claimIds.length;
      const scores = IdeaScoresSchema.parse({
        ...item.scores,
        evidenceStrength: Math.round(((item.scores.evidenceStrength * 0.5) + (linkedQuality * 10 * 0.5)) * 100) / 100,
      });
      const idea: Idea = {
        id: randomUUID(),
        threadId,
        title: item.title,
        description: item.description,
        bucket: item.bucket,
        scores,
        supportingClaimIds: claimIds,
        researchRunId: runId,
        generationMode: mode,
        createdAt: new Date().toISOString(),
      };
      db.db.prepare(`
        INSERT INTO ideas (
          id, thread_id, research_run_id, synthesis_report_id, generation_mode,
          preference_context_version, title, description, bucket, scores_json,
          supporting_claim_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        idea.id,
        idea.threadId,
        runId,
        synthesis?.id ?? null,
        mode,
        idea.title,
        idea.description,
        idea.bucket,
        JSON.stringify(idea.scores),
        JSON.stringify(idea.supportingClaimIds),
        idea.createdAt,
      );
      for (const claimId of claimIds) {
        db.db.prepare("INSERT INTO idea_claims (idea_id, claim_id) VALUES (?, ?)").run(idea.id, claimId);
      }
      ideas.push(IdeaSchema.parse(idea));
      existing.push({ title: idea.title, description: idea.description });
      if (ideas.length >= count) break;
    }
  }

  if (ideas.length === 0) {
    throw new ProviderFailure("schema", "The model returned no ideas with valid in-run claim links", false);
  }
  return {
    ideas,
    completeness: {
      mode,
      synthesisReportId: synthesis?.id ?? null,
      missingLenses: mode === "partial" ? missingLenses : [],
      gaps: mode === "partial" ? gaps : [],
    },
  };
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

function enforceCodexCallLimit(
  db: DatabaseClient,
  runId: string,
  provider: ModelProvider,
  maxCalls: number,
): void {
  if (provider !== "codex") return;
  const row = db.db.prepare(`
    SELECT COUNT(*) AS count FROM cost_ledger
    WHERE research_run_id = ? AND provider = 'codex'
  `).get(runId) as { count: number };
  if (row.count >= maxCalls) throw new IdeaGenerationBlockedError("Codex call limit reached");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
