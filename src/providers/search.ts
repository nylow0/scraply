import { z } from "zod";
import type { Source } from "../shared/schemas";
import type { ExaCategory } from "./exa";
import type { SourceRoute } from "./source-routes";

export const SearchProviderSchema = z.enum(["exa", "perplexity"]);

export type SearchProvider = z.infer<typeof SearchProviderSchema>;
export const SearchProviderChoiceSchema = z.enum(["auto", "exa", "perplexity"]);
export type SearchProviderChoice = z.infer<typeof SearchProviderChoiceSchema>;

export interface SearchOptions {
  numResults?: number;
  maxCharacters?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: ExaCategory;
  languages?: string[];
  userLocation?: string;
  startPublishedDate?: string;
  /** Coordinator metadata; providers send only their supported parameters. */
  provider?: SearchProvider;
  route?: SourceRoute;
  legacySearchOptions?: Pick<SearchOptions, "numResults" | "maxCharacters" | "includeDomains" | "startPublishedDate" | "category">;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ValidationResult = { valid: true } | { valid: false; error: string };

export interface SearchClient {
  readonly provider: SearchProvider;
  providerForRoute?(route?: SourceRoute): SearchProvider;
  search(query: string, options?: SearchOptions): Promise<Source[]>;
  validateKey(): Promise<ValidationResult>;
}
