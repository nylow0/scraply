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

export const IntakeQuestionIdSchema = z.enum([
  "goal",
  "theme",
  "good-idea",
  "output",
  "success-decider",
  "motivation",
  "deadline",
  "resources",
  "avoid",
  "final-decision",
  "style-balance",
  "examples",
  "research-needs",
  "scoring-criteria",
  "anything-else",
]);

export const IntakeAnswerSchema = z.object({
  questionId: IntakeQuestionIdSchema,
  answer: z.string(),
  skipped: z.boolean().default(false),
});

export const ProjectBriefSchema = z.object({
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
});

export const RunConfigSchema = z.object({
  orchestratorProvider: z.enum(["opencode", "codex"]),
  orchestratorModel: z.string().min(1),
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
  autoPublishPlans: z.boolean().default(false),
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

export const IdeaSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  bucket: IdeaBucketSchema,
  scores: IdeaScoresSchema,
  supportingClaimIds: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export type Source = z.infer<typeof SourceSchema>;
export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;
export type ResearchStream = z.infer<typeof ResearchStreamSchema>;
export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Idea = z.infer<typeof IdeaSchema>;
