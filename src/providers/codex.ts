import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProviderFailure, type StructuredCallOptions, type StructuredModelClient } from "./structured";

export interface CodexProbeResult {
  detected: boolean;
  compatible: boolean;
  version?: string;
  error?: string;
}

const CODEX_CANDIDATES = process.platform === "win32"
  ? ["codex.exe", "codex.cmd", "codex"]
  : ["codex"];
const DEFAULT_CODEX_MODELS = ["gpt-5.6-luna", "gpt-5.5", "gpt-5", "gpt-5-codex", "o4-mini", "o3"];
const MAX_CAPTURED_OUTPUT = 1_000_000;
const PROBE_CACHE_MS = 60_000;
let probeCache: { expiresAt: number; result: CodexProbeResult } | null = null;

async function findCodexExecutable(): Promise<string | null> {
  const configured = process.env.CODEX_CLI_PATH;
  if (configured && await canExecute(configured)) return configured;

  const pathEnv = process.env.PATH ?? "";
  const segments = pathEnv.split(process.platform === "win32" ? ";" : ":");
  for (const dir of segments) {
    for (const name of CODEX_CANDIDATES) {
      const full = `${dir}\\${name}`.replace(/\\\\/g, "\\");
      if (await canExecute(full)) return full;
    }
  }
  return null;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex probe timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runCommandWithInput(
  command: string,
  args: string[],
  input: string,
  options: StructuredCallOptions & { cwd: string } = { cwd: process.cwd() },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProviderFailure("cancelled", "Codex request was cancelled", false));
      return;
    }
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      settled = true;
      reject(new ProviderFailure("timeout", "Codex request timed out", true));
    }, options.timeoutMs ?? 120_000);
    const onAbort = () => {
      child.kill();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new ProviderFailure("cancelled", "Codex request was cancelled", false));
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(new ProviderFailure("unavailable", "Codex CLI could not be started", true, { cause: error }));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
    child.stdin.end(input);
  });
}

export async function probeCodexCli(): Promise<CodexProbeResult> {
  if (probeCache && probeCache.expiresAt > Date.now()) return probeCache.result;
  const executable = await findCodexExecutable();
  if (!executable) {
    return cacheProbe({ detected: false, compatible: false, error: "Codex CLI not found on PATH" });
  }
  try {
    const versionRun = await runCommand(executable, ["--version"]);
    const version = (versionRun.stdout || versionRun.stderr).trim() || undefined;
    const helpRun = await runCommand(executable, ["--help"]);
    const help = `${helpRun.stdout}\n${helpRun.stderr}`;
    const supportsNonInteractive = /--json|--output-format|non-interactive|exec/i.test(help);
    if (!supportsNonInteractive) {
      return cacheProbe({
        detected: true,
        compatible: false,
        ...(version ? { version } : {}),
        error: "Installed Codex CLI lacks a verified non-interactive contract",
      });
    }

    const ProbeSchema = z.object({ ok: z.literal(true) });
    await new CodexClient().structuredCompletion(
      "gpt-5.6-luna",
      "You are a setup verifier.",
      "Return an object with ok set to true.",
      ProbeSchema,
      {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
      { timeoutMs: 30_000 },
    );
    return cacheProbe({ detected: true, compatible: true, ...(version ? { version } : {}) });
  } catch (error) {
    const message = error instanceof ProviderFailure
      ? error.code === "auth"
        ? "Codex CLI is not authenticated"
        : error.code === "timeout"
          ? "Codex Luna setup probe timed out"
          : "Codex Luna setup probe failed"
      : "Codex setup probe failed";
    return cacheProbe({
      detected: true,
      compatible: false,
      error: message,
    });
  }
}

function cacheProbe(result: CodexProbeResult): CodexProbeResult {
  probeCache = { expiresAt: Date.now() + PROBE_CACHE_MS, result };
  return result;
}

export async function listCodexModels(): Promise<string[]> {
  const configured = await readConfiguredModel().catch(() => null);
  return unique([configured, ...DEFAULT_CODEX_MODELS].filter(Boolean) as string[]);
}

export class CodexClient implements StructuredModelClient {
  async structuredCompletion<T>(
    model: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    jsonSchema: object,
    options: StructuredCallOptions = {},
  ): Promise<T> {
    const executable = await findCodexExecutable();
    if (!executable) throw new ProviderFailure("unavailable", "Codex CLI not found on PATH", false);

    const dir = await mkdtemp(join(tmpdir(), "scraply-codex-"));
    try {
      const outputPath = join(dir, "last-message.json");
      const schemaPath = join(dir, "schema.json");
      await writeFile(schemaPath, JSON.stringify(strictJsonSchema(jsonSchema)), "utf8");

      const prompt = [
        system,
        "",
        "Return only a JSON object matching the provided output schema. Do not use markdown.",
        "Do not edit files or run shell commands. Generate the requested content directly from the prompt.",
        "",
        user,
      ].join("\n");

      const result = await runCommandWithInput(executable, buildCodexExecArgs(model, dir, schemaPath, outputPath), prompt, {
        ...options,
        cwd: dir,
      });
      if (result.code !== 0) throw classifyCodexFailure(result.stderr || result.stdout, result.code);

      const raw = await readFile(outputPath, "utf8");
      try {
        return parseStructured(raw, schema);
      } catch (error) {
        throw new ProviderFailure("schema", "Codex returned output that did not match the schema", false, { cause: error });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function buildCodexExecArgs(model: string, cwd: string, schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "-",
    "--model", model,
    "--cd", cwd,
    "--sandbox", "read-only",
    "--ephemeral",
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "--color", "never",
    "-c", 'model_reasoning_effort="medium"',
  ];
}

async function readConfiguredModel(): Promise<string | null> {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return null;
  const text = await readFile(join(home, ".codex", "config.toml"), "utf8");
  const match = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}

function parseStructured<T>(raw: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(extractJson(raw)));
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function strictJsonSchema(value: object): object;
function strictJsonSchema(value: unknown): unknown;
function strictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictJsonSchema);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) next[key] = strictJsonSchema(child);
  if (next.type === "object") next.additionalProperties ??= false;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function appendBounded(current: string, chunk: unknown): string {
  if (current.length >= MAX_CAPTURED_OUTPUT) return current;
  return (current + String(chunk)).slice(0, MAX_CAPTURED_OUTPUT);
}

function classifyCodexFailure(output: string, code: number | null): ProviderFailure {
  const normalized = output.toLowerCase();
  if (/unauthorized|authentication|log in|login required/.test(normalized)) {
    return new ProviderFailure("auth", "Codex CLI is not authenticated", false);
  }
  if (/rate.?limit|too many requests|\b429\b/.test(normalized)) {
    return new ProviderFailure("rate-limit", "Codex rate limit reached", true);
  }
  return new ProviderFailure("failed", `Codex execution failed (${code ?? "unknown"})`, true);
}
