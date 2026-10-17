import { spawn } from "node:child_process";
import packageJson from "../../package.json";
import { booleanFlag, parseArguments, stringFlag } from "./args";
import { createCommandContext, abortable, type ContextDependencies } from "./context";
import { CliError, errorResponse, formatResponse, type ExitCode } from "./output";
import type { CommandDefinition } from "./registry";

export interface CliDependencies {
  commands?: readonly CommandDefinition[];
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  isTTY?: boolean;
  stdin?: () => Promise<string>;
  context?: (dependencies: ContextDependencies) => ReturnType<typeof createCommandContext>;
  system?: ContextDependencies["system"];
  invoke?: ContextDependencies["invoke"];
  subscribe?: ContextDependencies["subscribe"];
  openExternal?: ContextDependencies["openExternal"];
  signal?: AbortSignal;
}

/** Parse help/version before resolving a profile or importing the owner host. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<ExitCode> {
  const write = dependencies.stdout ?? (text => { process.stdout.write(text); });
  const log = dependencies.stderr ?? (text => { process.stderr.write(text); });
  let json = argv.includes("--json") || !(dependencies.isTTY ?? process.stdout.isTTY);
  let streaming = false;
  const controller = new AbortController();
  const detach = () => { controller.abort(new CliError("CLIENT_TIMEOUT", "Client detached. Work already admitted may continue. Inspect its saved state before retrying.", 5)); };
  const inheritAbort = () => { controller.abort(dependencies.signal?.reason as unknown); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (dependencies.signal?.aborted) inheritAbort();
  else dependencies.signal?.addEventListener("abort", inheritAbort, { once: true });
  try {
    if (argv[0] === "__host") {
      const parsed = parseArguments(argv.slice(1), []);
      if (parsed.helpPath.length) throw new CliError("USAGE", "Internal host accepts only global flags.", 2);
      const { runHostCommand } = await import("./host");
      return await runHostCommand({
        version: packageJson.version,
        ...(stringFlag(parsed.args, "data-dir") ? { profileDir: stringFlag(parsed.args, "data-dir")! } : {}),
      });
    }
    const registry = await import("./registry");
    const definitions = dependencies.commands ?? registry.commands;
    const parsed = parseArguments(argv, definitions);
    json = booleanFlag(parsed.args, "json") || !(dependencies.isTTY ?? process.stdout.isTTY);
    if (parsed.version) {
      write(formatResponse({ ok: true, data: { version: packageJson.version } }, json));
      return 0;
    }
    if (parsed.help || !parsed.command) {
      write(formatResponse({ ok: true, data: registry.describeCommands(definitions, parsed.helpPath) }, json));
      return 0;
    }
    const timeoutMs = Number(stringFlag(parsed.args, "timeout") ?? 120_000);
    const deadline = Date.now() + timeoutMs;
    timer = setTimeout(() => controller.abort(new CliError("CLIENT_TIMEOUT", "Client deadline reached. Work already admitted may continue. Inspect its saved state before retrying.", 5)), timeoutMs);
    process.once("SIGINT", detach);
    process.once("SIGTERM", detach);
    let profile: Awaited<ReturnType<typeof import("../app/profile")["resolveProfile"]>> | undefined;
    let owner: Awaited<ReturnType<typeof import("./connect")["connectOwner"]>> | undefined;
    async function getProfile() {
      if (!profile) {
        const { resolveProfile } = await import("../app/profile");
        const dataDir = stringFlag(parsed.args, "data-dir");
        profile = await resolveProfile(dataDir ? { dataDir } : {});
      }
      return profile;
    }
    async function getOwner() {
      if (!owner) {
        const selected = await getProfile();
        const { connectOwner } = await import("./connect");
        owner = await connectOwner({ profileDir: selected.profileDir, version: packageJson.version, timeoutMs: Math.max(1, deadline - Date.now()) });
      }
      return owner;
    }
    const context = (dependencies.context ?? createCommandContext)({
      commandPath: parsed.command.path,
      signal: controller.signal, deadline, write: text => { streaming = true; write(text); },
      readStdin: dependencies.stdin ?? (() => readStandardInput(controller.signal)),
      invoke: dependencies.invoke ?? (async (channel, payload) => (await getOwner()).invoke(channel, payload, { signal: controller.signal })),
      subscribe: dependencies.subscribe ?? (async (listener, signal) => (await getOwner()).subscribe(listener, { signal })),
      openExternal: dependencies.openExternal ?? openAuthorizationUrl,
      system: dependencies.system ?? (async (action, args) => {
        if (action === "setup") {
          const { setupCli } = await import("./setup");
          return setupCli({ remove: booleanFlag(args, "remove") });
        }
        const selected = await getProfile();
        if (action === "paths") return { ...selected, version: packageJson.version };
        const { readHostStatus, stopHost } = await import("./connect");
        const options = { profileDir: selected.profileDir, version: packageJson.version, timeoutMs: Math.max(1, deadline - Date.now()) };
        if (action === "host-status") return { owner: await readHostStatus(options) };
        return stopHost({ ...options, force: booleanFlag(args, "force") });
      }),
    });
    try {
      const execution = parsed.command.execute(context, parsed.args);
      // Watch owns its final NDJSON event, so let its abort cleanup finish before returning.
      const data = parsed.command.path.join(" ") === "run watch"
        ? await execution : await abortable(execution, controller.signal);
      if (!context.stream.started) write(formatResponse({ ok: true, data: data ?? null }, json));
      return 0;
    } catch (error) {
      streaming = context.stream.started;
      throw error;
    }
  } catch (error) {
    const result = errorResponse(error);
    if (streaming) log(`${result.response.error.code}: ${result.response.error.message}\n`);
    else write(formatResponse(result.response, json));
    return result.exitCode;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", detach);
    process.removeListener("SIGTERM", detach);
    dependencies.signal?.removeEventListener("abort", inheritAbort);
  }
}

async function openAuthorizationUrl(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, stdio: "ignore" });
    child.once("error", () => { reject(new CliError("BROWSER_UNAVAILABLE", "Cannot open the browser. Open the returned authorization URL manually.")); });
    child.once("exit", code => { if (code === 0) resolve(); else reject(new CliError("BROWSER_UNAVAILABLE", "Cannot open the browser. Open the returned authorization URL manually.")); });
  });
}

/** Abort the actual reader as well as its promise, so an open input pipe cannot keep the CLI alive. */
function readStandardInput(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const data = (chunk: string) => { chunks.push(chunk); };
    const cleanup = () => {
      process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", end);
      process.stdin.removeListener("error", error);
      signal.removeEventListener("abort", abort);
    };
    const end = () => { cleanup(); resolve(chunks.join("")); };
    const error = () => { cleanup(); reject(new CliError("USAGE", "Cannot read standard input.", 2)); };
    const abort = () => { cleanup(); process.stdin.destroy(); reject(signal.reason as unknown); };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    process.stdin.resume();
  });
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
