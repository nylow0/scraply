import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface CodexProbeResult {
  detected: boolean;
  compatible: boolean;
  version?: string;
  error?: string;
}

const CODEX_CANDIDATES = process.platform === "win32"
  ? ["codex.exe", "codex.cmd", "codex"]
  : ["codex"];
const DEFAULT_CODEX_MODELS = ["gpt-5.5", "gpt-5", "gpt-5-codex", "o4-mini", "o3"];

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
  timeoutMs = 180_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex exec timed out"));
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
    child.stdin.end(input);
  });
}

export async function probeCodexCli(): Promise<CodexProbeResult> {
  const executable = await findCodexExecutable();
  if (!executable) {
    return { detected: false, compatible: false, error: "Codex CLI not found on PATH" };
  }
  try {
    const versionRun = await runCommand(executable, ["--version"]);
    const version = (versionRun.stdout || versionRun.stderr).trim() || undefined;
    const helpRun = await runCommand(executable, ["--help"]);
    const help = `${helpRun.stdout}\n${helpRun.stderr}`;
    const supportsNonInteractive = /--json|--output-format|non-interactive|exec/i.test(help);
    return {
      detected: true,
      compatible: supportsNonInteractive,
      ...(version ? { version } : {}),
      ...(!supportsNonInteractive ? { error: "Installed Codex CLI lacks a verified non-interactive contract" } : {}),
    };
  } catch (error) {
    return {
      detected: true,
      compatible: false,
      error: error instanceof Error ? error.message : "Codex probe failed",
    };
  }
}

export async function listCodexModels(): Promise<string[]> {
  const configured = await readConfiguredModel().catch(() => null);
  return unique([configured, ...DEFAULT_CODEX_MODELS].filter(Boolean) as string[]);
}

export class CodexClient {
  async structuredCompletion<T>(
    model: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    jsonSchema: object,
  ): Promise<T> {
    const executable = await findCodexExecutable();
    if (!executable) throw new Error("Codex CLI not found on PATH");

    const dir = await mkdtemp(join(tmpdir(), "scraply-codex-"));
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

    const result = await runCommandWithInput(executable, [
      "exec",
      "-",
      "--model", model,
      "--cd", process.cwd(),
      "--sandbox", "read-only",
      "--ephemeral",
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
      "--color", "never",
    ], prompt);

    if (result.code !== 0) {
      throw new Error(`Codex exec failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
    }

    const raw = await readFile(outputPath, "utf8");
    return parseStructured(raw, schema);
  }
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
