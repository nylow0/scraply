export type LogLevel = "info" | "warn" | "error";
export type LogComponent = "main" | "backend" | "renderer";

export interface LogInput {
  level: LogLevel;
  component: LogComponent;
  event: string;
  message?: string;
  context?: Record<string, unknown>;
  error?: unknown;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  component: LogComponent;
  event: string;
  appVersion: string;
  message?: string;
  context?: Record<string, string | number | boolean | null>;
  error?: { name: string; message: string; stack?: string };
}

const ALLOWED_CONTEXT_KEYS = new Set([
  "requestId",
  "correlationId",
  "runId",
  "threadId",
  "route",
  "method",
  "status",
  "durationMs",
  "code",
  "signal",
  "reason",
  "exitCode",
  "processType",
  "version",
  "migration",
]);

function sanitizeText(value: string, secrets: readonly string[], maxLength: number): string {
  let sanitized = value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]");
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  return sanitized.slice(0, maxLength);
}

function sanitizeContext(
  context: Record<string, unknown> | undefined,
  secrets: readonly string[],
): Record<string, string | number | boolean | null> | undefined {
  if (!context) return undefined;
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!ALLOWED_CONTEXT_KEYS.has(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") sanitized[key] = value;
    else if (typeof value === "string") sanitized[key] = sanitizeText(value, secrets, 1_000);
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeError(error: unknown, secrets: readonly string[]): LogRecord["error"] | undefined {
  if (!(error instanceof Error)) return undefined;
  return {
    name: sanitizeText(error.name, secrets, 128),
    message: sanitizeText(error.message, secrets, 2_000),
    ...(error.stack ? { stack: sanitizeText(error.stack, secrets, 8_000) } : {}),
  };
}

export function createLogRecord(
  input: LogInput,
  appVersion: string,
  secrets: readonly string[] = [],
  timestamp = new Date().toISOString(),
): LogRecord {
  const context = sanitizeContext(input.context, secrets);
  const error = sanitizeError(input.error, secrets);
  return {
    timestamp,
    level: input.level,
    component: input.component,
    event: sanitizeText(input.event, secrets, 128),
    appVersion,
    ...(input.message ? { message: sanitizeText(input.message, secrets, 2_000) } : {}),
    ...(context ? { context } : {}),
    ...(error ? { error } : {}),
  };
}
