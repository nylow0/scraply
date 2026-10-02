import { z } from "zod";

export const AppSettingsSchema = z.object({
  reasoningSummaries: z.boolean().default(true),
  // The 30-call xhigh transport measurement supported two overlapping calls with stable latency.
  maxConcurrentModelCalls: z.number().int().min(1).max(6).default(6),
}).strict();

export type AppSettings = z.infer<typeof AppSettingsSchema>;
