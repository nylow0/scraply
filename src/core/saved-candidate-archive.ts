import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../db/client";
import { factorOriginHash } from "../db/repositories/workflows";
import type { ResearchOriginMap } from "./research-revisions";
import { SavedProblemCandidateSchema } from "../shared/structured-output-schemas";
import { canonicalJson, sha256 } from "../shared/content-identity";

type SavedRow = Record<string, string | number | null>;

/** Preserve deferred candidates and their original quotes when an archive becomes a new snapshot. */
export function copySavedProblemCandidates(client: DatabaseClient, input: {
  sourceRunIds: string[]; targetRunId: string; excludeCandidateIds?: string[]; originMap: ResearchOriginMap;
}): Record<string, string> {
  client.requireImmediateTransaction();
  const copiedCandidates: Record<string, string> = {};
  const excluded = new Set(input.excludeCandidateIds);
  const factors = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const runId of new Set(input.sourceRunIds)) {
    const rows = client.db.prepare("SELECT * FROM rejected_problem_candidates WHERE discovery_run_id = ? ORDER BY rowid")
      .all(runId) as SavedRow[];
    for (const row of rows) {
      if (typeof row.id !== "string" || excluded.has(row.id)) continue;
      const candidateId = randomUUID();
      copiedCandidates[row.id] = candidateId;
      const candidate = typeof row.candidate_json === "string"
        ? SavedProblemCandidateSchema.parse(JSON.parse(row.candidate_json)) : null;
      if (!candidate) {
        insertCopy(client, "rejected_problem_candidates", row, { id: candidateId, discovery_run_id: input.targetRunId });
        continue;
      }
      const buyerFactorIds = "intendedBuyerEvidenceFactorIds" in candidate
        ? z.array(z.string()).parse(candidate.intendedBuyerEvidenceFactorIds) : [];
      const required = new Set([...candidate.factorIds, ...(candidate.scaleBasisFactorId ? [candidate.scaleBasisFactorId] : []),
        ...buyerFactorIds]);
      for (const id of required) {
        if (factors.has(id)) continue;
        const factor = client.db.prepare("SELECT * FROM factors WHERE id = ? AND research_run_id = ?").get(id, runId) as SavedRow | undefined;
        if (!factor || typeof factor.source_id !== "string") throw new Error("A saved candidate's factor is unavailable.");
        const sourceId = factor.source_id;
        if (!sources.has(sourceId)) {
          const source = client.db.prepare("SELECT * FROM sources WHERE id = ? AND research_run_id = ?")
            .get(sourceId, runId) as SavedRow | undefined;
          if (!source || typeof source.retrieved_text !== "string" || sha256(source.retrieved_text) !== source.content_hash) {
            throw new Error("A saved candidate's source quote is unavailable or changed.");
          }
          const prior = client.db.prepare("SELECT id, content_hash FROM sources WHERE research_run_id = ? AND canonical_url = ?")
            .get(input.targetRunId, source.canonical_url) as { id: string; content_hash: string } | undefined;
          if (prior && prior.content_hash !== source.content_hash) throw new Error("Saved candidates contain conflicting excerpts for one source URL.");
          const copiedId = prior?.id ?? randomUUID();
          if (!prior) insertCopy(client, "sources", source, { id: copiedId, research_run_id: input.targetRunId });
          (input.originMap.sources[copiedId] ??= []).push({ originalId: sourceId, originalRunId: runId, contentSha256: String(source.content_hash) });
          sources.set(sourceId, copiedId);
        }
        const copiedId = randomUUID();
        insertCopy(client, "factors", factor, { id: copiedId, research_run_id: input.targetRunId, source_id: sources.get(sourceId)! });
        factors.set(id, copiedId);
        input.originMap.factors[copiedId] = { originalId: id, originalRunId: runId, contentSha256: factorOriginHash(factor) };
      }
      const remapped = SavedProblemCandidateSchema.parse({ ...candidate,
        factorIds: candidate.factorIds.map(id => factors.get(id)!),
        scaleBasisFactorId: candidate.scaleBasisFactorId ? factors.get(candidate.scaleBasisFactorId)! : null,
        ...("intendedBuyerEvidenceFactorIds" in candidate
          ? { intendedBuyerEvidenceFactorIds: buyerFactorIds.map(id => factors.get(id)!) } : {}),
      });
      insertCopy(client, "rejected_problem_candidates", row, { id: candidateId, discovery_run_id: input.targetRunId,
        candidate_json: canonicalJson(remapped) });
    }
  }
  return copiedCandidates;
}

// Column names come from these local SQLite rows so additional saved metadata survives future migrations.
function insertCopy(client: DatabaseClient, table: "sources" | "factors" | "rejected_problem_candidates",
  row: SavedRow, replacements: SavedRow): void {
  const copied = { ...row, ...replacements };
  const columns = Object.keys(copied);
  client.db.prepare(`INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(",")})
    VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => copied[column]!));
}
