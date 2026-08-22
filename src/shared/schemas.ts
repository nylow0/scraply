import { z } from "zod";

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
export const ReasoningEffortSchema = z.string().trim().min(1).regex(/^[a-z0-9_-]+$/);
const RunConfigInputSchema = z.object({
  model: z.string().trim().min(1),
  reasoningEffort: ReasoningEffortSchema,
  discoveryDepth: DiscoveryDepthSchema,
  maxRunMinutes: z.number().int().min(5).max(240),
  researchMode: ResearchModeSchema.optional(),
  knownProblem: z.string().trim().max(2_000).optional(),
}).strict();
// Backfills configs persisted before research modes existed. The transform makes this a ZodEffects, so build
// derived schemas (.extend/.partial/.shape) from RunConfigInputSchema instead.
export const RunConfigSchema = RunConfigInputSchema.transform((value) => ({
  ...value,
  researchMode: value.researchMode ?? "explore-market" as const,
  knownProblem: value.knownProblem ?? "",
}));

export const DEFAULT_RUN_CONFIG = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  discoveryDepth: "standard",
  maxRunMinutes: 90,
  researchMode: "explore-market",
  knownProblem: "",
} satisfies RunConfig;

export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  defaultReasoningEffort: ReasoningEffortSchema,
  reasoningEfforts: z.array(z.object({
    id: ReasoningEffortSchema,
    description: z.string(),
  })).min(1),
});

export const ModelProviderSchema = z.literal("codex");
export const ModelRefSchema = z.object({ provider: ModelProviderSchema, id: z.string().min(1) });
export const ModelCatalogSchema = z.object({
  codex: z.array(z.string()),
  favorites: z.array(ModelRefSchema),
});

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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Source = z.infer<typeof SourceSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type DiscoveryDepth = z.infer<typeof DiscoveryDepthSchema>;
export type ResearchMode = z.infer<typeof ResearchModeSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type Message = z.infer<typeof MessageSchema>;
