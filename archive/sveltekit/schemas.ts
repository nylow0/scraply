import { z } from "zod";

export const SourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  text: z.string().min(1),
  author: z.string().min(1).optional(),
  publishedDate: z.string().min(1).optional(),
});

export const EvidenceSchema = z.object({
  sourceId: z.string().min(1),
  quote: z.string().min(1).max(1000),
});

export const AtomicClaimSchema = z.object({
  text: z.string().min(1).max(1000),
  sourceIds: z.array(z.string().min(1)).min(1),
  evidence: z.array(EvidenceSchema).min(1),
  confidence: z.number().min(0).max(1),
});

export const ClaimExtractionSchema = z.object({
  claims: z.array(AtomicClaimSchema),
});

export const EmbeddedClaimSchema = AtomicClaimSchema.extend({
  id: z.string().min(1),
  embedding: z.array(z.number()).min(1),
});

export const ScraplyResultSchema = z.object({
  query: z.string().min(1),
  createdAt: z.string().datetime(),
  workerModel: z.string().min(1),
  embedding: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
  }),
  sources: z.array(SourceSchema),
  claims: z.array(EmbeddedClaimSchema),
});

export type Source = z.infer<typeof SourceSchema>;
export type AtomicClaim = z.infer<typeof AtomicClaimSchema>;
export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;
export type ScraplyResult = z.infer<typeof ScraplyResultSchema>;
