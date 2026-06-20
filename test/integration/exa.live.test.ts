import { describe, expect, test } from "bun:test";
import { ExaClient } from "../../src/providers/exa";

const enabled = process.env.RUN_EXA_LIVE === "1" && process.env.EXA_API_KEY;

describe("Exa live probe", () => {
  test("validates configured key", async () => {
    if (!enabled) return;
    const client = new ExaClient(process.env.EXA_API_KEY!);
    const result = await client.validateKey();
    expect(result.valid).toBe(true);
  }, 30000);
});
