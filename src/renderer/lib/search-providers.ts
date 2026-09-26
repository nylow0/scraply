import type { ValidationState } from "../../shared/ipc";
import type { SearchProvider } from "../../shared/schemas";

// Display names and the page where each provider issues API keys, for Settings and the welcome prompt.
export const SEARCH_PROVIDERS = [
  { id: "exa", name: "Exa", keyUrl: "https://dashboard.exa.ai/api-keys" },
  { id: "perplexity", name: "Perplexity", keyUrl: "https://console.perplexity.ai/project/keys" },
] as const satisfies ReadonlyArray<{ id: SearchProvider; name: string; keyUrl: string }>;

export type SearchKeyStatus = ValidationState["exa"];

// A key is saved when the backend reports its masked tail. A valid status also counts, because
// a connected provider necessarily has a key even if the status predates masked keys.
export function hasSearchKey(status: SearchKeyStatus): boolean {
  return status.valid || Boolean(status.maskedKey);
}
