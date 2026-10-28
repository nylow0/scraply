#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArguments, stringFlag } from "./args";
import { commands, describeCommands, type CommandContext } from "./commands";
import { openLedger, type Ledger } from "./ledger";
import { openModelSession, type ModelSession } from "./model";
import { errorResponse, formatResponse, type ExitCode } from "./output";

export interface CliOptions {
  write?: (text: string) => void;
  /** Progress and instructions for the person at the terminal; stdout stays one JSON envelope. */
  notify?: (text: string) => void;
  readStdin?: () => Promise<string>;
  openUrl?: (url: string) => void;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  /** Replaces the model worker in tests. */
  models?: () => Promise<ModelSession>;
}

/** Open a URL in the default browser without passing it through a shell. */
function openInBrowser(url: string) {
  spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * Run one `scraply` command and return its exit code. Output is a JSON envelope
 * (`{ok, data}` or `{ok: false, error}`) whenever stdout is piped, which is how agents call it.
 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<ExitCode> {
  const write = options.write ?? (text => { process.stdout.write(text); });
  const env = options.env ?? process.env;
  let json = argv.includes("--json") || !(options.isTTY ?? process.stdout.isTTY);
  let ledger: Ledger | undefined;
  let session: Promise<ModelSession> | undefined;
  try {
    const parsed = parseArguments(argv, commands);
    if (parsed.help || !parsed.command) {
      write(formatResponse({ ok: true, data: describeCommands(parsed.helpPath) }, json));
      return 0;
    }
    json ||= parsed.args.flags.json === true;
    const appData = env.APPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Roaming");
    const profileDir = join(appData, "scraply");
    const dataDir = stringFlag(parsed.args, "data-dir") ?? env.SCRAPLY_DATA_DIR ?? join(profileDir, "cli");
    const context: CommandContext = {
      ledger: () => (ledger ??= openLedger(dataDir)),
      models: () => (session ??= options.models?.() ?? openModelSession(profileDir, env)),
      dataDir, profileDir, env, fetcher: options.fetcher ?? fetch,
      notify: options.notify ?? (text => { process.stderr.write(`${text}\n`); }),
      readStdin: options.readStdin ?? (() => Bun.stdin.text()),
      openUrl: options.openUrl ?? openInBrowser,
    };
    const data = await parsed.command.run(context, parsed.args);
    write(formatResponse({ ok: true, data }, json));
    return 0;
  } catch (error) {
    const { exitCode, response } = errorResponse(error);
    write(formatResponse(response, json));
    return exitCode;
  } finally {
    ledger?.close();
    await session?.then(open => open.close(), () => undefined);
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
