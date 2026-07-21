import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type BackendReady, type ResearchEvent, type ValidationState, type WorkspaceState } from "../shared/ipc";

const api = {
  getBackend: (): Promise<BackendReady | null> => ipcRenderer.invoke(IPC_CHANNELS.GET_BACKEND),
  getValidation: (): Promise<ValidationState> => ipcRenderer.invoke(IPC_CHANNELS.GET_VALIDATION),
  getWorkspace: (): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.GET_WORKSPACE),
  saveSecrets: (opencodeApiKey: string, exaApiKey: string): Promise<ValidationState> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_SECRETS, { opencodeApiKey, exaApiKey }),
  importEnv: (): Promise<ValidationState> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ENV),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_DATA_FOLDER),
  createThread: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_THREAD, { title }),
  selectThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.SELECT_THREAD, { threadId }),
  deleteThread: (threadId: string): Promise<WorkspaceState> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_THREAD, { threadId }),
  submitIntake: (payload: { threadId: string; questionId: string; answer: string; skipped?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBMIT_INTAKE, payload),
  confirmBrief: (payload: { threadId: string; brief: WorkspaceState["brief"] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONFIRM_BRIEF, payload),
  saveRunConfig: (payload: { threadId: string; config: NonNullable<WorkspaceState["runConfig"]>; presetName?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, payload),
  saveFavoriteModel: (payload: { model: WorkspaceState["modelCatalog"]["favorites"][number]; favorite: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_FAVORITE_MODEL, payload),
  startResearch: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.START_RESEARCH, { threadId }),
  cancelResearch: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_RESEARCH, { runId }),
  resumeResearch: async (runId: string): Promise<WorkspaceState> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.RESUME_RESEARCH, { runId }) as { workspace: WorkspaceState };
    return result.workspace;
  },
  cancelIncompleteResearch: async (runId: string): Promise<WorkspaceState> => {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.CANCEL_INCOMPLETE_RESEARCH, { runId }) as { workspace: WorkspaceState };
    return result.workspace;
  },
  generateIdeas: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.GENERATE_IDEAS, { threadId }),
  rateIdea: (payload: { ideaId: string; rating: number; notes?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.RATE_IDEA, payload),
  exportIdeas: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_IDEAS, { threadId }),
  createBranch: (payload: { parentThreadId: string; ideaTitle: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_BRANCH, payload),
  onBackendEvent: (listener: (event: ResearchEvent) => void) => {
    const handler = (_: unknown, event: ResearchEvent) => listener(event);
    ipcRenderer.on(IPC_CHANNELS.BACKEND_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BACKEND_EVENT, handler);
  },
};

contextBridge.exposeInMainWorld("scraply", api);

export type ScraplyApi = typeof api;

declare global {
  interface Window {
    scraply: ScraplyApi;
  }
}
