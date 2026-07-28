import { z } from "zod";

export const OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

export const SourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  text: z.string().min(1),
  author: z.string().min(1).optional(),
  publishedDate: z.string().min(1).optional(),
});

export const SourceDetailSchema = SourceSchema.extend({
  researchRunId: z.string().min(1),
  contentHash: z.string().min(1),
  retrievedAt: z.string().datetime(),
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

export const StreamLensSchema = z.enum([
  "landscape",
  "exemplars",
  "pain-gaps",
  "resources",
  "analogies",
  "evaluation",
]);

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

export const LegacyProjectBriefSchema = z.object({
  projectName: z.string().min(1),
  theme: z.string().min(1),
  description: z.string().min(1),
  desiredOutput: z.string().min(1),
  successDefinition: z.string().min(1),
  constraints: z.array(z.string()),
  resources: z.array(z.string()),
  avoidList: z.array(z.string()),
  researchNeeds: z.string(),
  finalDecision: z.string().min(1),
  deadline: z.string(),
  availableEffort: z.string(),
  ideaStylePreference: z.string(),
}).passthrough();

export const DesiredOutputTypeSchema = z.enum([
  "options",
  "ranked-shortlist",
  "decision-memo",
  "research-brief",
  "comparison",
  "other",
]);

export const ProjectBriefV2Schema = z.object({
  schemaVersion: z.literal(2),
  title: z.string(),
  objective: z.string().min(1),
  context: z.string(),
  decisionToSupport: z.string(),
  audience: z.array(z.string()),
  desiredOutput: z.object({
    type: DesiredOutputTypeSchema,
    notes: z.string(),
  }).strict(),
  successCriteria: z.array(z.string()),
  hardConstraints: z.array(z.string()),
  preferences: z.array(z.string()),
  antiGoals: z.array(z.string()),
  resources: z.array(z.string()),
  deadline: z.string().nullable(),
  availableEffort: z.string().nullable(),
  evidenceRequirements: z.array(z.string()),
  examplesToInspect: z.array(z.string()),
  ideaStyle: z.enum(["safe", "balanced", "bold"]),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  contradictions: z.array(z.string()),
}).strict();

// Runtime code only operates on V2. Legacy data is accepted exclusively through
// parseAndNormalizeBrief at persistence and IPC boundaries.
export const ProjectBriefSchema = ProjectBriefV2Schema;

export const RunConfigSchema = z.object({
  orchestratorProvider: z.enum(["opencode", "codex"]),
  orchestratorModel: z.string().min(1),
  workerProvider: z.enum(["opencode", "codex"]).default("codex"),
  workerModel: z.string().min(1),
  ideaProvider: z.enum(["opencode", "codex"]),
  ideaModel: z.string().min(1),
  ideasRequested: z.number().int().min(1).max(200).default(24),
  batchSize: z.number().int().min(1).max(20).default(6),
  maxFollowUpRounds: z.number().int().min(0).max(5).default(2),
  searchResultsPerStream: z.number().int().min(1).max(20).default(5),
  pageCharLimit: z.number().int().min(500).max(20000).default(6000),
  parallelism: z.number().int().min(1).max(6).default(3),
  maxSpendUsd: z.number().min(0).max(100).default(5),
  maxCodexCalls: z.number().int().min(1).max(500).default(40),
  maxExaSearches: z.number().int().min(1).max(100).default(20),
  maxRunMinutes: z.number().int().min(1).max(240).default(30),
});

export const ModelProviderSchema = z.enum(["opencode", "codex"]);

export const ModelRefSchema = z.object({
  provider: ModelProviderSchema,
  id: z.string().min(1),
});

export const ModelCatalogSchema = z.object({
  opencode: z.array(z.string()),
  codex: z.array(z.string()),
  favorites: z.array(ModelRefSchema),
});

export const ThreadStatusSchema = z.enum([
  "intake",
  "brief-draft",
  "brief-confirmed",
  "configuring",
  "research-queued",
  "research-running",
  "research-complete",
  "ideas-generating",
  "ideas-ready",
  "archived",
]);

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "report", "event"]);

export const MessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export const ThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: ThreadStatusSchema,
  parentThreadId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const IdeaBucketSchema = z.enum([
  "strong-fit",
  "creative-outlier",
  "safe-bet",
  "needs-evidence",
]);

export const IdeaScoresSchema = z.object({
  relevance: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
  evidenceStrength: z.number().min(0).max(10),
  feasibility: z.number().min(0).max(10),
  demand: z.number().min(0).max(10),
  saturation: z.number().min(0).max(10),
});

export const IdeaRatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  notes: z.string().nullable().optional(),
  updatedAt: z.string().datetime(),
});

export const BranchContextSchema = z.object({
  threadId: z.string().min(1),
  parentThreadId: z.string().min(1),
  seedIdeaId: z.string().min(1),
  seedIdeaTitle: z.string().min(1),
  explorationAngle: z.string().min(1),
  inheritedBriefSnapshot: ProjectBriefSchema,
  inheritedBriefVersion: z.number().int().positive(),
  selectedClaimIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
});

export const IdeaEvidenceSchema = z.object({
  claimId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceTitle: z.string().min(1),
  url: z.string().url(),
  quote: z.string().min(1),
});

export const IdeaSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  bucket: IdeaBucketSchema,
  scores: IdeaScoresSchema,
  supportingClaimIds: z.array(z.string()),
  researchRunId: z.string().min(1).optional(),
  generationMode: z.enum(["complete", "partial"]).optional(),
  currentRating: IdeaRatingSchema.nullable().optional(),
  evidence: z.array(IdeaEvidenceSchema).optional(),
  createdAt: z.string().datetime(),
});

export type Source = z.infer<typeof SourceSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;
export type ResearchStream = z.infer<typeof ResearchStreamSchema>;
export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;
export type LegacyProjectBrief = z.infer<typeof LegacyProjectBriefSchema>;
export type ProjectBriefV2 = z.infer<typeof ProjectBriefV2Schema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type BranchContext = z.infer<typeof BranchContextSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Idea = z.infer<typeof IdeaSchema>;
export type IdeaRating = z.infer<typeof IdeaRatingSchema>;
export type IdeaEvidence = z.infer<typeof IdeaEvidenceSchema>;
