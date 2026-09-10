import { contextBridge, ipcRenderer } from "electron";
import { createScraplyApi } from "../shared/scraply-api";
import { IPC_CHANNELS, ResearchEventSchema } from "../shared/ipc";

contextBridge.exposeInMainWorld("scraply", createScraplyApi({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onBackendEvent: (listener) => {
    const handler = (_: unknown, event: unknown) => {
      const parsed = ResearchEventSchema.safeParse(event);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_CHANNELS.BACKEND_EVENT, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.BACKEND_EVENT, handler); };
  },
}));

export type { ScraplyApi } from "../shared/scraply-api";
