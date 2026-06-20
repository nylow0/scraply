import { z } from "zod";
import { EvidenceSchema, SourceSchema } from "../schemas";

export const StreamLensSchema = z.enum([
  "landscape",
  "exemplars",
  "pain-gaps",
  "resources",
  "analogies",
  "evaluation",
]);

export const IntakeBriefSchema = z.object({
  topic: z.string().min(1),
  objective: z.string().min(1),
  audience: z.string().min(1).optional(),
  constraints: z.array(z.string().min(1)).default([]),
  successCriteria: z.array(z.string().min(1)).default([]),
  budgetUsd: z.number().positive(),
  inheritedContext: z.object({
    pathNodeIds: z.array(z.string().min(1)),
    ancestorSummaries: z.array(z.object({
      nodeId: z.string().min(1),
      summary: z.string().min(1),
    })),
    ancestorClaims: z.array(z.object({
      id: z.string().min(1),
      nodeId: z.string().min(1),
      text: z.string().min(1),
      sourceIds: z.array(z.string().min(1)),
      confidence: z.number().min(0).max(1),
    })),
    selectedIdea: z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      supportingClaimIds: z.array(z.string().min(1)),
    }).optional(),
  }).optional(),
});

export const ResearchStreamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lens: StreamLensSchema,
  focus: z.string().min(1),
  instructions: z.string().min(1).optional(),
  maxHops: z.number().int().min(1).max(20).default(3),
  coverageThreshold: z.number().min(0).max(1).default(0.8),
  maxQueriesPerHop: z.number().int().min(1).max(10).default(3),
});

export const ResearchInputSchema = z.object({
  brief: IntakeBriefSchema,
  stream: ResearchStreamSchema,
});

export const StopReasonSchema = z.enum(["coverage", "budget", "max-hops", "no-follow-ups"]);

export const StreamRunSchema = z.object({
  stream: ResearchStreamSchema,
  status: z.enum(["completed", "failed"]),
  budgetUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  coverage: z.number().min(0).max(1),
  hopsCompleted: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)),
  claimIds: z.array(z.string().min(1)),
  stopReason: StopReasonSchema.optional(),
  error: z.string().min(1).optional(),
});

export const ResearchSynthesisSchema = z.object({
  model: z.string().min(1),
  summary: z.string().min(1),
  fallback: z.boolean().default(false),
});

export const StoredClaimSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  streamId: z.string().min(1),
  streamLens: StreamLensSchema,
  text: z.string().min(1).max(1000),
  sourceIds: z.array(z.string().min(1)).min(1),
  evidence: z.array(EvidenceSchema).min(1),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
  embedding: z.array(z.number()).min(1),
});

export const IdeaScoresSchema = z.object({
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  demand: z.number().min(0).max(1),
  supply: z.number().min(0).max(1),
});

export const IdeaBucketSchema = z.enum(["sweet-spot", "creative-outlier", "safe-bet"]);

export const RateIdeaInputSchema = z.object({
  ideaId: z.string().min(1),
  rating: z.coerce.number().min(0).max(1),
});

export const CreateChildInputSchema = z.object({
  parentId: z.string().min(1),
  focusTopic: z.string().min(1),
});

export const DirectorIdeaInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  supportingClaimIds: z.array(z.string().min(1)).default([]),
});

export const StoredIdeaSchema = DirectorIdeaInputSchema.extend({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  embedding: z.array(z.number()).min(1),
  scores: IdeaScoresSchema,
  bucket: IdeaBucketSchema,
  rating: z.number().min(0).max(1).nullable().default(null),
});

export const ResearchNodeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable().default(null),
  depth: z.number().int().min(0).default(0),
  brief: IntakeBriefSchema,
  stream: ResearchStreamSchema.optional(),
  streams: z.array(ResearchStreamSchema).default([]),
  streamRuns: z.array(StreamRunSchema).default([]),
  status: z.enum(["pending", "researching", "researched", "research-partial", "research-failed", "ideated"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stopReason: StopReasonSchema.optional(),
  coverage: z.number().min(0).max(1).default(0),
  spentUsd: z.number().min(0).default(0),
  hopsCompleted: z.number().int().min(0).default(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  claimIds: z.array(z.string().min(1)).default([]),
  ideaIds: z.array(z.string().min(1)).default([]),
  researchReportPath: z.string().min(1).optional(),
  researchReportLink: z.string().url().optional(),
  synthesis: ResearchSynthesisSchema.optional(),
  synthesisError: z.string().min(1).optional(),
  reportError: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export const KnowledgeStoreSchema = z.object({
  version: z.literal(1),
  nodes: z.array(ResearchNodeSchema),
  sources: z.array(SourceSchema),
  claims: z.array(StoredClaimSchema),
  ideas: z.array(StoredIdeaSchema),
});

export type IntakeBrief = z.infer<typeof IntakeBriefSchema>;
export type ResearchStream = z.infer<typeof ResearchStreamSchema>;
export type ResearchInput = z.infer<typeof ResearchInputSchema>;
export type StopReason = z.infer<typeof StopReasonSchema>;
export type StreamRun = z.infer<typeof StreamRunSchema>;
export type ResearchSynthesis = z.infer<typeof ResearchSynthesisSchema>;
export type StoredClaim = z.infer<typeof StoredClaimSchema>;
export type DirectorIdeaInput = z.infer<typeof DirectorIdeaInputSchema>;
export type StoredIdea = z.infer<typeof StoredIdeaSchema>;
export type ResearchNode = z.infer<typeof ResearchNodeSchema>;
export type KnowledgeStore = z.infer<typeof KnowledgeStoreSchema>;
