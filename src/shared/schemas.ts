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

/** A single research worker the user can toggle, edit, or add to a run. */
export const ResearcherSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lens: StreamLensSchema.default("landscape"),
  focus: z.string().min(1),
  instructions: z.string().default(""),
  enabled: z.boolean().default(true),
  custom: z.boolean().default(false),
});

export type Researcher = z.infer<typeof ResearcherSchema>;

/** The six built-in researchers seeded into every new run. */
export const DEFAULT_RESEARCHERS: Researcher[] = [
  {
    id: "landscape",
    name: "Landscape",
    lens: "landscape",
    focus: "Map topic state, key concepts, constraints, and current approaches.",
    instructions: "Map the current landscape and its boundaries. Prefer primary data and clearly distinguish established facts from forecasts.",
    enabled: true,
    custom: false,
  },
  {
    id: "exemplars",
    name: "Exemplars",
    lens: "exemplars",
    focus: "Find related people, projects, products, papers, demos, and entries.",
    instructions: "Find concrete exemplars and explain what measurably works, for whom, and under which conditions.",
    enabled: true,
    custom: false,
  },
  {
    id: "pain-gaps",
    name: "Pain & Gaps",
    lens: "pain-gaps",
    focus: "Find complaints, missing pieces, weak points, and unsolved problems.",
    instructions: "Prioritize evidenced pain, failed workarounds, switching friction, and unmet demand.",
    enabled: true,
    custom: false,
  },
  {
    id: "resources",
    name: "Resources",
    lens: "resources",
    focus: "Find usable datasets, APIs, libraries, tools, communities, and methods.",
    instructions: "Inventory resources that materially change feasibility, including access requirements and limitations.",
    enabled: true,
    custom: false,
  },
  {
    id: "analogies",
    name: "Analogies",
    lens: "analogies",
    focus: "Find adjacent fields solving similarly shaped problems.",
    instructions: "Seek structural analogies, not surface similarity. State where the analogy is likely to break.",
    enabled: true,
    custom: false,
  },
  {
    id: "evaluation",
    name: "Evaluation",
    lens: "evaluation",
    focus: "Find rubrics, benchmarks, judging criteria, and quality signals.",
    instructions: "Define how options should be judged. Surface disconfirming evidence and cheap validation tests.",
    enabled: true,
    custom: false,
  },
];

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
  goal: z.string().default(""),
  theme: z.string().min(1),
  description: z.string().min(1),
  successDefinition: z.string().min(1),
  desiredOutput: z.string().min(1),
  successDecider: z.string().default(""),
  motivation: z.string().default(""),
  constraints: z.array(z.string()),
  resources: z.array(z.string()),
  avoidList: z.array(z.string()),
  researchNeeds: z.string(),
  finalDecision: z.string().min(1),
  deadline: z.string(),
  availableEffort: z.string(),
  ideaStylePreference: z.string(),
  examples: z.string().default(""),
  scoringCriteria: z.string().default(""),
  anythingElse: z.string().default(""),
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
  researchers: z.array(ResearcherSchema).min(1).default(DEFAULT_RESEARCHERS),
});

export const ThreadStatusSchema = z.enum([
  "draft",
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
