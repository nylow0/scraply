import { z } from "zod";
import type { Source } from "../shared/schemas";

export const SearchProviderSchema = z.enum(["exa", "perplexity"]);

export type SearchProvider = z.infer<typeof SearchProviderSchema>;

export interface SearchOptions {
  numResults?: number;
  maxCharacters?: number;
  includeDomains?: string[];
  startPublishedDate?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ValidationResult = { valid: true } | { valid: false; error: string };

export interface SearchClient {
  readonly provider: SearchProvider;
  search(query: string, options?: SearchOptions): Promise<Source[]>;
  validateKey(): Promise<ValidationResult>;
}
