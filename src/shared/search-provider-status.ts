import type { ValidationState } from "./ipc";

export function isSearchProviderChecking(status: ValidationState["exa"]): boolean {
  // Older status snapshots expressed pending checks only through their message.
  return status.checking ?? (status.checked !== false && status.error?.startsWith("Checking ") === true);
}

// Reading saved credentials does not test them. Both launch paths may use an explicitly
// configured, unverified key, but a pending or rejected check must block that provider.
export function isSearchProviderReady(status: ValidationState["exa"]): boolean {
  return !isSearchProviderChecking(status) && status.configured !== false
    && (status.valid || (status.configured === true && status.checked === false));
}
