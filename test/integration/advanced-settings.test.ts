import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type BackendHandle } from "../../src/backend/server";
import { AppSettingsSchema } from "../../src/shared/app-settings";

const directories: string[] = [];
const handles: BackendHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of directories.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite can briefly hold a WAL handle. */ } }
});

test("advanced settings default on, reject invalid concurrency, and survive a backend restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scraply-advanced-settings-"));
  directories.push(dir);
  const context = { dataDir: dir, dbPath: join(dir, "scraply.db"), bundledPromptsDir: join(process.cwd(), "prompts"),
    promptOverridesDir: join(dir, "prompts"), appVersion: "test", getSecrets: () => ({ exaApiKey: null }) };
  let backend = await startBackend(context, () => undefined);
  handles.push(backend);
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${backend.port}/settings/advanced`, { headers: { authorization: `Bearer ${backend.token}` } });
    const body = await response.json() as { data: unknown };
    return AppSettingsSchema.parse(body.data);
  };
  const save = async (settings: unknown) => fetch(`http://127.0.0.1:${backend.port}/settings/advanced`, {
    method: "POST", headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" }, body: JSON.stringify(settings),
  });
  expect(await read()).toEqual({ reasoningSummaries: true, maxConcurrentModelCalls: 8 });
  expect((await save({ reasoningSummaries: false, maxConcurrentModelCalls: 9 })).status).toBe(400);
  expect((await save({ reasoningSummaries: false, maxConcurrentModelCalls: 1 })).status).toBe(200);
  await backend.close();
  handles.pop();
  backend = await startBackend(context, () => undefined);
  handles.push(backend);
  expect(await read()).toEqual({ reasoningSummaries: false, maxConcurrentModelCalls: 1 });
});
