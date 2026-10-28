import { basename } from "node:path";
import { MAX_SOURCE_CHARS } from "./ledger";
import { CliError } from "./output";

/**
 * The variables a program needs to start and find its tools on Windows. Experiments get only
 * these, so API keys and tokens in the caller's environment never reach model-written code.
 */
const PASSED_VARIABLES = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "OS", "LANG", "UV_CACHE_DIR", "BUN_INSTALL",
]);

/** How much of the end of a long output is kept: programs usually print their results last. */
const TAIL_CHARS = 20_000;

export function experimentEnvironment(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => PASSED_VARIABLES.has(entry[0].toUpperCase()) && entry[1] !== undefined));
}

/** The start and the end of `text` within `max` characters, with the size of the gap between them. */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const marker = (left: number) => `\n[... ${left} characters left out ...]\n`;
  const head = max - TAIL_CHARS - marker(text.length).length;
  return `${text.slice(0, head)}${marker(text.length - head - TAIL_CHARS)}${text.slice(-TAIL_CHARS)}`;
}

/**
 * Runs one experiment command and captures what it printed, so the ledger records the output
 * itself rather than an agent's account of it. The command runs without a shell, in `cwd`, and
 * its output streams to `notify` while it runs. It sees only the environment variables a program needs
 * to start (`experimentEnvironment`), never the caller's keys or tokens. stdout comes first in the record, then stderr
 * under a marker, then the exit code. A long output keeps its start and its end.
 */
export async function runExperimentCommand(command: readonly string[], options: {
  cwd: string; timeoutMs: number; env: Record<string, string | undefined>; notify: (text: string) => void;
}) {
  if (!command.length) throw new CliError("USAGE", "Give the command after --, such as: scraply experiment run --test T3 -- python analyze.py", 2);
  // Bun loads a .env file from the folder it runs in, which would bring keys back after the scrub.
  const argv = /^bun(\.exe)?$/i.test(basename(command[0]!)) ? [command[0]!, "--no-env-file", ...command.slice(1)] : [...command];
  let child;
  try {
    child = Bun.spawn(argv, { cwd: options.cwd, env: experimentEnvironment(options.env), stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  } catch (error) {
    throw new CliError("RUN_FAILED", `Could not start ${command[0]}: ${error instanceof Error ? error.message : "unknown error"}. Check that it is installed and on PATH.`);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  let cut = false;
  // Holds at most the start and the end of the stream, so a noisy program cannot exhaust memory.
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let head = "";
    let tail = "";
    let left = 0;
    for await (const chunk of stream) {
      const part = decoder.decode(chunk, { stream: true });
      options.notify(part.replace(/\n$/, ""));
      if (head.length < MAX_SOURCE_CHARS) { head += part; continue; }
      tail += part;
      if (tail.length > TAIL_CHARS) { left += tail.length - TAIL_CHARS; tail = tail.slice(-TAIL_CHARS); }
    }
    tail += decoder.decode();
    if (left) cut = true;
    return left ? `${head}\n[... ${left} characters left out ...]\n${tail}` : head + tail;
  };
  const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const footer = timedOut ? `\n[stopped after ${Math.round(options.timeoutMs / 60_000)} minutes; exit code ${exitCode}]` : `\n[exit code ${exitCode}]`;
  const printed = `${stdout}${stderr.trim() ? `\n--- stderr ---\n${stderr}` : ""}`;
  const output = clip(printed, MAX_SOURCE_CHARS - footer.length) + footer;
  return {
    command: command.join(" "), exitCode: timedOut ? -1 : exitCode, output,
    ...(cut || printed.length > MAX_SOURCE_CHARS - footer.length ? { truncated: true } : {}),
  };
}
