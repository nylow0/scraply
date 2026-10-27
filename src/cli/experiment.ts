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

export function experimentEnvironment(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => PASSED_VARIABLES.has(entry[0].toUpperCase()) && entry[1] !== undefined));
}

/**
 * Runs one experiment command and captures what it printed, so the ledger records the output
 * itself rather than an agent's account of it. The command runs without a shell, in `cwd`, and
 * its output streams to `notify` while it runs. It sees only the environment variables a program needs
 * to start (`experimentEnvironment`), never the caller's keys or tokens. stdout comes first in the record, then stderr
 * under a marker, then the exit code.
 */
export async function runExperimentCommand(command: readonly string[], options: {
  cwd: string; timeoutMs: number; env: Record<string, string | undefined>; notify: (text: string) => void;
}) {
  if (!command.length) throw new CliError("USAGE", "Give the command after --, such as: scraply experiment run --test T3 -- python analyze.py", 2);
  let child;
  try {
    child = Bun.spawn([...command], { cwd: options.cwd, env: experimentEnvironment(options.env), stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  } catch (error) {
    throw new CliError("RUN_FAILED", `Could not start ${command[0]}: ${error instanceof Error ? error.message : "unknown error"}. Check that it is installed and on PATH.`);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      const part = decoder.decode(chunk, { stream: true });
      text += part;
      options.notify(part.replace(/\n$/, ""));
    }
    return text + decoder.decode();
  };
  const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const footer = timedOut ? `\n[stopped after ${Math.round(options.timeoutMs / 60_000)} minutes; exit code ${exitCode}]` : `\n[exit code ${exitCode}]`;
  const output = `${stdout}${stderr.trim() ? `\n--- stderr ---\n${stderr}` : ""}${footer}`;
  return {
    command: command.join(" "), exitCode: timedOut ? -1 : exitCode,
    ...(output.length > MAX_SOURCE_CHARS ? { output: `${output.slice(0, MAX_SOURCE_CHARS - footer.length)}${footer}`, truncated: true } : { output }),
  };
}
