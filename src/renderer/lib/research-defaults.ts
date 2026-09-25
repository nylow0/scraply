import { z } from "zod";
import { DEFAULT_RUN_CONFIG, DiscoveryDepthSchema, ModelRefSchema, ReasoningEffortSchema } from "../../shared/schemas";

const storageKey = "scraply.research-defaults.v1";
const ResearchDefaultsSchema = z.object({
  model: ModelRefSchema,
  searchProvider: z.enum(["exa", "perplexity"]),
  audienceSourcePolicy: z.enum(["web", "communities"]).default("web"),
  discoveryDepth: DiscoveryDepthSchema.default("standard"),
  titleModel: ModelRefSchema.default({ providerId: "openai-subscription", modelId: "gpt-6-luna" }),
  titleReasoningEffort: ReasoningEffortSchema.default("low"),
});
export type ResearchDefaults = z.infer<typeof ResearchDefaultsSchema>;

// Preferences belong to this installed app. A saved project's run config takes precedence.
export function readResearchDefaults(): ResearchDefaults {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return ResearchDefaultsSchema.parse(JSON.parse(stored));
  } catch {
    // A missing or invalid preference must not prevent the workspace from opening.
  }
  return ResearchDefaultsSchema.parse({ model: { ...DEFAULT_RUN_CONFIG.model }, searchProvider: DEFAULT_RUN_CONFIG.searchProvider });
}

export function saveResearchDefaults(defaults: ResearchDefaults): void {
  localStorage.setItem(storageKey, JSON.stringify(ResearchDefaultsSchema.parse(defaults)));
}

export function modelDisplayName(model: { modelId: string; displayName?: string }): string {
  if (model.modelId === "gpt-6-astra") return "GPT-6 Astra";
  if (model.modelId === "gpt-6-sol") return "GPT-6 Sol";
  if (model.modelId === "gpt-6-luna") return "GPT-6 Luna";
  if (model.modelId === "gpt-5.6-luna") return "GPT-5.6 Luna";
  if (model.modelId === "gpt-5.6-sol") return "GPT-5.6 Sol";
  return model.displayName ?? model.modelId;
}
