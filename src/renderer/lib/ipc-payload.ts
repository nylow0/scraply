/** Strip Svelte reactive proxies before Electron IPC structured clone. */
export function ipcPayload<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return structuredClone(value);
}
