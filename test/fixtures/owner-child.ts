import { createInterface } from "node:readline";
import { acquireOwnerLock } from "../../src/app/owner";
import { startOwnerTransport } from "../../src/app/owner-transport";
import { ResearchEventSchema, type ResearchEvent } from "../../src/shared/ipc";

const [dataDir, mode = "hold", version = "0.0.0-test", kind = "cli"] = process.argv.slice(2);
if (!dataDir || (kind !== "cli" && kind !== "desktop")) throw new Error("Invalid synthetic owner arguments.");
const lock = await acquireOwnerLock(dataDir);
if (!lock) {
  console.log(JSON.stringify({ state: "blocked" }));
  process.exitCode = 4;
} else if (mode === "probe") {
  await lock.release();
  console.log(JSON.stringify({ state: "acquired" }));
} else {
  const listeners = new Set<(event: ResearchEvent) => void>();
  let active = false;
  const transport = await startOwnerTransport({
    lock, kind, version,
    async invoke(channel, payload, invocation) {
      if (channel === "fixture:emit") {
        const event = ResearchEventSchema.parse(payload);
        for (const listener of listeners) listener(event);
        return { emitted: true };
      }
      if (channel === "fixture:active") { active = payload === true; return { active }; }
      return { channel, payload, invocation };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    requestShutdown({ force }) { return force || !active; },
  });
  console.log(JSON.stringify({ state: "ready" }));
  const lines = createInterface({ input: process.stdin });
  try { for await (const line of lines) { if (line === "stop") break; } }
  finally { lines.close(); await transport.close(); await lock.release(); }
}
