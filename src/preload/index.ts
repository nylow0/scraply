import { contextBridge, ipcRenderer } from "electron";
import { createScraplyApi } from "../shared/scraply-api";
import { AppCommandSchema, IPC_CHANNELS, ResearchEventSchema } from "../shared/ipc";

contextBridge.exposeInMainWorld("scraply", createScraplyApi({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onAppCommand: (listener) => {
    const handler = (_: unknown, value: unknown) => {
      const parsed = AppCommandSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_CHANNELS.APP_COMMAND, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.APP_COMMAND, handler); };
  },
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
