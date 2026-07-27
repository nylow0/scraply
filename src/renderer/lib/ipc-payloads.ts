import { CreateBranchRequestSchema, SaveFavoriteModelSchema, StartBriefIntakeSchema } from "@shared/ipc";
import { parseAndNormalizeBrief } from "@shared/brief-normalizer";
import {
  RunConfigSchema,
  type ProjectBrief,
  type RunConfig,
} from "@shared/schemas";

export function toProjectBriefPayload(value: unknown): ProjectBrief {
  return parseAndNormalizeBrief(value);
}

export function toRunConfigPayload(value: unknown): RunConfig {
  return RunConfigSchema.parse(value);
}

export function toFavoriteModelPayload(value: unknown) {
  return SaveFavoriteModelSchema.parse(value);
}

export function toCreateBranchPayload(value: unknown) {
  return CreateBranchRequestSchema.parse(value);
}

export function toStartBriefIntakePayload(value: unknown) {
  return StartBriefIntakeSchema.parse(value);
}
