import { z } from "zod";
import type { Source } from "../shared/schemas";
import type { ExaCategory } from "./exa";

export const SearchProviderSchema = z.enum(["exa", "perplexity"]);

export type SearchProvider = z.infer<typeof SearchProviderSchema>;

export interface SearchOptions {
  numResults?: number;
  maxCharacters?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: ExaCategory;
  languages?: string[];
  userLocation?: string;
  startPublishedDate?: string;
  /** Caller metadata; providers send only their supported parameters. */
  provider?: SearchProvider;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ValidationResult = { valid: true } | { valid: false; error: string };

export interface SearchClient {
  readonly provider: SearchProvider;
  search(query: string, options?: SearchOptions): Promise<Source[]>;
  validateKey(): Promise<ValidationResult>;
}
