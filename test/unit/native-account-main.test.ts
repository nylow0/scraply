import { describe, expect, test } from "bun:test";
import { revokeNativeAccount } from "../../src/main/native-account";

describe("main-owned native account cleanup", () => {
  test("revokes the runtime account even when encrypted credential removal fails", async () => {
    const persistenceError = new Error("encrypted store unavailable");
    let revoked = false;

    await expect(revokeNativeAccount(
      () => { throw persistenceError; },
      async () => { revoked = true; },
    )).rejects.toBe(persistenceError);

    expect(revoked).toBe(true);
  });
});
