import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readOwnerMetadata } from "../../src/app/owner";
import { createOwnerClient } from "../../src/app/owner-transport";
import { version } from "../../package.json";
import { CreateProjectResultSchema } from "../../src/shared/cli-contracts";

export const CliEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.string(), message: z.string(), recovery: z.unknown().optional(), reference: z.string().optional(),
  }).strict() }).strict(),
]);

export interface CliProcessResult { code: number; stdout: string; stderr: string }
export interface CliFixtureOptions { mode?: string; search?: "none" | "exa"; delayMs?: number; gateIdeas?: boolean; version?: string }

/** All subprocesses, including nested fixture workers, explicitly reject inherited provider keys. */
export function cliTestEnvironment(profileDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_DATA_DIR: profileDir,
    SCRAPLY_DEV_DATA_DIR: profileDir, SCRAPLY_DEV_SHARED_CREDENTIALS: "0" };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

export async function waitForCli<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error(`CLI fixture condition timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
}

function capture(child: ChildProcess, timeoutMs: number, input?: string): Promise<CliProcessResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", chunk => { stdout += String(chunk); });
  child.stderr?.setEncoding("utf8").on("data", chunk => { stderr += String(chunk); });
  child.stdin?.end(input);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI process exceeded ${timeoutMs}ms. ${stderr}`)); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

/** Owns only fresh synthetic profiles and exact child PIDs; never starts the production host. */
export function createCliFixture(options: CliFixtureOptions = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), "scraply-cli-integration-"));
  const dataDir = join(profileDir, "scraply");
  const children = new Set<ChildProcess>();
  let host: ChildProcess | undefined;
  let hostOutput = "";
  const environment = cliTestEnvironment(profileDir);
  const interpreter = process.execPath;
  const ownedSpawn = (executable: string, args: string[]) => {
    const child = spawn(executable, args, { cwd: process.cwd(), env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };
  const fixture = {
    profileDir, dataDir, dbPath: join(dataDir, "scraply.db"),
    async start(next: CliFixtureOptions = {}) {
      if (host && host.exitCode === null && host.signalCode === null) throw new Error("Fixture host is already running.");
      const selected = { ...options, ...next };
      hostOutput = "";
      host = ownedSpawn(interpreter, ["--no-env-file", "run", join(process.cwd(), "test/fixtures/cli-backend.ts"),
        "--profile", profileDir, "--mode", selected.mode ?? "workflow-many", "--search", selected.search ?? "exa",
        "--delay", String(selected.delayMs ?? 0), ...(selected.gateIdeas ? ["--gate-ideas"] : []), "--version", selected.version ?? version]);
      host.stdin?.end();
      host.stdout?.setEncoding("utf8").on("data", chunk => { hostOutput += String(chunk); });
      host.stderr?.setEncoding("utf8").on("data", chunk => { hostOutput += String(chunk); });
      await waitForCli(async () => {
        if (host?.exitCode !== null && host?.exitCode !== undefined) throw new Error(`Fixture owner failed: ${hostOutput}`);
        return hostOutput;
      }, output => output.split(/\r?\n/).some(line => line.startsWith('{"ready":true,')));
    },
    async owner(clientVersion = version) {
      const metadata = await readOwnerMetadata(profileDir);
      if (!metadata) throw new Error("Fixture owner did not publish metadata.");
      return createOwnerClient(metadata, clientVersion);
    },
    contend() {
      return capture(ownedSpawn(interpreter, ["--no-env-file", "run", join(process.cwd(), "test/fixtures/cli-backend.ts"),
        "--profile", profileDir]), 10_000);
    },
    spawn(args: string[]) {
      const executable = process.env.SCRAPLY_TEST_CLI_EXECUTABLE;
      const argumentsWithProfile = [...args, "--data-dir", profileDir, "--json"];
      return executable ? ownedSpawn(executable, argumentsWithProfile)
        : ownedSpawn(interpreter, ["--no-env-file", "run", join(process.cwd(), "src/cli/main.ts"), ...argumentsWithProfile]);
    },
    run(args: string[], input?: string, timeoutMs = 30_000) { return capture(fixture.spawn(args), timeoutMs, input); },
    async json<S extends z.ZodType>(args: string[], schema: S, input?: string): Promise<z.output<S>> {
      const result = await fixture.run(args, input);
      if (result.code !== 0) throw new Error(`CLI ${args.join(" ")} exited ${result.code}: ${result.stdout}\n${result.stderr}`);
      const envelope = CliEnvelopeSchema.parse(JSON.parse(result.stdout));
      if (!envelope.ok) throw new Error(envelope.error.message);
      return schema.parse(envelope.data);
    },
    dispatches() {
      const lines = (name: string) => existsSync(join(dataDir, name))
        ? readFileSync(join(dataDir, name), "utf8").split(/\r?\n/).filter(Boolean) : [];
      return { models: lines("requests.jsonl"), searches: lines("searches.jsonl") };
    },
    // Keep dispatches() compatible with existing fixture consumers. Admission
    // checks include provider connectivity searches, even when no workflow ran.
    admissions() {
      const path = join(dataDir, "provider-probes.jsonl");
      const providerProbes = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean) : [];
      return { ...fixture.dispatches(), providerProbes };
    },
    backendErrors() {
      const path = join(dataDir, "errors.log");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
    async crash() {
      if (!host || host.exitCode !== null || host.signalCode !== null) throw new Error("No live owned host to crash.");
      const exited = new Promise<void>(resolve => host!.once("close", () => resolve()));
      // On Windows this is immediate process death, rather than a graceful host stop.
      host.kill("SIGKILL");
      await exited;
    },
    async stop() {
      if (!host || host.exitCode !== null || host.signalCode !== null) return;
      const exited = new Promise<void>(resolve => host!.once("close", () => resolve()));
      const stopped = await (await fixture.owner()).stop({ force: true });
      if (!stopped.stopped) throw new Error("Fixture owner refused a forced normal shutdown.");
      await exited;
    },
    async close() {
      if (host && host.exitCode === null && host.signalCode === null) {
        try { if (!(await (await fixture.owner()).stop({ force: true })).stopped) host.kill(); }
        catch { host.kill(); }
      }
      for (const child of children) {
        if (child === host) continue;
        child.kill();
      }
      await waitForCli(async () => children.size, size => size === 0, 5_000).catch(() => {
        for (const child of children) child.kill("SIGKILL");
      });
      // Abrupt host death can orphan the worker. This profile's capture contains
      // only PIDs spawned by its own test factory, never a process-name lookup.
      const pidFile = join(dataDir, "pids.txt");
      if (existsSync(pidFile)) for (const line of readFileSync(pidFile, "utf8").split(/\r?\n/).filter(Boolean)) {
        try { process.kill(Number(line), "SIGKILL"); } catch { /* Already exited. */ }
      }
      try { rmSync(profileDir, { recursive: true, force: true }); }
      catch { /* Windows may release an abruptly terminated SQLite handle later. */ }
    },
  };
  return fixture;
}

/** Configure through public commands so persistence and cross-invocation defaults are exercised. */
export async function configureCliProject(fixture: ReturnType<typeof createCliFixture>, options: {
  title: string; mode?: "vibe" | "controlled"; knownProblem?: boolean;
}) {
  const { thread } = await fixture.json(["project", "create", "--title", options.title], CreateProjectResultSchema);
  await fixture.json(["brief", "set", "--project", thread.id, "--stdin"], z.unknown(), JSON.stringify({
    title: options.title, audience: "Repair shops", domain: "Parts delivery",
    observations: "Synthetic repair desks record uncertain parts arrival windows.", offLimits: ["Holding inventory"],
    riskEvaluationCriteria: "A small team can pilot this workflow with one supplier.",
  }, null, 2));
  await fixture.json(["config", "set", "--project", thread.id,
    `mode=${options.mode ?? "vibe"}`, "depth=quick", "model=openai-subscription:gpt-fixture", "effort=medium",
    "ideas-model=openai-subscription:gpt-fixture", "ideas-effort=medium", "review-model=openai-subscription:gpt-fixture",
    "review-effort=medium", "idea-count=1", "search-provider=exa",
    `research-mode=${options.knownProblem ? "known-problem" : "explore-market"}`,
    ...(options.knownProblem ? ["known-problem=Repair shops cannot reliably predict parts arrival times."] : []),
  ], z.unknown());
  return thread;
}
