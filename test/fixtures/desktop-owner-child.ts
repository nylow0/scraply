import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { createDesktopOwner } from "../../src/main/desktop-owner";
import { createAppService } from "../../src/app/service";
import { createBackendClient } from "../../src/app/backend-client";
import { resolveProfile } from "../../src/app/profile";
import { runHost } from "../../src/cli/host";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { IPC_CHANNELS, type ResearchEvent } from "../../src/shared/ipc";

// A real service/HTTP/SQLite seam on an explicit synthetic profile, with no runtime or keys.
const [profileDir, mode = "desktop", version = "desktop-test", idle = "600000"] = process.argv.slice(2);
if (!profileDir || !["desktop", "cli"].includes(mode)) throw new Error("Synthetic profile and host kind are required.");
const profile = await resolveProfile({ dataDir: profileDir, assetRoot: process.cwd() });
let factories = 0;
let credentialReads = 0;
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function application(publishEvent: (event: ResearchEvent) => void) {
  factories++;
  let backend: BackendHandle | undefined;
  const adapter = createBackendClient({
    async launch(input) {
      backend = await startBackend({
        ...profile, appVersion: version, getSecrets: () => input.secrets,
        validateAutomaticSecrets: false,
        providerValidation: {
          inspectNative: async () => ({ available: false, connected: false, accounts: [], models: [], error: "Synthetic offline runtime" }),
          async validateExa() { throw new Error("Unexpected provider validation in isolated test."); },
          async validatePerplexity() { throw new Error("Unexpected provider validation in isolated test."); },
        },
      }, publishEvent);
      return backend;
    },
    postMessage() { throw new Error("No utility process in this fixture."); },
    hasProcess: () => false,
    async stop() { await backend?.close(); backend = undefined; },
    externalSecretsNoop: true,
  });
  const service = createAppService({
    paths: profile, appVersion: version, backend: adapter, publishEvent,
    automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } },
    credentialStore: {
      load() { credentialReads++; return { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} }; },
      async save(secrets) { return secrets; },
    },
    async openExternal() { throw new Error("Owner must not open caller browser."); },
    async revealPath() { throw new Error("Owner must not open caller path."); },
    async chooseExportTarget() { throw new Error("Owner must not open caller dialog."); },
  });
  await service.start({ validateAutomaticSecrets: false });
  return {
    service,
    hasActiveWork: () => backend?.hasActiveWork() ?? false,
    async requestShutdown(force: boolean) {
      if (backend?.hasActiveWork() && !force) return false;
      if (force) await adapter.request("/app/stop-all", { method: "POST", body: "{}" });
      return true;
    },
  };
}

const owner = mode === "desktop" ? createDesktopOwner({
  profileDir: profile.profileDir, version,
  async createApplication(publish) {
    const app = await application(publish);
    return {
      invoke: (channel, payload, interactive) => interactive
        ? app.service.invoke(channel, payload === undefined ? [] : [payload]) : app.service.invokeRemote(channel, payload),
      async stop() { await app.service.stop(); }, secretValues: app.service.secretValues,
    };
  },
  publishEvent(event) { report({ event }); },
  onDisconnect() { report({ disconnected: true }); },
}) : undefined;
const host = mode === "cli" ? await runHost({
  profileDir: profile.profileDir, version, idleTimeoutMs: Number(idle), idlePollMs: 20,
  async factory(_profile, _version, publish) {
    const app = await application(publish);
    return {
      async start() {},
      async invoke(channel, payload) {
        const result = await app.service.invokeRemote(channel, payload);
        if (channel === IPC_CHANNELS.CREATE_THREAD && z.object({ title: z.string() }).safeParse(payload).data?.title === "Synthetic interrupted reply") {
          // Commit once, then lose completion before the caller sees a response.
          process.exit(71);
        }
        return result;
      },
      hasActiveWork: app.hasActiveWork, requestShutdown: app.requestShutdown,
      async stop() { await app.service.stop(); },
    };
  },
}) : undefined;
await owner?.start();
report({ ready: true, kind: owner?.kind ?? "cli", factories, credentialReads, dbPath: join("scraply", "scraply.db") });
const lines = createInterface({ input: process.stdin });
const CommandSchema = z.object({ id: z.number(), channel: z.string(), payload: z.unknown().optional() }).strict();
let hostClosed = false;
const closed = host?.closed.then(() => { hostClosed = true; lines.close(); process.stdin.destroy(); });
try {
  for await (const line of lines) {
    if (line === "close") break;
    const command = CommandSchema.parse(JSON.parse(line));
    try {
      const data = command.channel === "fixture:status" ? { kind: owner?.kind ?? "cli", factories, credentialReads }
        : await owner?.invoke(command.channel, command.payload);
      report({ id: command.id, ok: true, data });
    } catch (error) {
      report({ id: command.id, ok: false, error: error instanceof Error ? error.message : "Synthetic failure" });
    }
  }
} finally {
  lines.close();
  await owner?.close();
  if (host && !hostClosed && !await host.stop(true)) throw new Error("Synthetic CLI host refused close.");
  await closed;
}
