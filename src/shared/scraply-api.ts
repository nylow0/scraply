import {
  ExportIdeasRequestSchema, ExportResearchRequestSchema, IPC_CHANNELS, SaveFavoriteModelSchema,
  NativeLoginCancelSchema, NativeLoginCompleteSchema, NativeLoginStartSchema, NativeProviderSchema,
  SaveRunConfigSchema, SaveScopeSchema, SelectProblemsSchema, SelectOptionSchema, SaveDecisionSchema, EvidenceFollowUpRequestSchema, EvidenceReassessmentRequestSchema,
  AppCommandSchema, type NativeLoginCompleteResult, type NativeLoginStartResult, type ResearchEvent,
  type SolutionView, type SourceDetail, type ValidationState, type WorkspaceState,
} from "./ipc";

export interface ApiTransport {
  invoke<T>(channel: string, payload?: unknown): Promise<T>;
  onAppCommand?(listener: (command: import("zod").z.infer<typeof AppCommandSchema>) => void): () => void;
  onBackendEvent(listener: (event: ResearchEvent) => void): () => void;
}

export function createScraplyApi(transport: ApiTransport) {
  return {
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
