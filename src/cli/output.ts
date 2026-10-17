import { z } from "zod";
import { AppError } from "../shared/errors";
import { OwnerTransportError } from "../shared/owner-contracts";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export const CliErrorPayloadSchema = z.object({
  code: z.string().min(1), message: z.string().min(1), recovery: z.unknown().optional(), reference: z.string().optional(),
}).strict();
export const CliResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: CliErrorPayloadSchema }).strict(),
]);

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCode = 1,
    readonly recovery?: unknown,
    readonly reference?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof AppError) return new CliError(error.code, error.message, 1, error.recovery, error.reference);
  if (error instanceof OwnerTransportError) return normalizeCliError({ code: error.code, message: error.message, ...(error.recovery ? { recovery: error.recovery } : {}), ...(error.reference ? { reference: error.reference } : {}) });
  if (error instanceof z.ZodError) return new CliError("USAGE", `Invalid input: ${error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`, 2);
  const structured = error instanceof Error ? undefined : CliErrorPayloadSchema.safeParse(error);
  if (structured?.success) {
    const { code, message, recovery, reference } = structured.data;
    const exitCode = code === "CLIENT_TIMEOUT" || code === "OWNER_TIMEOUT" ? 5 : code.startsWith("OWNER_") ? 4 : 1;
    return new CliError(code, message, exitCode, recovery, reference);
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return new CliError("CLIENT_TIMEOUT", "Client deadline reached. Work already admitted may continue. Inspect its saved state before retrying.", 5);
  }
  return new CliError("internal_error", "The command failed. Inspect host status and logs before retrying.");
}

export function errorResponse(error: unknown) {
  const normalized = normalizeCliError(error);
  return {
    exitCode: normalized.exitCode,
    response: { ok: false as const, error: {
      code: normalized.code, message: normalized.message,
      ...(normalized.recovery === undefined ? {} : { recovery: normalized.recovery }),
      ...(normalized.reference === undefined ? {} : { reference: normalized.reference }),
    } },
  };
}

export function formatResponse(response: z.infer<typeof CliResponseSchema>, json: boolean): string {
  const checked = CliResponseSchema.parse(response);
  if (json) return `${JSON.stringify(checked)}\n`;
  if (checked.ok) return `${formatHumanValue(checked.data).join("\n")}\n`;
  const { code, message, recovery, reference } = checked.error;
  return [
    `${code}: ${message}`,
    ...(recovery === undefined ? [] : ["Recovery:", ...formatHumanValue(recovery, "  ")]),
    ...(reference === undefined ? [] : [`Reference: ${reference}`]),
    "",
  ].join("\n");
}

/** Human output traverses the same validated data without hiding fields or unknown values. */
function formatHumanValue(value: unknown, indent = ""): string[] {
  if (value === null) return [`${indent}null`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}[]`];
    return value.flatMap(item => {
      const [first, ...rest] = formatHumanValue(item, `${indent}  `);
      return [`${indent}- ${first!.slice(indent.length + 2)}`, ...rest];
    });
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return [`${indent}{}`];
    return entries.flatMap(([key, item]) => {
      const lines = formatHumanValue(item, `${indent}  `);
      if (lines.length === 1 && (item === null || typeof item !== "object")) {
        return [`${indent}${key}: ${lines[0]!.slice(indent.length + 2)}`];
      }
      return [`${indent}${key}:`, ...lines];
    });
  }
  return String(value).split(/\r?\n/).map(line => `${indent}${line}`);
}

export function createStreamWriter(write: (text: string) => void) {
  let started = false;
  return {
    get started() { return started; },
    start() { started = true; },
    write(value: unknown) {
      if (!started) throw new CliError("internal_error", "Streaming output was not started.");
      const line = JSON.stringify(value);
      if (line === undefined) throw new CliError("internal_error", "Cannot write an empty stream item.");
      write(`${line}\n`);
    },
  };
}
