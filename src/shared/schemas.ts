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
export const RunConfigSchema = z.object({
  model: z.string().trim().min(1),
  discoveryDepth: DiscoveryDepthSchema,
  maxRunMinutes: z.number().int().min(5).max(240),
}).strict();

export const DEFAULT_RUN_CONFIG = {
  model: "gpt-5.2-codex",
  discoveryDepth: "standard",
  maxRunMinutes: 90,
} satisfies RunConfig;

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
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type Message = z.infer<typeof MessageSchema>;
