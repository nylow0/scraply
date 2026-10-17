import { z } from "zod";
import * as ipc from "./ipc";
import * as workflow from "./workflow-contracts";
import { AppSettingsSchema } from "./app-settings";
import { ThreadSchema } from "./schemas";
import { GetRunTraceRequestSchema, GetRunTraceStepRequestSchema, RunTraceSchema, RunTraceStepDetailSchema } from "./run-trace";
import { OpportunityBudgetExtensionPreviewSchema } from "./opportunity-exploration";
import { LaunchSettingsSchema, SaveLaunchSettingsSchema } from "./launch-settings";
import { AppError } from "./errors";

export const APP_CHANNELS = {
  LIST_PROJECTS: "scraply:list-projects", GET_PROJECT: "scraply:get-project",
  LIST_RUNS: "scraply:list-runs", RESOLVE_ENTITY: "scraply:resolve-entity",
  GET_LAUNCH_SETTINGS: "scraply:get-launch-settings", SAVE_LAUNCH_SETTINGS: "scraply:save-launch-settings",
  PREVIEW_OPERATION: "scraply:preview-operation", EXECUTE_OPERATION: "scraply:execute-operation",
  GET_ACTIVITY: "scraply:get-activity", STOP_ALL: "scraply:stop-all",
  GENERATE_PROJECT_TITLE: "scraply:generate-project-title",
  GET_PROVIDER_STATUS: "scraply:get-provider-status",
} as const;

const Id = z.string().trim().min(1).max(256);
export const EmptyRequestSchema = z.object({}).strict().default({});
export const ListProjectsRequestSchema = z.object({ archived: z.boolean().optional() }).strict().default({});
export const ListProjectsResultSchema = z.object({ projects: z.array(ThreadSchema), activeThreadId: Id.nullable() }).strict();
export const GetProjectRequestSchema = z.object({ threadId: Id }).strict();
export const GetLaunchSettingsRequestSchema = GetProjectRequestSchema;
export const ProjectDetailSchema = z.object({
  thread: ThreadSchema, workspace: ipc.WorkspaceStateSchema, launchSettings: LaunchSettingsSchema,
  draft: workflow.WorkflowLaunchDraftSchema.nullable(),
  resumableDevelopment: z.boolean(),
}).strict();
export const GetProjectResultSchema = ProjectDetailSchema;

export const ListRunsRequestSchema = z.object({ threadId: Id.optional() }).strict().default({});
/** Workflow entries include every associated research run, including completed historical runs. */
export const WorkflowRunIndexSchema = z.object({
  kind: z.literal("workflow"), id: Id, sessionId: Id, threadId: Id, threadTitle: z.string(),
  purpose: workflow.WorkflowPurposeSchema, state: workflow.WorkflowStateSchema,
  outcome: workflow.WorkflowOutcomeSchema.nullable(), revision: z.number().int().nonnegative(),
  researchRunIds: z.array(Id), startedAt: z.string(), finishedAt: z.string().nullable(),
}).strict();
export const ResearchRunIndexSchema = z.object({
  kind: z.literal("research"), id: Id, runId: Id, threadId: Id, threadTitle: z.string(),
  sessionId: Id.nullable(), problemId: Id.nullable(), purpose: z.string(), status: z.string(),
  interrupted: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const RunIndexEntrySchema = z.discriminatedUnion("kind", [WorkflowRunIndexSchema, ResearchRunIndexSchema]);
export const ListRunsResultSchema = z.object({ runs: z.array(RunIndexEntrySchema) }).strict();
export type RunIndexEntry = z.infer<typeof RunIndexEntrySchema>;

export const EntityKindSchema = z.enum([
  "project", "workflow", "run", "source", "idea", "problem", "family", "membership", "task", "finding", "request",
  "snapshot", "frame", "turn", "branch", "attempt",
]);
export type EntityKind = z.infer<typeof EntityKindSchema>;
export const ResolveEntityRequestSchema = z.object({ kind: EntityKindSchema, reference: Id, threadId: Id.optional() }).strict();
export const EntityCandidateSchema = z.object({
  id: Id, threadId: Id, title: z.string(), archived: z.boolean(), sessionId: Id.nullable().optional(),
}).strict();
export const ResolveEntityResultSchema = z.object({
  kind: EntityKindSchema, id: Id, threadId: Id, candidates: z.array(EntityCandidateSchema),
}).strict();

export const ActivitySchema = z.object({
  active: z.boolean(), engineActive: z.boolean(), activeRunIds: z.array(Id),
  workflows: z.array(z.object({ sessionId: Id, threadId: Id, state: workflow.WorkflowStateSchema }).strict()),
  activeModelCalls: z.number().int().nonnegative(), pendingModelCalls: z.number().int().nonnegative(),
  activeProjectIds: z.array(Id), pendingPosts: z.number().int().nonnegative(), stopping: z.boolean(),
  searchKeyUpdatePending: z.boolean(),
  providerValidationPending: z.boolean().default(false),
}).strict();
export const GenerateProjectTitleRequestSchema = ipc.GenerateTitleRequestSchema.extend({ threadId: Id }).strict();
export const GenerateProjectTitleResultSchema = ipc.GenerateTitleResultSchema.extend({ threadId: Id }).strict();
export const SearchKeyCredentialReferenceSchema = z.object({
  provider: ipc.SaveSearchKeySchema.shape.provider, credentialRef: z.string().uuid(),
}).strict();
export const ProviderStatusRequestSchema = EmptyRequestSchema;
export const ProviderStatusResultSchema = ipc.ValidationStateSchema;
export const CreateProjectResultSchema = z.object({ thread: ThreadSchema, workspace: ipc.WorkspaceStateSchema }).strict();
export const ExportFileSchema = z.object({ filename: z.string(), content: z.string() }).strict();
export const IdeaExportBundleSchema = z.object({ filename: z.string(), files: z.array(ExportFileSchema) }).strict();
const WorkspaceResult = z.object({ workspace: ipc.WorkspaceStateSchema });
const StartedResearchResult = WorkspaceResult.extend({ runId: Id });
const VoidResult = z.union([z.undefined(), z.null()]).transform(() => null);
const NativeCompleteResult = z.discriminatedUnion("pending", [
  z.object({ pending: z.literal(true) }), z.object({ pending: z.literal(false), workspace: ipc.WorkspaceStateSchema }),
]);

type Definition = {
  request: z.ZodType; result: z.ZodType;
  backendResult?: z.ZodType;
  route: (payload: unknown) => string; method: "GET" | "POST";
  billable: (payload: unknown) => boolean;
  boxed: boolean;
  owner: "backend" | "service";
  secretInput: boolean;
};
function operation<S extends z.ZodType, R extends z.ZodType>(request: S, result: R,
  route: string | ((input: z.output<S>) => string), method: "GET" | "POST" = "POST",
  billable: boolean | ((input: z.output<S>) => boolean) = false, boxed = false,
  owner: Definition["owner"] = "backend", secretInput = false): Definition {
  return { request, result, method, boxed, owner, secretInput,
    route: (payload) => typeof route === "string" ? route : route(request.parse(payload)),
    billable: (payload) => typeof billable === "boolean" ? billable : billable(request.parse(payload)),
  };
}
const segment = encodeURIComponent;

/** The single request/result/route/billing inventory for app adapters and CLI help parity. */
export const operationRegistry: Record<string, Definition> = {
  [ipc.IPC_CHANNELS.GET_VALIDATION]: operation(EmptyRequestSchema, ipc.ValidationStateSchema, "/validation", "GET", true, false, "service"),
  [ipc.IPC_CHANNELS.GET_WORKSPACE]: operation(EmptyRequestSchema, ipc.WorkspaceStateSchema, "/workspace", "GET"),
  [ipc.IPC_CHANNELS.RETRY_CONNECTION]: operation(EmptyRequestSchema, VoidResult, "/native/retry", "POST", true, false, "service"),
  [ipc.IPC_CHANNELS.GET_ADVANCED_SETTINGS]: operation(EmptyRequestSchema, AppSettingsSchema, "/settings/advanced", "GET"),
  [ipc.IPC_CHANNELS.SAVE_ADVANCED_SETTINGS]: operation(AppSettingsSchema, AppSettingsSchema, "/settings/advanced"),
  [ipc.IPC_CHANNELS.CREATE_THREAD]: operation(ipc.CreateThreadRequestSchema.default({}), CreateProjectResultSchema, "/threads"),
  [ipc.IPC_CHANNELS.SELECT_THREAD]: operation(ipc.SelectThreadRequestSchema, ipc.WorkspaceStateSchema, "/threads/select"),
  [ipc.IPC_CHANNELS.ARCHIVE_THREAD]: operation(ipc.ArchiveThreadRequestSchema, ipc.WorkspaceStateSchema, "/threads/archive"),
  [ipc.IPC_CHANNELS.DELETE_THREAD]: operation(ipc.DeleteThreadRequestSchema, ipc.WorkspaceStateSchema, "/threads/delete"),
  [ipc.IPC_CHANNELS.GENERATE_TITLE]: operation(ipc.GenerateTitleRequestSchema, ipc.GenerateTitleResultSchema, "/threads/title", "POST", true),
  [ipc.IPC_CHANNELS.SAVE_SCOPE]: operation(ipc.SaveScopeSchema, ipc.WorkspaceStateSchema, "/scope"),
  [ipc.IPC_CHANNELS.SAVE_RUN_CONFIG]: operation(ipc.SaveRunConfigSchema, ipc.WorkspaceStateSchema, "/run-config"),
  [ipc.IPC_CHANNELS.SAVE_FAVORITE_MODEL]: operation(ipc.SaveFavoriteModelSchema, ipc.WorkspaceStateSchema, "/models/favorite"),
  [ipc.IPC_CHANNELS.DISCARD_IDEA]: operation(ipc.DiscardIdeaRequestSchema, ipc.WorkspaceStateSchema, "/ideas/discard"),
  [ipc.IPC_CHANNELS.SAVE_DECISION]: operation(ipc.SaveDecisionSchema, ipc.WorkspaceStateSchema, "/research/decision"),
  [ipc.IPC_CHANNELS.START_RESEARCH]: operation(ipc.StartResearchSchema, StartedResearchResult, "/research/start", "POST", true),
  [ipc.IPC_CHANNELS.RESUME_RESEARCH]: operation(ipc.ResumeResearchSchema, WorkspaceResult, "/research/resume", "POST", true),
  [ipc.IPC_CHANNELS.CANCEL_RESEARCH]: operation(ipc.CancelResearchSchema, WorkspaceResult, "/research/cancel"),
  [ipc.IPC_CHANNELS.SELECT_PROBLEMS]: operation(ipc.SelectProblemsSchema, ipc.WorkspaceStateSchema, "/research/select-problems", "POST", true),
  [ipc.IPC_CHANNELS.SELECT_OPTION]: operation(ipc.SelectOptionSchema, ipc.WorkspaceStateSchema, "/research/select-option", "POST", true),
  [ipc.IPC_CHANNELS.EVIDENCE_FOLLOW_UP]: operation(ipc.EvidenceFollowUpRequestSchema, ipc.WorkspaceStateSchema, "/research/evidence-follow-up", "POST", true),
  [ipc.IPC_CHANNELS.EVIDENCE_REASSESSMENT]: operation(ipc.EvidenceReassessmentRequestSchema, ipc.WorkspaceStateSchema, "/research/evidence-reassessment", "POST", true),
  [ipc.IPC_CHANNELS.REVIEW_OPPORTUNITIES]: operation(ipc.ReviewSavedOpportunitiesSchema, ipc.WorkspaceStateSchema, "/opportunities/review", "POST", true),
  [ipc.IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP]: operation(ipc.EditOpportunityMembershipSchema, ipc.WorkspaceStateSchema, "/opportunities/membership"),
  [ipc.IPC_CHANNELS.REQUEST_FOCUSED_EXPERIMENT]: operation(ipc.RequestFocusedExperimentSchema, ipc.WorkspaceStateSchema, "/experiments/plan", "POST", true),
  [ipc.IPC_CHANNELS.PAUSE_OPPORTUNITY_EXPLORATION]: operation(ipc.OpportunityExplorationActionSchema, ipc.WorkspaceStateSchema, "/opportunities/pause"),
  [ipc.IPC_CHANNELS.START_OPPORTUNITY_EXPLORATION]: operation(ipc.ReviewSavedOpportunitiesSchema, ipc.WorkspaceStateSchema, "/opportunities/start", "POST", true),
  [ipc.IPC_CHANNELS.RESUME_OPPORTUNITY_EXPLORATION]: operation(ipc.ReviewSavedOpportunitiesSchema, ipc.WorkspaceStateSchema, "/opportunities/resume", "POST", true),
  [ipc.IPC_CHANNELS.PREVIEW_OPPORTUNITY_EXTENSION]: operation(ipc.PreviewOpportunityExtensionSchema, OpportunityBudgetExtensionPreviewSchema, "/opportunities/extension-preview"),
  [ipc.IPC_CHANNELS.APPLY_OPPORTUNITY_EXTENSION]: operation(ipc.ApplyOpportunityExtensionSchema, ipc.WorkspaceStateSchema, "/opportunities/extension", "POST", true),
  [ipc.IPC_CHANNELS.PREVIEW_WORKFLOW]: operation(workflow.PreviewWorkflowRequestSchema, workflow.PreviewWorkflowResultSchema, "/workflows/preview", "POST", false, true),
  [ipc.IPC_CHANNELS.START_WORKFLOW]: operation(workflow.StartWorkflowRequestSchema, workflow.WorkflowAdmissionReceiptSchema, "/workflows/start", "POST", true, true),
  [ipc.IPC_CHANNELS.COMMAND_WORKFLOW]: operation(workflow.CommandWorkflowRequestSchema, workflow.WorkflowAdmissionReceiptSchema, "/workflows/command", "POST", (input) => {
    switch (input.action.type) {
      case "pause": case "stop": case "edit-approved-frame": case "apply-research": case "keep-research": case "select-version": return false;
      case "resume": case "approve-frame": case "regenerate-frame": case "request-research": case "generate-ideas":
      case "retry-task": case "reassess-problems": case "assess-not-assessed": case "extend-budget": return true;
      default: { const exhaustive: never = input.action; return exhaustive; }
    }
  }, true),
  [ipc.IPC_CHANNELS.GET_WORKFLOW]: operation(workflow.GetWorkflowRequestSchema, workflow.WorkflowDetailSchema,
    (input) => `/workflows/${segment(input.sessionId)}${input.cursor ? `?cursor=${segment(input.cursor)}` : ""}`, "GET", false, true),
  [ipc.IPC_CHANNELS.GET_RUN_TRACE]: operation(GetRunTraceRequestSchema, RunTraceSchema, (input) => `/runs/${segment(input.runId)}/trace`, "GET", false, true),
  [ipc.IPC_CHANNELS.GET_RUN_TRACE_STEP]: operation(GetRunTraceStepRequestSchema, RunTraceStepDetailSchema,
    (input) => `/runs/${segment(input.runId)}/trace/steps/${segment(input.stepId)}`, "GET", false, true),
  [ipc.IPC_CHANNELS.GET_IDEA_CONVERSATION]: operation(workflow.GetIdeaConversationRequestSchema, workflow.IdeaConversationSchema, (input) => {
    const params = new URLSearchParams();
    if (input.branchId) params.set("branchId", input.branchId);
    if (input.cursor) params.set("cursor", input.cursor);
    return `/ideas/${segment(input.ideaId)}/conversation${params.size ? `?${params}` : ""}`;
  }, "GET", false, true),
  [ipc.IPC_CHANNELS.SELECT_IDEA_VERSION]: operation(workflow.SelectIdeaVersionRequestSchema, workflow.IdeaConversationSchema, "/ideas/select-version", "POST", false, true),
  [ipc.IPC_CHANNELS.SUBMIT_IDEA_TURN]: operation(workflow.SubmitIdeaTurnRequestSchema, workflow.SubmitIdeaTurnResultSchema, "/ideas/turn", "POST", true, true),
  [ipc.IPC_CHANNELS.GET_SOURCE_DETAIL]: operation(ipc.GetSourceDetailRequestSchema, ipc.SourceDetailSchema, (input) => `/sources/${segment(input.sourceId)}`, "GET"),
  [ipc.IPC_CHANNELS.GET_IDEA_DETAIL]: operation(ipc.GetIdeaDetailRequestSchema, ipc.SolutionViewSchema, (input) => `/ideas/${segment(input.ideaId)}`, "GET"),
  [ipc.IPC_CHANNELS.EXPORT_RESEARCH]: operation(ipc.ExportResearchRequestSchema, ExportFileSchema, "/research/export"),
  [ipc.IPC_CHANNELS.EXPORT_IDEAS]: operation(ipc.ExportIdeasRequestSchema, IdeaExportBundleSchema, "/ideas/export"),
  [ipc.IPC_CHANNELS.NATIVE_LOGIN_START]: operation(ipc.NativeLoginStartSchema, ipc.NativeLoginLaunchSchema, "/native/login/start"),
  [ipc.IPC_CHANNELS.NATIVE_LOGIN_COMPLETE]: operation(ipc.NativeLoginCompleteSchema, NativeCompleteResult, "/native/login/complete"),
  [ipc.IPC_CHANNELS.NATIVE_LOGIN_CANCEL]: operation(ipc.NativeLoginCancelSchema, ipc.WorkspaceStateSchema, "/native/login/cancel"),
  [ipc.IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH]: operation(ipc.NativeProviderSchema, ipc.WorkspaceStateSchema, "/native/account/refresh"),
  [ipc.IPC_CHANNELS.NATIVE_LOGOUT]: operation(ipc.NativeProviderSchema, ipc.WorkspaceStateSchema, "/native/logout"),
  // Keys and shell effects are service adapters. Their routes are descriptive and never generic billable targets.
  [ipc.IPC_CHANNELS.SAVE_SEARCH_KEY]: operation(z.union([ipc.SaveSearchKeySchema, SearchKeyCredentialReferenceSchema]), ipc.WorkspaceStateSchema, "/service/search-key", "POST", true, true, "service", true),
  [ipc.IPC_CHANNELS.REMOVE_SEARCH_KEY]: operation(ipc.RemoveSearchKeySchema, ipc.WorkspaceStateSchema, "/service/search-key/remove", "POST", false, true),
  [ipc.IPC_CHANNELS.OPEN_DATA_FOLDER]: operation(EmptyRequestSchema, z.object({ path: z.string() }), "/service/paths/data"),
  [ipc.IPC_CHANNELS.OPEN_LOGS_FOLDER]: operation(EmptyRequestSchema, z.object({ path: z.string() }), "/service/paths/logs"),
  [ipc.IPC_CHANNELS.OPEN_EXTERNAL_URL]: operation(ipc.OpenExternalUrlRequestSchema, z.object({ url: z.string().url() }), "/service/open-external"),
  [APP_CHANNELS.LIST_PROJECTS]: operation(ListProjectsRequestSchema, ListProjectsResultSchema, (input) => `/app/projects${input.archived ? "?archived=true" : ""}`, "GET"),
  [APP_CHANNELS.GET_PROJECT]: operation(GetProjectRequestSchema, ProjectDetailSchema, (input) => `/app/projects/${segment(input.threadId)}`, "GET"),
  [APP_CHANNELS.LIST_RUNS]: operation(ListRunsRequestSchema, ListRunsResultSchema, (input) => `/app/runs${input.threadId ? `?threadId=${segment(input.threadId)}` : ""}`, "GET"),
  [APP_CHANNELS.RESOLVE_ENTITY]: operation(ResolveEntityRequestSchema, ResolveEntityResultSchema, "/app/resolve"),
  [APP_CHANNELS.GET_LAUNCH_SETTINGS]: operation(GetProjectRequestSchema, LaunchSettingsSchema, (input) => `/app/projects/${segment(input.threadId)}/launch-settings`, "GET"),
  [APP_CHANNELS.SAVE_LAUNCH_SETTINGS]: operation(SaveLaunchSettingsSchema, LaunchSettingsSchema, "/app/launch-settings"),
  [APP_CHANNELS.GET_ACTIVITY]: operation(EmptyRequestSchema, ActivitySchema, "/app/activity", "GET"),
  [APP_CHANNELS.STOP_ALL]: operation(EmptyRequestSchema, ActivitySchema, "/app/stop-all"),
  [APP_CHANNELS.GENERATE_PROJECT_TITLE]: operation(GenerateProjectTitleRequestSchema, GenerateProjectTitleResultSchema, "/app/projects/title", "POST", true),
  [APP_CHANNELS.GET_PROVIDER_STATUS]: operation(ProviderStatusRequestSchema, ProviderStatusResultSchema, "/app/provider-status", "GET"),
};

/** Unknown channels and recursive generic admission are rejected before classification or dispatch. */
export function parseOperation(channel: string, payload: unknown) {
  const definition = operationRegistry[channel];
  if (!definition) throw new AppError("validation_error", "Unknown app operation.");
  return { channel, payload: definition.request.parse(payload) };
}
export function isBillableOperation(channel: string, payload: unknown): boolean {
  const parsed = parseOperation(channel, payload);
  return operationRegistry[channel]!.billable(parsed.payload);
}
export function parseOperationResult(channel: string, result: unknown): unknown {
  const definition = operationRegistry[channel];
  if (!definition) throw new AppError("validation_error", "Unknown app operation.");
  return definition.result.parse(result);
}
export function parseBackendOperationResult(channel: string, result: unknown): unknown {
  const definition = operationRegistry[channel];
  if (!definition) throw new AppError("validation_error", "Unknown app operation.");
  return (definition.backendResult ?? definition.result).parse(result);
}
export function isBoxedOperation(channel: string): boolean {
  const definition = operationRegistry[channel];
  if (!definition) return false;
  return definition.boxed;
}
export const OperationRequestSchema = z.object({ channel: z.string().min(1), payload: z.unknown() }).strict()
  .transform((input) => {
    const operation = parseOperation(input.channel, input.payload);
    if (operationRegistry[input.channel]!.secretInput && !SearchKeyCredentialReferenceSchema.safeParse(operation.payload).success) {
      throw new AppError("validation_error", "Search-key proposals must use a private credential reference.");
    }
    return operation;
  });
export const OperationProposalSchema = z.object({
  operation: OperationRequestSchema, previewHash: z.string().min(1), expiresAt: z.string().datetime(),
  capabilityFingerprint: z.string().min(1), stateFingerprint: z.string().min(1),
  summary: z.string().min(1), billing: z.literal("billable"),
}).strict();
export type OperationProposal = z.infer<typeof OperationProposalSchema>;
// A private preview request can carry a key; its returned proposal can only carry the owner reference.
export const PreviewOperationRequestSchema = z.object({ channel: z.string().min(1), payload: z.unknown() }).strict()
  .transform((input) => parseOperation(input.channel, input.payload));
export const PreviewOperationResultSchema = OperationProposalSchema;
export const ExecuteOperationRequestSchema = z.object({ proposal: OperationProposalSchema }).strict();
export const ExecuteOperationResultSchema = z.object({ channel: z.string(), result: z.unknown() }).strict()
  .transform((input) => ({ channel: input.channel, result: parseBackendOperationResult(input.channel, input.result) }));

/** Generic wrappers have schemas, but are deliberately absent from operationRegistry. */
export const appControlRegistry = {
  [APP_CHANNELS.PREVIEW_OPERATION]: operation(PreviewOperationRequestSchema, PreviewOperationResultSchema, "/app/operations/preview"),
  [APP_CHANNELS.EXECUTE_OPERATION]: operation(ExecuteOperationRequestSchema, ExecuteOperationResultSchema, "/app/operations/execute"),
} satisfies Record<string, Definition>;

// Service file adapters return bundles; raw backend routes retain their original export payloads.
for (const channel of [ipc.IPC_CHANNELS.EXPORT_RESEARCH, ipc.IPC_CHANNELS.EXPORT_IDEAS]) {
  const definition = operationRegistry[channel]!;
  definition.backendResult = definition.result;
  definition.result = z.object({ filename: z.string().optional(), files: z.array(ExportFileSchema) }).strict();
}
