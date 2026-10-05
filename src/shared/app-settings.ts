import { z } from "zod";

export const AppSettingsSchema = z.object({
  // The 30-call xhigh transport measurement supported two overlapping calls with stable latency.
  maxConcurrentModelCalls: z.number().int().min(1).max(3).default(2),
}).strict();

export type AppSettings = z.infer<typeof AppSettingsSchema>;
