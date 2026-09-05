import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scraplyRoot = join(import.meta.dir, "../../..");
const providerUrl = pathToFileURL(join(scraplyRoot, "src", "providers", "codex.ts")).href;
const { inspectCodexCli } = await import(providerUrl) as typeof import("../../../src/providers/codex");

const result = await inspectCodexCli({ force: true });
if (!result.detected || !result.compatible || !result.authenticated || result.models.length === 0) {
  throw new Error(`Scraply inspection contract failed: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify({
  detected: result.detected,
  compatible: result.compatible,
  authenticated: result.authenticated,
  version: result.version,
  modelCount: result.models.length,
}));
