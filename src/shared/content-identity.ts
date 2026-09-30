import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A provider is part of new search identities; omitting it reproduces old saved keys. */
export function workflowSearchKey(query: string, parameters: unknown, provider?: string): string {
  const normalized = query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return `search:${sha256(canonicalJson({ query: normalized, parameters, ...(provider ? { provider } : {}) }))}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalValue(object[key])]));
  }
  throw new Error("Canonical JSON cannot contain a non-JSON value");
}
