import { OPENAI_SUBSCRIPTION_PROVIDER_ID, type ModelRef } from "./schemas";

/**
 * The models every picker shows on top, in display order. The first one the connected account offers is
 * the default for a new project. Anything else the account offers is listed under "Legacy models".
 */
export const LATEST_MODEL_IDS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"] as const;

const isLatest = (model: ModelRef) => model.providerId === OPENAI_SUBSCRIPTION_PROVIDER_ID
  && (LATEST_MODEL_IDS as readonly string[]).includes(model.modelId);

/** Latest models in display order, then the rest in the order the account lists them. */
export function splitModels<T extends ModelRef>(models: readonly T[]): { latest: T[]; legacy: T[] } {
  return {
    latest: LATEST_MODEL_IDS.flatMap((modelId) => models.filter((model) => isLatest(model) && model.modelId === modelId)),
    legacy: models.filter((model) => !isLatest(model)),
  };
}

/** The model to start from when nothing was chosen: the first latest model offered, else the first offered. */
export function preferredModel<T extends ModelRef>(models: readonly T[]): T | undefined {
  return splitModels(models).latest[0] ?? models[0];
}
