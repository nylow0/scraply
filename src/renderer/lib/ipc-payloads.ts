import { SaveFavoriteModelSchema, SaveRunConfigSchema } from "@shared/ipc";
import type { ModelRef, RunConfig } from "@shared/schemas";

export function toRunConfigPayload(threadId: string, config: RunConfig, presetName?: string) {
  return SaveRunConfigSchema.parse({ threadId, config, ...(presetName ? { presetName } : {}) });
}
export function toFavoriteModelPayload(model: ModelRef, favorite: boolean) {
  return SaveFavoriteModelSchema.parse({ model, favorite });
}
