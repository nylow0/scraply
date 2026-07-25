import { CreateBranchRequestSchema, SaveFavoriteModelSchema } from "@shared/ipc";
import {
  ProjectBriefSchema,
  RunConfigSchema,
  type ProjectBrief,
  type RunConfig,
} from "@shared/schemas";

export function toProjectBriefPayload(value: unknown): ProjectBrief {
  return ProjectBriefSchema.parse(value);
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
