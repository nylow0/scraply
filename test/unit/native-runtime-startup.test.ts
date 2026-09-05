import { describe, expect, test } from "bun:test";
import { createNativeRuntimeStartup } from "../../src/backend/native-runtime-startup";

describe("native runtime startup", () => {
  test("allows retry after startup failure and stays ready when a saved credential is invalid", async () => {
    let starts = 0;
    let logouts = 0;
    const restoreErrors: Array<{ providerId: string; error: unknown }> = [];
    const startup = createNativeRuntimeStartup({
      async start() {
        starts += 1;
        if (starts === 1) throw new Error("transient startup failure");
      },
      async restoreCredential() { throw new Error("expired saved credential"); },
      async logout() { logouts += 1; },
    }, () => ({ "openai-subscription": "expired-credential" }), (providerId, error) => {
      restoreErrors.push({ providerId, error });
    });

    await expect(startup.prepare()).rejects.toThrow("transient startup failure");
    expect(startup.status()).toEqual({ ready: false, error: "transient startup failure" });
    await startup.prepare();
    expect(startup.status()).toEqual({ ready: true });
    expect(logouts).toBe(1);
    expect(restoreErrors).toEqual([{ providerId: "openai-subscription", error: expect.any(Error) }]);
  });

  test("keeps explicit login preparation behind an in-flight saved credential restore", async () => {
    let releaseRestore!: () => void;
    const restoreStarted = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let enteredRestore!: () => void;
    const entered = new Promise<void>((resolve) => { enteredRestore = resolve; });
    const startup = createNativeRuntimeStartup({
      async start() {},
      async restoreCredential() {
        enteredRestore();
        await restoreStarted;
      },
    }, () => ({ "openai-subscription": "saved-credential" }), () => undefined);

    const background = startup.prepare();
    await entered;
    let loginPreparationFinished = false;
    const loginPreparation = startup.prepare().then(() => { loginPreparationFinished = true; });
    await Promise.resolve();
    expect(loginPreparationFinished).toBe(false);
    expect(startup.status()).toEqual({ ready: false });
    releaseRestore();
    await Promise.all([background, loginPreparation]);
    expect(startup.status()).toEqual({ ready: true });
  });
});
