import { describe, expect, test } from "bun:test";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

describe("workflow model scheduler", () => {
  test("rotates projects after one call even when the first project has queued more work", async () => {
    const scheduler = new WorkflowModelScheduler();
    const starts: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    let running = 0;
    let peakRunning = 0;
    const submit = (projectId: string, name: string, gate: ReturnType<typeof deferred<void>>) =>
      scheduler.schedule(projectId, async () => {
        starts.push(name);
        running++;
        peakRunning = Math.max(peakRunning, running);
        await gate.promise;
        running--;
        return name;
      });

    const results = [
      submit("project-a", "a1", gates[0]!),
      submit("project-a", "a2", gates[3]!),
      submit("project-b", "b1", gates[1]!),
      submit("project-c", "c1", gates[2]!),
      submit("project-b", "b2", gates[4]!),
    ];
    const expectedOrder = ["a1", "b1", "c1", "a2", "b2"];
    for (const [index, name] of expectedOrder.entries()) {
      await until(() => starts.length === index + 1);
      expect(starts[index]).toBe(name);
      gates[index]!.resolve();
    }
    expect(await Promise.all(results)).toEqual(["a1", "a2", "b1", "c1", "b2"]);
    expect(starts).toEqual(expectedOrder);
    expect(peakRunning).toBe(1);
    expect(scheduler.activeProjectId).toBeNull();
    expect(scheduler.pendingCallCount).toBe(0);
  });

  test("cancels queued calls without dispatch and allows new work for that project", async () => {
    const scheduler = new WorkflowModelScheduler();
    const release = deferred<void>();
    const started: string[] = [];
    const active = scheduler.schedule("project-a", async () => {
      started.push("a1");
      await release.promise;
      return "a1";
    });
    await until(() => started.length === 1);
    const cancelled = scheduler.schedule("project-b", async () => {
      started.push("b1");
      return "b1";
    });
    const cancelledOutcome = cancelled.then(() => "resolved", (error: unknown) => error);
    const retained = scheduler.schedule("project-c", async () => {
      started.push("c1");
      return "c1";
    });
    scheduler.cancelProject("project-b");
    release.resolve();
    expect(await active).toBe("a1");
    expect((await cancelledOutcome as Error).name).toBe("AbortError");
    expect(await retained).toBe("c1");
    expect(started).toEqual(["a1", "c1"]);
    expect(await scheduler.schedule("project-b", async () => "b2")).toBe("b2");
  });

  test("an aborted active call keeps the global slot until its operation settles", async () => {
    const scheduler = new WorkflowModelScheduler();
    const release = deferred<void>();
    const started: string[] = [];
    const receivedSignals: AbortSignal[] = [];
    const active = scheduler.schedule("project-a", async (signal) => {
      receivedSignals.push(signal);
      started.push("a1");
      await release.promise;
      return "late result";
    });
    const activeOutcome = active.then(() => "resolved", (error: unknown) => error);
    await until(() => started.length === 1);
    const next = scheduler.schedule("project-b", async () => {
      started.push("b1");
      return "b1";
    });
    scheduler.cancelProject("project-a");
    expect(receivedSignals[0]?.aborted).toBe(true);
    await Bun.sleep(10);
    expect(started).toEqual(["a1"]);
    release.resolve();
    expect((await activeOutcome as Error).name).toBe("AbortError");
    expect(await next).toBe("b1");
    expect(started).toEqual(["a1", "b1"]);
  });

  test("rejects an already aborted admission and leaves no queued work", async () => {
    const scheduler = new WorkflowModelScheduler();
    const controller = new AbortController();
    controller.abort();
    const outcome = scheduler.schedule("project", async () => "unused", controller.signal);
    expect((await outcome.catch((error: unknown) => error) as Error).name).toBe("AbortError");
    expect(scheduler.pendingCallCount).toBe(0);
    expect(scheduler.activeProjectId).toBeNull();
    expect(() => scheduler.schedule(" ", async () => "unused")).toThrow("project ID");
  });
});
