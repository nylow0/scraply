import { createHash, randomUUID } from "node:crypto";
import type { AtomicClaimSchema, Source } from "../../shared/schemas";
import type { z } from "zod";
import type { DatabaseClient } from "../client";

type AtomicClaim = z.infer<typeof AtomicClaimSchema>;

export interface PersistedClaims {
  valid: Array<{ id: string; claim: AtomicClaim }>;
  rejected: Array<{ id: string; claim: AtomicClaim; reason: string }>;
}

export class EvidenceRepository {
  constructor(private readonly client: DatabaseClient) {}

  persistSources(runId: string, streamRunId: string, input: Source[]): Source[] {
    const output: Source[] = [];
    for (const source of input) {
      const canonicalUrl = canonicalizeUrl(source.url);
      const contentHash = createHash("sha256").update(source.text).digest("hex");
      const existing = this.client.db.prepare(`
        SELECT id, canonical_url, title, retrieved_text, author, published_at
        FROM sources
        WHERE research_run_id = ? AND (canonical_url = ? OR content_hash = ?)
        ORDER BY CASE WHEN canonical_url = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(runId, canonicalUrl, contentHash, canonicalUrl) as {
        id: string;
        canonical_url: string;
        title: string;
        retrieved_text: string;
        author: string | null;
        published_at: string | null;
      } | undefined;
      if (existing) {
        output.push({
          id: existing.id,
          url: existing.canonical_url,
          title: existing.title,
          text: existing.retrieved_text,
          ...(existing.author ? { author: existing.author } : {}),
          ...(existing.published_at ? { publishedDate: existing.published_at } : {}),
        });
        continue;
      }

      const id = randomUUID();
      this.client.db.prepare(`
        INSERT INTO sources (
          id, research_run_id, originating_stream_run_id, provider_source_id,
          canonical_url, title, retrieved_text, author, published_at,
          content_hash, retrieved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        runId,
        streamRunId,
        source.id,
        canonicalUrl,
        source.title,
        source.text,
        source.author ?? null,
        source.publishedDate ?? null,
        contentHash,
        new Date().toISOString(),
      );
      output.push({ ...source, id, url: canonicalUrl });
    }
    return output;
  }

  validateAndPersistClaims(runId: string, streamRunId: string, claims: AtomicClaim[]): PersistedClaims {
    const sourceRows = this.client.db.prepare(`
      SELECT id, retrieved_text FROM sources WHERE research_run_id = ?
    `).all(runId) as Array<{ id: string; retrieved_text: string }>;
    const sourceText = new Map(sourceRows.map((source) => [source.id, source.retrieved_text]));
    const result: PersistedClaims = { valid: [], rejected: [] };

    for (const claim of claims) {
      const id = randomUUID();
      const invalidSource = claim.sourceIds.find((sourceId) => !sourceText.has(sourceId));
      const validEvidence = claim.evidence.filter((evidence) => {
        const text = sourceText.get(evidence.sourceId);
        return text !== undefined && text.includes(evidence.quote);
      });
      const reason = invalidSource
        ? `Unknown source ID: ${invalidSource}`
        : validEvidence.length === 0
          ? "No evidence quote appears exactly in a stored source"
          : null;
      const status = reason ? "rejected" : "valid";
      this.client.db.prepare(`
        INSERT INTO claims (
          id, research_run_id, originating_stream_run_id, text, confidence,
          validation_status, validation_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, runId, streamRunId, claim.text, claim.confidence, status, reason, new Date().toISOString());

      if (reason) {
        result.rejected.push({ id, claim, reason });
        continue;
      }
      for (const evidence of validEvidence) {
        this.client.db.prepare(`
          INSERT OR IGNORE INTO claim_evidence (
            claim_id, source_id, quote, source_location, evidence_quality
          ) VALUES (?, ?, ?, NULL, ?)
        `).run(id, evidence.sourceId, evidence.quote, evidenceQuality(evidence.quote, claim.confidence));
      }
      result.valid.push({ id, claim });
    }
    return result;
  }

  listValidClaims(runId: string): Array<{
    id: string;
    text: string;
    confidence: number;
    evidence: Array<{ sourceId: string; quote: string; quality: number }>;
  }> {
    const claims = this.client.db.prepare(`
      SELECT id, text, confidence FROM claims
      WHERE research_run_id = ? AND validation_status = 'valid'
      ORDER BY created_at ASC
    `).all(runId) as Array<{ id: string; text: string; confidence: number }>;
    return claims.map((claim) => ({
      ...claim,
      evidence: this.client.db.prepare(`
        SELECT source_id as sourceId, quote, evidence_quality as quality
        FROM claim_evidence WHERE claim_id = ?
      `).all(claim.id) as Array<{ sourceId: string; quote: string; quality: number }>,
    }));
  }
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function evidenceQuality(quote: string, confidence: number): number {
  const quoteScore = Math.min(1, quote.trim().length / 160);
  return Math.round((confidence * 0.7 + quoteScore * 0.3) * 1000) / 1000;
}
