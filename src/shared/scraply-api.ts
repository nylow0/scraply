import {
  ApiResponseSchema,
  ReviewSavedOpportunitiesSchema, EditOpportunityMembershipSchema, RequestFocusedExperimentSchema,
  OpportunityExplorationActionSchema, PreviewOpportunityExtensionSchema, ApplyOpportunityExtensionSchema,
  ExportIdeasRequestSchema, ExportResearchRequestSchema, IPC_CHANNELS, SaveFavoriteModelSchema,
  NativeLoginCancelSchema, NativeLoginCompleteSchema, NativeLoginStartSchema, NativeProviderSchema,
  SaveRunConfigSchema, SaveScopeSchema, SelectProblemsSchema, SelectOptionSchema, SaveDecisionSchema, EvidenceFollowUpRequestSchema, EvidenceReassessmentRequestSchema,
  AppCommandSchema, type NativeLoginCompleteResult, type NativeLoginStartResult, type ResearchEvent,
  type SolutionView, type SourceDetail, type ValidationState, type WorkspaceState,
} from "./ipc";
import { AppError } from "./errors";
import { z } from "zod";
import {
  PreviewWorkflowRequestSchema, PreviewWorkflowResultSchema, StartWorkflowRequestSchema,
  WorkflowAdmissionReceiptSchema, GetWorkflowRequestSchema, WorkflowDetailSchema,
  CommandWorkflowRequestSchema, GetIdeaConversationRequestSchema, SelectIdeaVersionRequestSchema, IdeaConversationSchema,
  SubmitIdeaTurnRequestSchema, SubmitIdeaTurnResultSchema,
} from "./workflow-contracts";

export interface ApiTransport {
  invoke<T>(channel: string, payload?: unknown): Promise<T>;
  onAppCommand?(listener: (command: import("zod").z.infer<typeof AppCommandSchema>) => void): () => void;
  onBackendEvent(listener: (event: ResearchEvent) => void): () => void;
}

export function createScraplyApi(transport: ApiTransport) {
  async function workflowInvoke<T extends z.ZodTypeAny>(channel: string, payload: unknown, resultSchema: T): Promise<z.infer<T>> {
    const response = ApiResponseSchema(resultSchema).parse(await transport.invoke<unknown>(channel, payload));
    if ("error" in response) {
      const { code, message, reference, recovery } = response.error;
      throw new AppError(code, message, undefined, reference, recovery);
    }
    if ("data" in response) return response.data;
    throw new AppError("internal_error");
  }

  return {
    previewWorkflow: (payload: z.infer<typeof PreviewWorkflowRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.PREVIEW_WORKFLOW, PreviewWorkflowRequestSchema.parse(payload), PreviewWorkflowResultSchema),
    startWorkflow: (payload: z.infer<typeof StartWorkflowRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.START_WORKFLOW, StartWorkflowRequestSchema.parse(payload), WorkflowAdmissionReceiptSchema),
    getWorkflow: (payload: z.infer<typeof GetWorkflowRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.GET_WORKFLOW, GetWorkflowRequestSchema.parse(payload), WorkflowDetailSchema),
    commandWorkflow: (payload: z.infer<typeof CommandWorkflowRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.COMMAND_WORKFLOW, CommandWorkflowRequestSchema.parse(payload), WorkflowAdmissionReceiptSchema),
    getIdeaConversation: (payload: z.infer<typeof GetIdeaConversationRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.GET_IDEA_CONVERSATION, GetIdeaConversationRequestSchema.parse(payload), IdeaConversationSchema),
    selectIdeaVersion: (payload: z.infer<typeof SelectIdeaVersionRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.SELECT_IDEA_VERSION, SelectIdeaVersionRequestSchema.parse(payload), IdeaConversationSchema),
    submitIdeaTurn: (payload: z.infer<typeof SubmitIdeaTurnRequestSchema>) =>
      workflowInvoke(IPC_CHANNELS.SUBMIT_IDEA_TURN, SubmitIdeaTurnRequestSchema.parse(payload), SubmitIdeaTurnResultSchema),
    startOpportunityExploration: (payload: import("zod").z.infer<typeof ReviewSavedOpportunitiesSchema>): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.START_OPPORTUNITY_EXPLORATION, ReviewSavedOpportunitiesSchema.parse(payload)),
    pauseOpportunityExploration: (threadId: string): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.PAUSE_OPPORTUNITY_EXPLORATION, OpportunityExplorationActionSchema.parse({ threadId })),
    resumeOpportunityExploration: (payload: import("zod").z.infer<typeof ReviewSavedOpportunitiesSchema>): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.RESUME_OPPORTUNITY_EXPLORATION, ReviewSavedOpportunitiesSchema.parse(payload)),
    previewOpportunityBudgetExtension: (payload: import("zod").z.infer<typeof PreviewOpportunityExtensionSchema>): Promise<import("./opportunity-exploration").OpportunityBudgetExtensionPreview> =>
      transport.invoke(IPC_CHANNELS.PREVIEW_OPPORTUNITY_EXTENSION, PreviewOpportunityExtensionSchema.parse(payload)),
    applyOpportunityBudgetExtension: (payload: import("zod").z.infer<typeof ApplyOpportunityExtensionSchema>): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.APPLY_OPPORTUNITY_EXTENSION, ApplyOpportunityExtensionSchema.parse(payload)),
    reviewSavedOpportunities: (payload: import("zod").z.infer<typeof ReviewSavedOpportunitiesSchema>): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.REVIEW_OPPORTUNITIES, ReviewSavedOpportunitiesSchema.parse(payload)),
    editOpportunityMembership: (payload: import("zod").z.infer<typeof EditOpportunityMembershipSchema>): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP, EditOpportunityMembershipSchema.parse(payload)),
    requestFocusedExperiment: (payload: import("zod").z.infer<typeof RequestFocusedExperimentSchema>): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.REQUEST_FOCUSED_EXPERIMENT, RequestFocusedExperimentSchema.parse(payload)),
    selectOption: (payload: { threadId: string; runId: string; solutionId: string }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.SELECT_OPTION, SelectOptionSchema.parse(payload)),
    saveDecision: (payload: { threadId: string; solutionId: string; userDecision: string; observedResult: string; experimentOutcome?: "not-run" | "pass" | "fail" | "inconclusive" }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.SAVE_DECISION, SaveDecisionSchema.parse(payload)),
    requestEvidenceFollowUp: (payload: { threadId: string; runId: string; question: string }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.EVIDENCE_FOLLOW_UP, EvidenceFollowUpRequestSchema.parse(payload)),
    requestEvidenceReassessment: (payload: { threadId: string; runId: string }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.EVIDENCE_REASSESSMENT, EvidenceReassessmentRequestSchema.parse(payload)),
    getValidation: (): Promise<ValidationState> => transport.invoke(IPC_CHANNELS.GET_VALIDATION),
    retryConnection: (): Promise<void> => transport.invoke(IPC_CHANNELS.RETRY_CONNECTION),
    getWorkspace: (): Promise<WorkspaceState> => transport.invoke(IPC_CHANNELS.GET_WORKSPACE),
    openDataFolder: (): Promise<void> => transport.invoke(IPC_CHANNELS.OPEN_DATA_FOLDER),
    openLogsFolder: (): Promise<void> => transport.invoke(IPC_CHANNELS.OPEN_LOGS_FOLDER),
    createThread: (title?: string): Promise<{ workspace: WorkspaceState }> => transport.invoke(IPC_CHANNELS.CREATE_THREAD, { title }),
    selectThread: (threadId: string): Promise<WorkspaceState> => transport.invoke(IPC_CHANNELS.SELECT_THREAD, { threadId }),
    archiveThread: (threadId: string, archived: boolean): Promise<WorkspaceState> => transport.invoke(IPC_CHANNELS.ARCHIVE_THREAD, { threadId, archived }),
    generateTitle: (payload: { context: string; model: import("./schemas").ModelRef; reasoningEffort: string }): Promise<{ title: string }> => transport.invoke(IPC_CHANNELS.GENERATE_TITLE, payload),
    discardIdea: (threadId: string, ideaId: string, discarded: boolean): Promise<WorkspaceState> => transport.invoke(IPC_CHANNELS.DISCARD_IDEA, { threadId, ideaId, discarded }),
    showAppMenu: (payload: { menu: "File" | "Edit" | "View" | "Help"; x: number; y: number }): Promise<void> => transport.invoke(IPC_CHANNELS.SHOW_APP_MENU, payload),
    onAppCommand: transport.onAppCommand ?? (() => () => {}),
    deleteThread: (threadId: string): Promise<WorkspaceState> => transport.invoke(IPC_CHANNELS.DELETE_THREAD, { threadId }),
    saveScope: (payload: { threadId: string; scope: NonNullable<WorkspaceState["scope"]> }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.SAVE_SCOPE, SaveScopeSchema.parse(payload)),
    saveRunConfig: (payload: { threadId: string; config: NonNullable<WorkspaceState["runConfig"]>; presetName?: string }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, SaveRunConfigSchema.parse(payload)),
    saveFavoriteModel: (payload: { model: { providerId: string; modelId: string }; favorite: boolean }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.SAVE_FAVORITE_MODEL, SaveFavoriteModelSchema.parse(payload)),
    startNativeLogin: (payload: { providerId: string; method: "browser" | "device" }): Promise<NativeLoginStartResult> =>
      transport.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, NativeLoginStartSchema.parse(payload)),
    completeNativeLogin: (payload: { loginId: string }): Promise<NativeLoginCompleteResult> =>
      transport.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, NativeLoginCompleteSchema.parse(payload)),
    cancelNativeLogin: (payload: { loginId: string; providerId: string }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, NativeLoginCancelSchema.parse(payload)),
    refreshNativeAccount: (providerId: string): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, NativeProviderSchema.parse({ providerId })),
    logoutNativeAccount: (providerId: string): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.NATIVE_LOGOUT, NativeProviderSchema.parse({ providerId })),
    startResearch: (threadId: string): Promise<{ workspace: WorkspaceState }> => transport.invoke(IPC_CHANNELS.START_RESEARCH, { threadId }),
    cancelResearch: async (runId: string): Promise<WorkspaceState> => (await transport.invoke<{ workspace: WorkspaceState }>(IPC_CHANNELS.CANCEL_RESEARCH, { runId })).workspace,
    resumeResearch: async (runId: string): Promise<WorkspaceState> => (await transport.invoke<{ workspace: WorkspaceState }>(IPC_CHANNELS.RESUME_RESEARCH, { runId })).workspace,
    selectProblems: (payload: { threadId: string; problemIds: string[]; userProblem: string | null; model: import("./schemas").ModelRef; reasoningEffort: string }): Promise<WorkspaceState> =>
      transport.invoke(IPC_CHANNELS.SELECT_PROBLEMS, SelectProblemsSchema.parse(payload)),
    exportResearch: (threadId: string): Promise<{ cancelled: true } | { cancelled: false; file: string }> =>
      transport.invoke(IPC_CHANNELS.EXPORT_RESEARCH, ExportResearchRequestSchema.parse({ threadId })),
    exportIdeas: (threadId: string, format: "markdown" | "json" = "markdown"): Promise<{ cancelled: true } | { cancelled: false; directory: string; files: string[] }> =>
      transport.invoke(IPC_CHANNELS.EXPORT_IDEAS, ExportIdeasRequestSchema.parse({ threadId, format })),
    getSourceDetail: (sourceId: string): Promise<SourceDetail> => transport.invoke(IPC_CHANNELS.GET_SOURCE_DETAIL, { sourceId }),
    getIdeaDetail: (ideaId: string): Promise<SolutionView> => transport.invoke(IPC_CHANNELS.GET_IDEA_DETAIL, { ideaId }),
    openExternalUrl: (url: string): Promise<void> => transport.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, { url }),
    onBackendEvent: transport.onBackendEvent,
  };
}

export type ScraplyApi = ReturnType<typeof createScraplyApi>;
