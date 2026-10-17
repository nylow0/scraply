import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AppBackend } from "../../src/app/service-contracts";
import type { BackendSecrets } from "../../src/shared/backend-process";

// This executable is a test-owned factory for the real host. Production CLI startup
// cannot enable it through an environment variable or select a synthetic backend.
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (args[0] === "__worker") {
  // Delay admission to the existing deterministic worker so watch can detach during
  // actual work. The protocol bytes and stage outputs remain the existing fixture's.
  const worker = spawn(process.execPath, ["--no-env-file", "run", join(process.cwd(), "test/fixtures/runtime-child.cjs"),
    ...(args.includes("--version") ? ["--version"] : [])], {
    env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  if (process.env.SCRAPLY_RUNTIME_PID_CAPTURE) appendFileSync(process.env.SCRAPLY_RUNTIME_PID_CAPTURE, `${process.pid}\n`);
  worker.stdout.pipe(process.stdout);
  worker.stderr.pipe(process.stderr);
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    const request = z.object({ operation: z.string(), payload: z.object({ workOrder: z.object({ stage: z.string() }).optional() }).passthrough().optional() }).parse(JSON.parse(line));
    const forward = () => { if (!worker.stdin.destroyed) worker.stdin.write(`${line}\n`); };
    const gate = flag("--gate");
    if (request.operation === "generation.start" && request.payload?.workOrder?.stage === "solutions" && gate && !existsSync(gate)) {
      appendFileSync(`${gate}.waiting`, "waiting\n");
      const interval = setInterval(() => { if (existsSync(gate)) { clearInterval(interval); forward(); } }, 20);
      worker.once("exit", () => clearInterval(interval));
    } else if (request.operation === "generation.start") setTimeout(forward, Number(flag("--delay") ?? 0));
    else forward();
  });
  input.on("close", () => worker.stdin.end());
  worker.on("exit", code => { process.exitCode = code ?? 1; input.close(); });
  worker.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; input.close(); });
} else {
  const profileDir = flag("--profile");
  if (!profileDir) throw new Error("An isolated --profile is required.");
  const [{ runHost }, { createAppService }, { createCredentialStore }, { createFixtureEncryption },
    { startNativeWorkflowBackend, NATIVE_WORKFLOW_MODEL }, { requestBackend },
    { AppError }, { version }] = await Promise.all([
    import("../../src/cli/host"), import("../../src/app/service"), import("../../src/main/credential-store"),
    import("./credential-store-encryption"), import("./native-workflow-backend"), import("../../src/app/backend-request"),
    import("../../src/shared/errors"), import("../../package.json"),
  ]);
  const host = await runHost({
    profileDir, version: flag("--version") ?? version,
    factory: async (profile, appVersion, publishEvent) => {
      mkdirSync(profile.dataDir, { recursive: true });
      appendFileSync(join(profile.dataDir, "factory-started.txt"), `${process.pid}\n`);
      const store = createCredentialStore(profile.credentialsPath, createFixtureEncryption(Buffer.alloc(32, 7)));
      store.load();
      if (!existsSync(profile.credentialsPath)) await store.save({
        exaApiKey: flag("--search") === "none" ? null : "synthetic-cli-search-key",
        perplexityApiKey: null, providerCredentials: { [NATIVE_WORKFLOW_MODEL.providerId]: "synthetic-cli-account" },
      });
      let secrets: BackendSecrets = { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} };
      let native: Awaited<ReturnType<typeof startNativeWorkflowBackend>> | undefined;
      let starting: Promise<void> | undefined;
      const backend: AppBackend = {
        start(input) {
          starting ??= (async () => {
            secrets = structuredClone(input.secrets);
            const delay = Number(flag("--delay") ?? 0);
            const gate = args.includes("--gate-ideas") ? join(profile.dataDir, "release-ideas") : undefined;
            native = await startNativeWorkflowBackend(profile.dataDir, {
              mode: flag("--mode") ?? "workflow-many", searchEnabled: flag("--search") !== "none",
              runtimeExecutablePath: process.execPath,
              runtimeArgumentPrefix: ["--no-env-file", "run", delay > 0 || gate
                ? join(process.cwd(), "test/fixtures/cli-backend.ts") : join(process.cwd(), "test/fixtures/runtime-child.cjs"),
              ...(delay > 0 || gate ? ["__worker", "--delay", String(delay), ...(gate ? ["--gate", gate] : [])] : [])],
              getSecrets: () => secrets, persistProviderCredential: input.persistProviderCredential,
              onEvent: input.publishEvent,
              onSearch: query => appendFileSync(join(profile.dataDir, "searches.jsonl"), `${JSON.stringify(query)}\n`),
              onProviderProbe: probe => appendFileSync(join(profile.dataDir, "provider-probes.jsonl"), `${JSON.stringify(probe)}\n`),
              onError: error => appendFileSync(join(profile.dataDir, "errors.log"), `${error instanceof Error ? error.message : String(error)}\n`),
            });
          })();
          return starting;
        },
        isReady: () => native !== undefined,
        async request(path, init) {
          if (!native) throw new AppError("backend_unavailable");
          return requestBackend(native, path, init);
        },
        async updateSecrets(next, onlyWhenIdle) {
          if (!native) throw new AppError("backend_unavailable");
          if (onlyWhenIdle && !native.beginSearchKeyUpdate()) throw new AppError("conflict", "Search is active.");
          secrets = structuredClone(next);
          native.secretsChanged();
        },
        async finishSearchKeyUpdate(previous) {
          if (native?.finishSearchKeyUpdate() && previous) {
            secrets = structuredClone(previous);
            native.secretsChanged();
          }
        },
        async stop() { await starting; await native?.close(); native = undefined; },
      };
      const service = createAppService({ paths: profile, appVersion, backend, credentialStore: store,
        automaticSecrets: { environment: { EXA_API_KEY: "", PERPLEXITY_API_KEY: "" } }, publishEvent });
      return {
        async start() { await service.start({ validateAutomaticSecrets: false }); },
        invoke: (channel, payload) => service.invokeRemote(channel, payload),
        hasActiveWork: () => Boolean(native?.hasActiveWork()),
        async requestShutdown(force) {
          if (force) await backend.request("/app/stop-all", { method: "POST", body: "{}" });
          return !native?.hasActiveWork();
        },
        async stop() { await service.stop(); },
      };
    },
  });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
  await host.closed;
}
