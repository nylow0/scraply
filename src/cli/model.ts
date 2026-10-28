import { existsSync } from "node:fs";
import { join } from "node:path";
import { RuntimeClient } from "../providers/runtime";
import { ProviderFailure } from "../providers/structured";
import { resolveRuntimeLaunch } from "../shared/runtime-artifact";
import { OPENAI_SUBSCRIPTION_PROVIDER_ID } from "../shared/schemas";
import { openSecrets } from "./credentials";
import { CliError } from "./output";

/**
 * The CLI's connection to the model worker (`runtime/`, the Rust `scraply-agent.exe`). The worker
 * makes every model call and validates its output against a JSON schema; it holds the account
 * credential only in memory. Scraply restores the saved credential into each worker session and
 * writes back any credential the worker rotates, through the same encrypted `secrets.bin` the
 * desktop app used, so an existing sign-in keeps working.
 */

export const MODEL_PROVIDER = OPENAI_SUBSCRIPTION_PROVIDER_ID;

/** Where a verified worker and its lock can be found, in order of preference. */
function runtimeCandidates(env: Record<string, string | undefined>) {
  const localAppData = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local");
  return [
    // A worker built from this checkout by `bun run prepare:runtime`.
    join(import.meta.dir, "..", "..", "build"),
    // The worker the desktop installer placed, until this checkout has its own.
    join(localAppData, "Programs", "scraply", "resources"),
  ];
}

export function findRuntime(env: Record<string, string | undefined>) {
  if (env.SCRAPLY_AGENT_PATH || env.SCRAPLY_AGENT_LOCK_PATH) {
    return resolveRuntimeLaunch({ packaged: false, resourcesPath: "", environment: env as NodeJS.ProcessEnv });
  }
  const resourcesPath = runtimeCandidates(env).find(path => existsSync(join(path, "runtime", "scraply-agent.exe")));
  return resourcesPath ? resolveRuntimeLaunch({ packaged: true, resourcesPath }) : undefined;
}

export type ModelSession = Awaited<ReturnType<typeof openModelSession>>;

/**
 * The saved credentials a worker restores: all of them when it first starts (`held` absent), and after a
 * restart only the ones this process began with, so a stopped worker never comes back holding an account
 * another process signed in to meanwhile, which logout would then revoke.
 */
export function credentialsToRestore(saved: Record<string, string>, held: Record<string, string | undefined> | undefined) {
  return Object.entries(saved).filter(([providerId, credential]) => !held || held[providerId] === credential);
}

/** Start the worker with the saved account restored. Call `close` when done. */
export async function openModelSession(profileDir: string, env: Record<string, string | undefined>) {
  let launch;
  try { launch = findRuntime(env); }
  catch (error) { throw new CliError("RUNTIME_INVALID", `The model worker failed verification: ${error instanceof Error ? error.message : "unknown error"}. Rebuild it with: bun run prepare:runtime`); }
  if (!launch) throw new CliError("NO_RUNTIME", "No model worker found. Build it with: bun run prepare:runtime");
  const secrets = openSecrets(profileDir);
  // The credentials this worker holds. A save is refused when the file no longer has them, so a
  // rotation in a long run never overwrites a sign-in or sign-out made meanwhile in another process.
  const held: Record<string, string | undefined> = {};
  let started = false;
  const client = new RuntimeClient({ ...launch, appVersion: "scraply-cli", environment: env as NodeJS.ProcessEnv, maxConcurrentGenerations: 4 });
  client.setSessionInitializer(async session => {
    for (const [providerId, credential] of credentialsToRestore(secrets.load().providerCredentials, started ? held : undefined)) {
      held[providerId] = credential;
      try { await session.restoreCredential(providerId, credential); }
      catch { await session.logout(providerId).catch(() => undefined); }
    }
    started = true;
  });
  /** Save a credential the worker issued or rotated, before the worker may use it. */
  const persist = async (providerId: string, credential: string) => {
    const current = secrets.load();
    if (current.providerCredentials[providerId] !== held[providerId]) {
      throw new CliError("CREDENTIALS_CONFLICT", "The model account changed in another Scraply process. Run the command again.");
    }
    await secrets.save({ ...current, providerCredentials: { ...current.providerCredentials, [providerId]: credential } });
    held[providerId] = credential;
  };
  try {
    await client.start();
  } catch (error) {
    await client.close();
    throw new CliError("RUNTIME_FAILED", `The model worker did not start: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return { client, persist, held: (providerId: string) => held[providerId], hasSavedAccount: () => Boolean(secrets.load().providerCredentials[MODEL_PROVIDER]), close: () => client.close() };
}

/** The account and its runnable models, refreshing the account once if its session expired. */
export async function connectedModels(session: ModelSession) {
  if (!session.hasSavedAccount()) throw new CliError("SIGNED_OUT", "No model account. Sign in with: scraply login");
  const list = () => session.client.listModels(MODEL_PROVIDER);
  // Only a rejected sign-in means signing in again; an outage or rate limit means trying again later.
  // A refresh the provider refuses comes back as reconnect_required, which also needs a new sign-in.
  const failed = (error: unknown) => error instanceof ProviderFailure && (error.code === "auth" || error.runtimeCode === "reconnect_required")
    ? new CliError("SIGNED_OUT", `The saved model account no longer works (${error.message}). Sign in again with: scraply login`)
    : error instanceof CliError ? error
      : new CliError("MODEL_UNREACHABLE", `The model account could not be reached (${error instanceof Error ? error.message : "unknown error"}). Run the command again later.`);
  let models;
  try { models = await list(); }
  catch (error) {
    if (!(error instanceof ProviderFailure && error.code === "auth")) throw failed(error);
    try {
      await session.client.refreshAccount(MODEL_PROVIDER, session.persist);
      models = await list();
    } catch (retryError) {
      throw failed(retryError);
    }
  }
  const accounts = await session.client.listAccounts();
  return { account: accounts.find(item => item.providerId === MODEL_PROVIDER), models: models.filter(model => model.supportsStructuredOutput) };
}
