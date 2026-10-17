import { expect, spyOn, test } from "bun:test";
import { createServiceBilling } from "../../../src/app/service-billing";
import { AppError } from "../../../src/shared/errors";
import { IPC_CHANNELS, ValidationStateSchema } from "../../../src/shared/ipc";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(blockedReads: number[]) {
  const gates = new Map(blockedReads.map(read => [read, { entered: barrier(), finish: barrier() }]));
  let reads = 0;
  let dispatches = 0;
  const validation = ValidationStateSchema.parse({
    exa: { valid: false }, perplexity: { valid: false },
    native: { available: true, connected: false, accounts: [] }, setupComplete: false,
  });
  const billing = createServiceBilling({
    async capabilities() {
      const gate = gates.get(++reads);
      if (gate) { gate.entered.release(); await gate.finish.promise; }
      return validation;
    },
    privateState: () => ({ revision: 1 }),
    async validate() {},
    async dispatch() { dispatches += 1; return validation; },
  });
  return { billing, gates, dispatches: () => dispatches };
}

function outcome(promise: Promise<unknown>) {
  return promise.then(() => "accepted", (error: unknown) => error instanceof AppError ? error.code : "unexpected-error");
}

test("an approval expiring during capability verification never dispatches", async () => {
  let now = Date.UTC(2026, 0, 1);
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const item = fixture([2]);
  try {
    const proposal = await item.billing.preview({ channel: IPC_CHANNELS.GET_VALIDATION, payload: {} });
    const pending = outcome(item.billing.execute({ proposal }));
    const gate = item.gates.get(2)!;
    await gate.entered.promise;
    now = Date.parse(proposal.expiresAt);
    gate.finish.release();
    expect(await pending).toBe("PREVIEW_STALE");
    expect(item.dispatches()).toBe(0);
  } finally {
    for (const gate of item.gates.values()) gate.finish.release();
    item.billing.clear();
    clock.mockRestore();
  }
});

test("expiry cleanup cannot readmit a second execution of an already consumed approval", async () => {
  let now = Date.UTC(2026, 0, 1);
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const item = fixture([2, 3]);
  try {
    const proposal = await item.billing.preview({ channel: IPC_CHANNELS.GET_VALIDATION, payload: {} });
    now = Date.parse(proposal.expiresAt) - 1;
    const first = outcome(item.billing.execute({ proposal }));
    await item.gates.get(2)!.entered.promise;
    const second = outcome(item.billing.execute({ proposal }));
    await item.gates.get(3)!.entered.promise;
    item.gates.get(2)!.finish.release();
    expect(await first).toBe("accepted");
    now += 2;
    // A fresh preview prunes the expired consumed entry while the second check is waiting.
    await item.billing.preview({ channel: IPC_CHANNELS.GET_VALIDATION, payload: {} });
    item.gates.get(3)!.finish.release();
    expect(await second).toBe("PREVIEW_STALE");
    expect(item.dispatches()).toBe(1);
  } finally {
    for (const gate of item.gates.values()) gate.finish.release();
    item.billing.clear();
    clock.mockRestore();
  }
});
