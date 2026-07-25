import { contextBridge, ipcRenderer } from "electron";
import {
  ConfirmBriefSchema,
  CreateBranchRequestSchema,
  IPC_CHANNELS,
  RateIdeaSchema,
  ResearchEventSchema,
  SaveFavoriteModelSchema,
  SaveRunConfigSchema,
  type IdeaGenerationResponse,
  type IdeaRating,
  type ReportDetail,
  type ResearchEvent,
  type SourceDetail,
  type ValidationState,
  type WorkspaceState,
} from "../shared/ipc";
import type { Idea } from "../shared/schemas";

const api = {
  canImportEnv: Boolean(process.env.ELECTRON_RENDERER_URL) && process.env.SCRAPLY_E2E !== "1",
  getValidation: (): Promise<ValidationState> => ipcRenderer.invoke(IPC_CHANNELS.GET_VALIDATION),
  getWorkspace: (): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.GET_WORKSPACE),
  saveSecrets: (opencodeApiKey: string, exaApiKey: string): Promise<ValidationState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_SECRETS, { opencodeApiKey, exaApiKey }),
  importEnv: (): Promise<ValidationState> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ENV),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_DATA_FOLDER),
  openLogsFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_LOGS_FOLDER),
  createThread: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_THREAD, { title }),
  selectThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.SELECT_THREAD, { threadId }),
  deleteThread: (threadId: string): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_THREAD, { threadId }),
  submitIntake: (payload: { threadId: string; questionId: string; answer: string; skipped?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBMIT_INTAKE, payload),
  confirmBrief: (payload: { threadId: string; brief: NonNullable<WorkspaceState["brief"]> }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIRM_BRIEF, ConfirmBriefSchema.parse(payload)),
  saveRunConfig: (payload: { threadId: string; config: NonNullable<WorkspaceState["runConfig"]>; presetName?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, SaveRunConfigSchema.parse(payload)),
  saveFavoriteModel: (payload: { model: WorkspaceState["modelCatalog"]["favorites"][number]; favorite: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_FAVORITE_MODEL, SaveFavoriteModelSchema.parse(payload)),
  startResearch: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.START_RESEARCH, { threadId }),
  cancelResearch: async (runId: string): Promise<WorkspaceState> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.CANCEL_RESEARCH, { runId }) as { workspace: WorkspaceState };
    return result.workspace;
  },
  resumeResearch: async (runId: string): Promise<WorkspaceState> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.RESUME_RESEARCH, { runId }) as { workspace: WorkspaceState };
    return result.workspace;
  },
  cancelIncompleteResearch: async (runId: string): Promise<WorkspaceState> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.CANCEL_INCOMPLETE_RESEARCH, { runId }) as { workspace: WorkspaceState };
    return result.workspace;
  },
  generateIdeas: (runId: string, allowPartial = false): Promise<IdeaGenerationResponse & { workspace: WorkspaceState }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_IDEAS, { runId, allowPartial }),
  rateIdea: (payload: { ideaId: string; rating: number; notes?: string }): Promise<IdeaRating> =>
    ipcRenderer.invoke(IPC_CHANNELS.RATE_IDEA, RateIdeaSchema.parse(payload)),
  exportIdeas: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_IDEAS, { threadId }),
  createBranch: (payload: {
    parentThreadId: string;
    seedIdeaId: string;
    seedIdeaTitle: string;
    explorationAngle: string;
    selectedClaimIds: string[];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_BRANCH, CreateBranchRequestSchema.parse(payload)),
  getReportDetail: (reportId: string): Promise<ReportDetail> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_REPORT_DETAIL, { reportId }),
  getSourceDetail: (sourceId: string): Promise<SourceDetail> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SOURCE_DETAIL, { sourceId }),
  getIdeaDetail: (ideaId: string): Promise<Idea> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_IDEA_DETAIL, { ideaId }),
  openExternalUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, { url }),
  onBackendEvent: (listener: (event: ResearchEvent) => void) => {
    const handler = (_: unknown, event: unknown) => {
      const parsed = ResearchEventSchema.safeParse(event);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_CHANNELS.BACKEND_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BACKEND_EVENT, handler);
  },
};

contextBridge.exposeInMainWorld("scraply", api);

export type ScraplyApi = typeof api;
