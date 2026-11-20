import { z } from "zod";

/** One search result as a provider returned it, before the CLI saves it to the ledger. */
export const SourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  text: z.string().min(1),
  author: z.string().min(1).optional(),
  publishedDate: z.string().min(1).optional(),
});

export type Source = z.infer<typeof SourceSchema>;
