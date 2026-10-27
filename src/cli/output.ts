import { z } from "zod";

/** 0 success, 1 rule or provider failure, 2 usage error. */
export type ExitCode = 0 | 1 | 2;

const ResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict() }).strict(),
]);
type Response = z.infer<typeof ResponseSchema>;

/** A failure the caller can act on. The message always says what to do next. */
export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: ExitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

export function errorResponse(error: unknown): { exitCode: ExitCode; response: Response } {
  const normalized = error instanceof CliError ? error
    : error instanceof z.ZodError
      ? new CliError("USAGE", `Invalid input: ${error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`, 2)
      : new CliError("INTERNAL", error instanceof Error ? error.message : "The command failed.");
  return { exitCode: normalized.exitCode, response: { ok: false, error: { code: normalized.code, message: normalized.message } } };
}

/** Agents get one JSON envelope per command; a terminal gets the same data as indented text. */
export function formatResponse(response: Response, json: boolean): string {
  const checked = ResponseSchema.parse(response);
  if (json) return `${JSON.stringify(checked)}\n`;
  if (checked.ok) return `${formatHuman(checked.data).join("\n")}\n`;
  return `${checked.error.code}: ${checked.error.message}\n`;
}

function formatHuman(value: unknown, indent = ""): string[] {
  if (value === null || value === undefined) return [`${indent}-`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}(none)`];
    return value.flatMap(item => {
      const [first, ...rest] = formatHuman(item, `${indent}  `);
      return [`${indent}- ${first!.slice(indent.length + 2)}`, ...rest];
    });
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const lines = formatHuman(item, `${indent}  `);
      return lines.length === 1 && (item === null || typeof item !== "object")
        ? [`${indent}${key}: ${lines[0]!.slice(indent.length + 2)}`]
        : [`${indent}${key}:`, ...lines];
    });
  }
  return String(value).split(/\r?\n/).map(line => `${indent}${line}`);
}
