import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClaimExtractor } from "./models/opencode";
import type { EmbeddingsClient } from "./models/embeddings";
import { ScraplyResultSchema, type AtomicClaim, type ScraplyResult, type Source } from "./schemas";

export interface SearchClient {
  search(query: string, options?: { numResults?: number; maxCharacters?: number }): Promise<Source[]>;
}

export interface PipelineOptions {
  search: SearchClient;
  extractor: ClaimExtractor;
  embeddings: EmbeddingsClient;
  workerModel: string;
  numResults?: number;
  maxCharacters?: number;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function assertGroundedClaims(claims: AtomicClaim[], sources: Source[]): void {
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const claim of claims) {
    const cited = new Set(claim.sourceIds);
    for (const sourceId of cited) {
      if (!byId.has(sourceId)) throw new Error(`Claim cites unknown source: ${sourceId}`);
    }
    for (const evidence of claim.evidence) {
      const source = byId.get(evidence.sourceId);
      if (!source || !cited.has(evidence.sourceId)) {
        throw new Error(`Evidence source ${evidence.sourceId} is not cited by its claim`);
      }
      if (!normalize(source.text).includes(normalize(evidence.quote))) {
        throw new Error(`Evidence quote was not found verbatim in source ${evidence.sourceId}`);
      }
    }
  }
}

export async function runPipeline(query: string, options: PipelineOptions): Promise<ScraplyResult> {
  const sources = await options.search.search(query, {
    ...(options.numResults === undefined ? {} : { numResults: options.numResults }),
    ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
  });
  if (sources.length === 0) throw new Error("Exa returned no sources with content");

  const extraction = await options.extractor.extract(query, sources);
  assertGroundedClaims(extraction.claims, sources);
  const embedded = await options.embeddings.embed(extraction.claims.map((claim) => claim.text));
  if (embedded.vectors.length !== extraction.claims.length) throw new Error("Embedding count does not match claim count");
  const dimensions = embedded.vectors[0]?.length ?? 0;
  if (extraction.claims.length > 0 && dimensions === 0) throw new Error("Embedding vectors are empty");
  if (embedded.vectors.some((vector) => vector.length !== dimensions)) throw new Error("Embedding dimensions are inconsistent");

  return ScraplyResultSchema.parse({
    query,
    createdAt: new Date().toISOString(),
    workerModel: options.workerModel,
    embedding: { provider: embedded.provider, model: embedded.model, dimensions },
    sources,
    claims: extraction.claims.map((claim, index) => ({
      id: `claim-${index + 1}`,
      ...claim,
      embedding: embedded.vectors[index],
    })),
  });
}

export async function persistResult(result: ScraplyResult, outputPath?: string): Promise<string> {
  const slug = result.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "research";
  const path = outputPath ?? join(".scraply", "runs", `${result.createdAt.replace(/[:.]/g, "-")}-${slug}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}
