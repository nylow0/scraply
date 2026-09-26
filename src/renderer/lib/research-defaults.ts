import { z } from "zod";
import { DEFAULT_RUN_CONFIG, DiscoveryDepthSchema, HISTORICAL_CODEX_CLI_PROVIDER_ID, ModelRefSchema, OPENAI_SUBSCRIPTION_PROVIDER_ID, ReasoningEffortSchema } from "../../shared/schemas";

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

// Named OpenAI models ("gpt-6-sol", "gpt-5.6-terra") read as "GPT-6 Sol" everywhere; the catalog's own display
// names hyphenate the variant inconsistently. Other ids keep the catalog name.
export function modelDisplayName(model: { modelId: string; displayName?: string }): string {
  const named = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(model.modelId);
  if (named?.[1] && named[2]) return `GPT-${named[1]} ${named[2].charAt(0).toUpperCase()}${named[2].slice(1)}`;
  return model.displayName ?? model.modelId;
}

export function providerDisplayName(providerId: string): string {
  if (providerId === OPENAI_SUBSCRIPTION_PROVIDER_ID) return "OpenAI";
  if (providerId === HISTORICAL_CODEX_CLI_PROVIDER_ID) return "Codex CLI (legacy)";
  return providerId.charAt(0).toUpperCase() + providerId.slice(1).replaceAll("-", " ");
}
