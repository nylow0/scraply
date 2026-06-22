/** Strip Svelte reactive proxies before Electron IPC structured clone. */
export function ipcPayload<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
