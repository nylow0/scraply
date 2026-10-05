import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeClient } from "../../src/providers/runtime";

const root = join(import.meta.dir, "..", "..");
const ref = process.argv[2] ?? "ce6ae26";
const baseline = spawnSync("git", ["show", `${ref}:src/providers/runtime.ts`], { cwd: root, encoding: "utf8" });
if (baseline.status !== 0) throw new Error(`Could not read baseline ${ref}: ${baseline.stderr}`);

// Keep the temporary module beside the current client so it resolves the same imports.
const temporaryPath = join(root, "src", "providers", `.runtime-framing-baseline-${randomUUID()}.ts`);
writeFileSync(temporaryPath, baseline.stdout);

try {
  const prior = await import(pathToFileURL(temporaryPath).href) as { RuntimeClient: typeof RuntimeClient };
  for (const size of [262_144, 2_097_152, 8_388_608]) {
    const padding = "x".repeat(size);
    const frame = Buffer.from(JSON.stringify({
      protocolVersion: "1.2", id: "ignored", operation: "account.list", result: { padding },
    }));
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < frame.length; offset += 8192) chunks.push(frame.subarray(offset, offset + 8192));
    chunks.push(Buffer.from("\n"));
    for (const [name, Client] of [["baseline", prior.RuntimeClient], ["current", RuntimeClient]] as const) {
      const times: number[] = [];
      for (let sample = 0; sample < 9; sample += 1) {
        const client = new Client({} as ConstructorParameters<typeof RuntimeClient>[0]);
        const child = {};
        let result: unknown;
        const parser = client as unknown as {
          child: object;
          pendingRequests: Map<string, { operation: "account.list"; timer: null; resolve(value: unknown): void; reject(error: Error): void }>;
          consumeStdout(child: object, chunk: Buffer): void;
        };
        parser.child = child;
        parser.pendingRequests.set("ignored", {
          operation: "account.list", timer: null, resolve: (value) => { result = value; }, reject: (error) => { throw error; },
        });
        const start = performance.now();
        for (const chunk of chunks) parser.consumeStdout(child, chunk);
        times.push(performance.now() - start);
        if (!result || typeof result !== "object" || !("padding" in result) || result.padding !== padding) {
          throw new Error(`${name} parser changed the ${size} byte result`);
        }
      }
      times.sort((a, b) => a - b);
      console.log(`${name}\t${frame.length} bytes\tmedian ${times[4]!.toFixed(2)} ms\tp90 ${times[8]!.toFixed(2)} ms`);
    }
  }
} finally {
  unlinkSync(temporaryPath);
}
