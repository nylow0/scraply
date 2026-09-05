import { contextBridge, ipcRenderer } from "electron";
import {
  ExportIdeasRequestSchema, ExportResearchRequestSchema, IPC_CHANNELS, ResearchEventSchema, SaveFavoriteModelSchema,
  NativeLoginCancelSchema, NativeLoginCompleteSchema, NativeLoginStartSchema, NativeProviderSchema,
  SaveRunConfigSchema, SaveScopeSchema, SelectProblemsSchema, SelectOptionSchema, SaveDecisionSchema,
  type NativeLoginCompleteResult, type NativeLoginStartResult, type ResearchEvent,
  type SolutionView, type SourceDetail, type ValidationState, type WorkspaceState,
} from "../shared/ipc";

const api = {
  selectOption: (payload: { threadId: string; runId: string; solutionId: string }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_OPTION, SelectOptionSchema.parse(payload)),
  saveDecision: (payload: { threadId: string; solutionId: string; userDecision: string; observedResult: string }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_DECISION, SaveDecisionSchema.parse(payload)),
  getValidation: (): Promise<ValidationState> => ipcRenderer.invoke(IPC_CHANNELS.GET_VALIDATION),
  retryConnection: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RETRY_CONNECTION),
  getWorkspace: (): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.GET_WORKSPACE),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_DATA_FOLDER),
  openLogsFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_LOGS_FOLDER),
  createThread: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_THREAD, { title }),
  selectThread: (threadId: string): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.SELECT_THREAD, { threadId }),
  deleteThread: (threadId: string): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_THREAD, { threadId }),
  saveScope: (payload: { threadId: string; scope: NonNullable<WorkspaceState["scope"]> }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_SCOPE, SaveScopeSchema.parse(payload)),
  saveRunConfig: (payload: { threadId: string; config: NonNullable<WorkspaceState["runConfig"]>; presetName?: string }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, SaveRunConfigSchema.parse(payload)),
  saveFavoriteModel: (payload: { model: { providerId: string; modelId: string }; favorite: boolean }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_FAVORITE_MODEL, SaveFavoriteModelSchema.parse(payload)),
  startNativeLogin: (payload: { providerId: string; method: "browser" | "device" }): Promise<NativeLoginStartResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.NATIVE_LOGIN_START, NativeLoginStartSchema.parse(payload)),
  completeNativeLogin: (payload: { loginId: string }): Promise<NativeLoginCompleteResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, NativeLoginCompleteSchema.parse(payload)),
  cancelNativeLogin: (payload: { loginId: string; providerId: string }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, NativeLoginCancelSchema.parse(payload)),
  refreshNativeAccount: (providerId: string): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, NativeProviderSchema.parse({ providerId })),
  logoutNativeAccount: (providerId: string): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.NATIVE_LOGOUT, NativeProviderSchema.parse({ providerId })),
  startResearch: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.START_RESEARCH, { threadId }),
  cancelResearch: async (runId: string): Promise<WorkspaceState> => (await ipcRenderer.invoke(IPC_CHANNELS.CANCEL_RESEARCH, { runId })).workspace,
  resumeResearch: async (runId: string): Promise<WorkspaceState> => (await ipcRenderer.invoke(IPC_CHANNELS.RESUME_RESEARCH, { runId })).workspace,
  selectProblems: (payload: { threadId: string; problemIds: string[]; userProblem: string | null }): Promise<WorkspaceState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_PROBLEMS, SelectProblemsSchema.parse(payload)),
  exportResearch: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RESEARCH, ExportResearchRequestSchema.parse({ threadId })),
  exportIdeas: (threadId: string, format: "markdown" | "json" = "markdown") =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_IDEAS, ExportIdeasRequestSchema.parse({ threadId, format })),
  getSourceDetail: (sourceId: string): Promise<SourceDetail> => ipcRenderer.invoke(IPC_CHANNELS.GET_SOURCE_DETAIL, { sourceId }),
  getIdeaDetail: (ideaId: string): Promise<SolutionView> => ipcRenderer.invoke(IPC_CHANNELS.GET_IDEA_DETAIL, { ideaId }),
  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, { url }),
  onBackendEvent: (listener: (event: ResearchEvent) => void) => {
    const handler = (_: unknown, event: unknown) => { const parsed = ResearchEventSchema.safeParse(event); if (parsed.success) listener(parsed.data); };
    ipcRenderer.on(IPC_CHANNELS.BACKEND_EVENT, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BACKEND_EVENT, handler); };
  },
};

contextBridge.exposeInMainWorld("scraply", api);
export type ScraplyApi = typeof api;
