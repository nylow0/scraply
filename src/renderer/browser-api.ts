import { z } from "zod";
import { createScraplyApi } from "../shared/scraply-api";
import { IPC_CHANNELS, ResearchEventSchema } from "../shared/ipc";

const DownloadsSchema = z.object({ downloads: z.array(z.object({ filename: z.string(), content: z.string() })) });

/** Only loaded by the browser dev entry; production continues to use the preload bridge. */
export function installBrowserApi(): void {
  window.scraply = createScraplyApi({
    async invoke<T>(channel: string, payload?: unknown): Promise<T> {
      const response = await fetch("/__scraply_dev/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, args: payload === undefined ? [] : [payload] }),
      });
      const body: unknown = await response.json();
      const result = z.object({ data: z.unknown().optional(), error: z.string().optional() }).parse(body);
      if (!response.ok) throw new Error(result.error ?? "The development backend is unavailable.");
      if (channel === IPC_CHANNELS.EXPORT_RESEARCH || channel === IPC_CHANNELS.EXPORT_IDEAS) {
        const { downloads } = DownloadsSchema.parse(result.data);
        for (const file of downloads) {
          const url = URL.createObjectURL(new Blob([file.content], { type: "application/octet-stream" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = file.filename.replace(/[^a-zA-Z0-9._-]/g, "-");
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        return { cancelled: false, file: "browser downloads", directory: "browser downloads", files: downloads.map(file => file.filename) } as T;
      }
      return result.data as T;
    },
    onBackendEvent(listener) {
      const events = new EventSource("/__scraply_dev/events");
      events.onmessage = (message) => {
        const parsed = ResearchEventSchema.safeParse(JSON.parse(message.data));
        if (parsed.success) listener(parsed.data);
      };
      return () => events.close();
    },
  });
}
