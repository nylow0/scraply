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
  test("fills parallel slots while rotating queued projects", async () => {
    const scheduler = new WorkflowModelScheduler(2);
    const starts: string[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let running = 0;
    let peakRunning = 0;
    const submit = (projectId: string, name: string, gateIndex: number) =>
      scheduler.schedule(projectId, async () => {
        starts.push(name);
        peakRunning = Math.max(peakRunning, ++running);
        await gates[gateIndex]!.promise;
        running--;
        return name;
      });
    const results = [submit("a", "a1", 0), submit("a", "a2", 3), submit("b", "b1", 1),
      submit("c", "c1", 2), submit("b", "b2", 4)];
    await until(() => starts.length === 2);
    expect(starts).toEqual(["a1", "b1"]);
    expect(scheduler.activeProjectIds).toEqual(["a", "b"]);
    gates[0]!.resolve();
    await until(() => starts.length === 3);
    expect(starts[2]).toBe("c1");
    gates[1]!.resolve();
    await until(() => starts.length === 4);
    expect(starts[3]).toBe("a2");
    gates[2]!.resolve();
    await until(() => starts.length === 5);
    expect(starts[4]).toBe("b2");
    gates[3]!.resolve();
    gates[4]!.resolve();
    expect(await Promise.all(results)).toEqual(["a1", "a2", "b1", "c1", "b2"]);
    expect(peakRunning).toBe(2);
    await until(() => scheduler.activeCallCount === 0);
  });

  test("a project arriving during a call gets a turn before that project's backlog", async () => {
    const scheduler = new WorkflowModelScheduler();
    const release = deferred<void>();
    const starts: string[] = [];
    const first = scheduler.schedule("a", async () => { starts.push("a1"); await release.promise; });
    await until(() => starts.length === 1);
    const backlog = scheduler.schedule("a", async () => { starts.push("a2"); });
    const newcomer = scheduler.schedule("b", async () => { starts.push("b1"); });
    release.resolve();
    await Promise.all([first, backlog, newcomer]);
    expect(starts).toEqual(["a1", "b1", "a2"]);
  });

  test("cancels every active project call without giving its occupied slots away early", async () => {
    const scheduler = new WorkflowModelScheduler(2);
    const releases = [deferred<void>(), deferred<void>()];
    const signals: AbortSignal[] = [];
    const active = releases.map((release) => scheduler.schedule("a", async (signal) => {
      signals.push(signal);
      await release.promise;
      return "late";
    }).catch((error: unknown) => error));
    await until(() => signals.length === 2);
    let nextStarted = false;
    const next = scheduler.schedule("b", async () => { nextStarted = true; return "b"; });
    scheduler.cancelProject("a");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await Bun.sleep(10);
    expect(nextStarted).toBe(false);
    expect(scheduler.activeCallCount).toBe(2);
    releases[0]!.resolve();
    expect(await next).toBe("b");
    releases[1]!.resolve();
    for (const error of await Promise.all(active)) expect((error as Error).name).toBe("AbortError");
    await until(() => scheduler.activeCallCount === 0);
  });

  test("lowering the slot limit waits for admitted calls and keeps queued work", async () => {
    const scheduler = new WorkflowModelScheduler(3);
    const releases = Array.from({ length: 3 }, () => deferred<void>());
    const active = releases.map((release) => scheduler.schedule("a", async () => release.promise));
    await until(() => scheduler.activeCallCount === 3);
    scheduler.setMaxActive(1);
    let started = false;
    const next = scheduler.schedule("b", async () => { started = true; return "b"; });
    releases[0]!.resolve();
    releases[1]!.resolve();
    await until(() => scheduler.activeCallCount === 1);
    expect(started).toBe(false);
    releases[2]!.resolve();
    await Promise.all(active);
    expect(await next).toBe("b");
    expect(scheduler.maxActive).toBe(1);
    expect(() => scheduler.setMaxActive(9)).toThrow("1 to 8");
    expect(() => new WorkflowModelScheduler(1.5)).toThrow("1 to 8");
  });

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
