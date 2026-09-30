import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { ScraplyApi } from "../src/shared/scraply-api";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
export const InstalledIdentitySchema = z.object({
  executablePath: z.string(), executableSha256: SHA256, asarSha256: SHA256,
  runtimeSha256: SHA256, packageManifestSha256: SHA256, packageSourceSha: z.string(), appVersion: z.string(),
}).strict();
export type InstalledIdentity = z.infer<typeof InstalledIdentitySchema>;

export function installedPackageIdentity(executablePath: string, manifestPath: string): InstalledIdentity {
  const executable = resolve(executablePath);
  const resources = join(dirname(executable), "resources");
  const manifest = z.object({ schemaVersion: z.literal(2), appVersion: z.string(), sourceSha: z.string(), dirty: z.literal(false),
    artifacts: z.array(z.object({ name: z.string(), sha256: SHA256 })),
    runtime: z.object({ executable: z.object({ sha256: SHA256 }) }),
  }).parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const identity = InstalledIdentitySchema.parse({ executablePath: executable, executableSha256: hash(executable),
    asarSha256: hash(join(resources, "app.asar")), runtimeSha256: hash(join(resources, "runtime/scraply-agent.exe")),
    packageManifestSha256: hash(manifestPath), packageSourceSha: manifest.sourceSha, appVersion: manifest.appVersion });
  if (identity.executableSha256 !== manifest.artifacts.find(artifact => artifact.name === "unpacked")?.sha256
    || identity.asarSha256 !== manifest.artifacts.find(artifact => artifact.name === "app-asar")?.sha256
    || identity.runtimeSha256 !== manifest.runtime.executable.sha256) {
    throw new Error("Installed executable, app.asar, or runtime does not match the release manifest.");
  }
  return identity;
}

export const InstalledMethodSchema = z.enum(["identity", "getWorkspace", "createThread", "previewWorkflow", "startWorkflow", "getWorkflow", "shutdown"]);
export type InstalledMethod = z.infer<typeof InstalledMethodSchema>;
const RequestSchema = z.object({ id: z.string().uuid(), method: InstalledMethodSchema, payload: z.unknown().optional() }).strict();
const ResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string().uuid(), ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ id: z.string().uuid(), ok: z.literal(false), error: z.string() }).strict(),
]);

export function installedDriverEndpoint(profile: string): string {
  const normalized = process.platform === "win32" ? resolve(profile).toLowerCase() : resolve(profile);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return process.platform === "win32" ? `\\\\.\\pipe\\scraply-evaluation-${id}` : join(profile, "evaluation-driver.sock");
}

export function installedDriverEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(Object.entries(environment).filter(([name]) => ![
    "ELECTRON_RUN_AS_NODE", "SCRAPLY_E2E", "SCRAPLY_E2E_REAL_BACKEND", "SCRAPLY_E2E_BACKEND_URL", "SCRAPLY_E2E_BACKEND_TOKEN",
    "SCRAPLY_BROWSER_DEV", "SCRAPLY_AGENT_PATH", "SCRAPLY_AGENT_LOCK_PATH", "EXA_API_KEY", "PERPLEXITY_API_KEY",
  ].includes(name.toUpperCase())));
  return safe;
}

/** Disconnecting the observer leaves the driver and app running. Requests are never retried. */
export async function connectInstalledDriver(endpoint: string) {
  const socket = await new Promise<Socket>((resolveSocket, reject) => {
    const connection = connect(endpoint);
    connection.once("connect", () => { connection.removeListener("error", reject); resolveSocket(connection); });
    connection.once("error", reject);
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Installed driver disconnected. An uncertain admission must not be replayed.")));
  createInterface({ input: socket }).on("line", line => {
    try {
      const response = ResponseSchema.parse(JSON.parse(line));
      const request = pending.get(response.id);
      if (!request) throw new Error("Installed driver returned an uncorrelated response.");
      pending.delete(response.id); clearTimeout(request.timer);
      if (response.ok) request.resolve(response.data); else request.reject(new Error(response.error));
    } catch { fail(new Error("Installed driver returned an invalid response. No request was replayed.")); socket.destroy(); }
  });
  return {
    invoke(method: InstalledMethod, payload?: unknown): Promise<unknown> {
      const id = randomUUID();
      const request = RequestSchema.parse({ id, method, ...(payload === undefined ? {} : { payload }) });
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error(`Installed ${method} receipt timed out. No request was replayed.`)); socket.destroy();
        }, 60_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        socket.write(`${JSON.stringify(request)}\n`, error => { if (error) fail(error); });
      });
    },
    disconnect() { socket.destroy(); },
  };
}

export async function openInstalledDriver(options: { profile: string; executablePath: string; manifestPath: string }) {
  const endpoint = installedDriverEndpoint(options.profile);
  try { return await connectInstalledDriver(endpoint); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ECONNREFUSED"].includes(String(error.code))) throw error;
  }
  const driverPath = resolve(import.meta.dirname, "eval-installed-driver.ts");
  if (!existsSync(driverPath)) throw new Error("Installed evaluation driver is missing.");
  const child = spawn("node", [driverPath, "--profile", resolve(options.profile), "--executable", resolve(options.executablePath),
    "--manifest", resolve(options.manifestPath)], { detached: true, windowsHide: true, stdio: "ignore", env: installedDriverEnvironment(process.env) });
  let launchError: Error | undefined;
  child.once("error", error => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { return await connectInstalledDriver(endpoint); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ECONNREFUSED"].includes(String(error.code))) throw error;
    }
    await delay(100);
  }
  throw new Error("Installed evaluation driver did not start. No workflow was dispatched.");
}

async function serve() {
  const { values } = parseArgs({ options: { profile: { type: "string" }, executable: { type: "string" }, manifest: { type: "string" } } });
  if (!values.profile || !values.executable || !values.manifest) throw new Error("Installed driver requires profile, executable, and manifest.");
  const profile = resolve(values.profile);
  const identity = installedPackageIdentity(values.executable, values.manifest);
  const endpoint = installedDriverEndpoint(profile);
  const { _electron } = await import("@playwright/test");
  let shutdown: (() => Promise<void>) | undefined;
  const ready = Promise.withResolvers<Awaited<ReturnType<typeof _electron.launch>>>();
  // Listen before launching so a competing observer cannot launch a second app for this profile.
  const server = createServer(socket => {
    let tail = Promise.resolve();
    createInterface({ input: socket }).on("line", line => {
      tail = tail.then(async () => {
        const parsed = RequestSchema.safeParse(JSON.parse(line));
        if (!parsed.success) { socket.destroy(); return; }
        const request = parsed.data;
        try {
          const application = await ready.promise;
          const page = await application.firstWindow();
          let data: unknown;
          if (request.method === "identity") data = { ...identity, profile };
          else {
            data = await page.evaluate(async request => {
              const api = (window as unknown as { scraply: ScraplyApi }).scraply;
              switch (request.method) {
                case "getWorkspace": return api.getWorkspace();
                case "createThread": return api.createThread((request.payload as { title: string }).title);
                case "previewWorkflow": return api.previewWorkflow(request.payload as Parameters<ScraplyApi["previewWorkflow"]>[0]);
                case "startWorkflow": return api.startWorkflow(request.payload as Parameters<ScraplyApi["startWorkflow"]>[0]);
                case "getWorkflow": return api.getWorkflow(request.payload as Parameters<ScraplyApi["getWorkflow"]>[0]);
                case "shutdown": {
                  const workspace = await api.getWorkspace();
                  if (workspace.pendingRuns.length || ["running", "pause-requested", "stop-requested"].includes(workspace.activeWorkflow?.state ?? "")) {
                    throw new Error("The installed app has active work and was left running. Observe it before closing this driver.");
                  }
                  return null;
                }
                default: throw new Error("Unsupported installed evaluation method.");
              }
            }, request);
          }
          await new Promise<void>((resolveWrite, reject) => socket.write(`${JSON.stringify({ id: request.id, ok: true, data })}\n`, error => error ? reject(error) : resolveWrite()));
          if (request.method === "shutdown") await shutdown?.();
        } catch (error) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : "Installed evaluation request failed." })}\n`);
        }
      }).catch(() => { socket.destroy(); });
    });
  });
  await new Promise<void>((resolveServer, reject) => { server.once("error", reject); server.listen(endpoint, resolveServer); });
  try {
    const application = await _electron.launch({ executablePath: identity.executablePath,
      args: [`--user-data-dir=${profile}`], env: Object.fromEntries(Object.entries(installedDriverEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined)), timeout: 60_000 });
    const actual = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath("userData"),
      executable: process.execPath, appVersion: app.getVersion() }));
    if (!actual.packaged || resolve(actual.profile).toLowerCase() !== profile.toLowerCase()
      || resolve(actual.executable).toLowerCase() !== identity.executablePath.toLowerCase() || actual.appVersion !== identity.appVersion) {
      await application.close(); throw new Error("Installed app identity or isolated profile did not match the requested package.");
    }
    const page = await application.firstWindow();
    await page.waitForFunction(() => Boolean((window as unknown as { scraply?: ScraplyApi }).scraply?.getWorkspace), undefined, { timeout: 60_000 });
    shutdown = async () => { await application.close(); server.close(); process.exit(0); };
    application.on("close", () => { server.close(); process.exit(0); });
    ready.resolve(application);
  } catch (error) { ready.reject(error); server.close(); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await serve();
