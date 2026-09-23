import { describe, expect, test } from "bun:test";
import { remainingWorkflowMs } from "../../src/core/workflow-time";

describe("workflow time allowance", () => {
  test("deducts active time and never grows when the clock moves backward", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    expect(remainingWorkflowMs({ remainingMs: 60_000, runningSince: null }, now)).toBe(60_000);
    expect(remainingWorkflowMs({ remainingMs: 60_000, runningSince: new Date(now - 20_000).toISOString() }, now)).toBe(40_000);
    expect(remainingWorkflowMs({ remainingMs: 60_000, runningSince: new Date(now + 20_000).toISOString() }, now)).toBe(60_000);
    expect(remainingWorkflowMs({ remainingMs: 60_000, runningSince: new Date(now - 80_000).toISOString() }, now)).toBe(0);
  });
});
