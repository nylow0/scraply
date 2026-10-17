import { z } from "zod";
import { buildWorkflowLaunchDraft } from "./launch-draft";
import type { RunConfig } from "./schemas";
import type { Scope } from "./structured-output-schemas";
import { WorkflowInstructionsSchema, WorkflowLaunchDraftSchema, WorkflowLimitsSchema, WorkflowModeSchema, WorkflowTargetSchema } from "./workflow-contracts";

/** Editable choices only. Saved workflow contracts and their resolved prompts remain immutable. */
export const LaunchSettingsSchema = z.object({
  version: z.literal(1),
  mode: WorkflowModeSchema,
  ideas: WorkflowLaunchDraftSchema.shape.ideas,
  automaticProblemCap: z.number().int().min(1).max(20).nullable(),
  targets: WorkflowTargetSchema.optional(),
  limits: WorkflowLimitsSchema,
  instructions: WorkflowInstructionsSchema,
}).strict();
export type LaunchSettings = z.infer<typeof LaunchSettingsSchema>;

export const SaveLaunchSettingsSchema = z.object({
  threadId: z.string().trim().min(1).max(128), settings: LaunchSettingsSchema,
}).strict();

export function defaultLaunchSettings(scope: Scope, config: RunConfig): LaunchSettings {
  const draft = buildWorkflowLaunchDraft(scope, config, {
    mode: "vibe", ideas: { model: config.model, reasoningEffort: config.reasoningEffort },
  });
  return LaunchSettingsSchema.parse({
    version: 1, mode: draft.mode, ideas: draft.ideas, automaticProblemCap: null,
    limits: draft.limits, instructions: draft.instructions,
  });
}

/** Keep model choices verbatim; preflight reports unavailable choices to the caller. */
export function buildSavedLaunchDraft(scope: Scope, config: RunConfig, settings: LaunchSettings) {
  const ideas = settings.ideas ?? { model: config.model, reasoningEffort: config.reasoningEffort };
  const options = {
    automaticProblemCap: settings.automaticProblemCap, limits: settings.limits, instructions: settings.instructions,
  };
  const draft = buildWorkflowLaunchDraft(scope, config, settings.mode === "vibe"
    ? { ...options, mode: "vibe", ideas } : { ...options, mode: "babysit" });
  return WorkflowLaunchDraftSchema.parse({
    ...draft,
    ...(settings.mode === "vibe" ? { ideas } : {}),
    ...(settings.targets ? { targets: settings.targets } : {}),
    limits: settings.limits,
  });
}
