import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

export interface CodexProbeResult {
  detected: boolean;
  compatible: boolean;
  version?: string;
  error?: string;
}

const CODEX_CANDIDATES = ["codex", "codex.cmd"];

async function findCodexExecutable(): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const segments = pathEnv.split(process.platform === "win32" ? ";" : ":");
  for (const dir of segments) {
    for (const name of CODEX_CANDIDATES) {
      const full = `${dir}\\${name}`.replace(/\\\\/g, "\\");
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        // continue
      }
    }
  }
  return null;
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
