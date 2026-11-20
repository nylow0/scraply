#!/usr/bin/env bun
import { parseArguments, stringFlag } from "./args";
import { commandContext, commands, describeCommands } from "./commands";
import { errorResponse, formatResponse, type ExitCode } from "./output";

export interface CliOptions {
  write?: (text: string) => void;
  /** Progress and instructions for the person at the terminal; stdout stays one JSON envelope. */
  notify?: (text: string) => void;
  readStdin?: () => Promise<string>;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}

/**
 * Run one `scraply` command and return its exit code. Output is a JSON envelope
 * (`{ok, data}` or `{ok: false, error}`) whenever stdout is piped, which is how agents call it.
 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<ExitCode> {
  const write = options.write ?? (text => { process.stdout.write(text); });
  let json = argv.includes("--json") || !(options.isTTY ?? process.stdout.isTTY);
  let close: (() => void) | undefined;
  try {
    const parsed = parseArguments(argv, commands);
    if (parsed.help || !parsed.command) {
      write(formatResponse({ ok: true, data: describeCommands(parsed.helpPath) }, json));
      return 0;
    }
    json ||= parsed.args.flags.json === true;
    const opened = commandContext({ ...options, dataDir: stringFlag(parsed.args, "data-dir") });
    close = opened.close;
    const data = await parsed.command.run(opened.context, parsed.args);
    // `scraply mcp` owns stdout for its JSON-RPC session; an envelope after it would be a stray message.
    if (parsed.command.path[0] !== "mcp") write(formatResponse({ ok: true, data }, json));
    return 0;
  } catch (error) {
    const { exitCode, response } = errorResponse(error);
    write(formatResponse(response, json));
    return exitCode;
  } finally {
    close?.();
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
