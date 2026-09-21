import { z } from "zod";
import { SearchProviderSchema } from "../providers/search";
import { OpportunityExplorationConfigSchema } from "./opportunity-exploration";

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

export const DiscoveryDepthSchema = z.enum(["quick", "standard", "deep"]);
export const ResearchModeSchema = z.enum(["explore-market", "known-problem"]);
export const ExplorationPurposeSchema = z.enum(["general-solutions", "startup-opportunities"]);
export const ReasoningEffortSchema = z.string().trim().min(1).regex(/^[a-z0-9_-]+$/);
export const ProviderIdSchema = z.string().trim().min(1).regex(/^[a-z0-9_-]+$/);
export const ModelRefSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1),
}).strict();

// Historical records keep this provider ID so old runs remain attributable. Scraply no longer
// offers or executes this provider.
export const HISTORICAL_CODEX_CLI_PROVIDER_ID = "legacy-codex-cli";
export const OPENAI_SUBSCRIPTION_PROVIDER_ID = "openai-subscription";
export const MAX_IDEA_COUNT = 20;
export const DEFAULT_IDEA_COUNT = 3;
export const IdeaCountSchema = z.number().int().min(1).max(MAX_IDEA_COUNT);

const RunConfigInputSchema = z.object({
  configVersion: z.literal(2),
  workflowVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  audienceSourcePolicy: z.enum(["web", "communities"]).optional(),
  ideaCount: IdeaCountSchema.optional(),
  model: ModelRefSchema,
  reasoningEffort: ReasoningEffortSchema,
  discoveryDepth: DiscoveryDepthSchema,
  maxRunMinutes: z.number().int().min(5).max(240),
  searchProvider: SearchProviderSchema.optional(),
  researchMode: ResearchModeSchema.optional(),
  knownProblem: z.string().trim().max(2_000).optional(),
  explorationPurpose: ExplorationPurposeSchema.optional(),
  opportunityExploration: OpportunityExplorationConfigSchema.optional(),
}).strict();
const LegacyRunConfigSchema = RunConfigInputSchema.omit({ configVersion: true, model: true }).extend({
  model: z.string().trim().min(1),
}).strict();

// Bare model names came from the removed process-per-call Codex CLI adapter. Keep their origin
// explicit when old JSON is read so history cannot be mistaken for a native-runtime generation.
export const RunConfigSchema = z.union([
  RunConfigInputSchema.transform((value) => ({
    ...value,
    researchMode: value.researchMode ?? "explore-market" as const,
    knownProblem: value.knownProblem ?? "",
    searchProvider: value.searchProvider ?? "exa" as const,
    explorationPurpose: value.explorationPurpose ?? "general-solutions" as const,
  })),
  LegacyRunConfigSchema.transform((value) => ({
    ...value,
    configVersion: 2 as const,
    model: { providerId: HISTORICAL_CODEX_CLI_PROVIDER_ID, modelId: value.model },
    researchMode: value.researchMode ?? "explore-market" as const,
    knownProblem: value.knownProblem ?? "",
    searchProvider: value.searchProvider ?? "exa" as const,
    explorationPurpose: value.explorationPurpose ?? "general-solutions" as const,
  })),
]).superRefine((config, ctx) => {
  if (config.opportunityExploration && config.explorationPurpose !== "startup-opportunities") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["opportunityExploration"], message: "A distinct-business target requires startup opportunity exploration." });
  }
});

export const DEFAULT_RUN_CONFIG = {
  configVersion: 2,
  workflowVersion: 2,
  audienceSourcePolicy: "web",
  ideaCount: DEFAULT_IDEA_COUNT,
  model: { providerId: OPENAI_SUBSCRIPTION_PROVIDER_ID, modelId: "gpt-5.6-sol" },
  reasoningEffort: "medium",
  discoveryDepth: "standard",
  maxRunMinutes: 90,
  searchProvider: "exa",
  researchMode: "explore-market",
  knownProblem: "",
  explorationPurpose: "general-solutions",
} satisfies RunConfig;

export const ModelOptionSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  defaultReasoningEffort: ReasoningEffortSchema,
  reasoningEfforts: z.array(z.object({
    id: ReasoningEffortSchema,
    description: z.string(),
  })).min(1),
}).strict();

export const ModelCatalogSchema = z.object({
  models: z.array(ModelRefSchema),
  favorites: z.array(ModelRefSchema),
}).strict();

export function modelRefKey(model: ModelRef): string {
  return `${model.providerId}:${model.modelId}`;
}

export function sameModelRef(left: ModelRef, right: ModelRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export const ThreadStatusSchema = z.enum([
  "configuring",
  "discovery-running",
  "problems-ready",
  "development-running",
  "solutions-ready",
  "failed",
  "archived",
]);

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "event"]);
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
  archivedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Source = z.infer<typeof SourceSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type DiscoveryDepth = z.infer<typeof DiscoveryDepthSchema>;
export type ResearchMode = z.infer<typeof ResearchModeSchema>;
export type ExplorationPurpose = z.infer<typeof ExplorationPurposeSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
type ParsedRunConfig = z.infer<typeof RunConfigSchema>;
// Callers may still construct records written before explorationPurpose existed. Parsing always
// fills the general-purpose behavior so persisted and IPC records expose an explicit value.
export type RunConfig = Omit<ParsedRunConfig, "explorationPurpose"> & {
  explorationPurpose?: ExplorationPurpose;
};
export type SearchProvider = z.infer<typeof SearchProviderSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type Message = z.infer<typeof MessageSchema>;
