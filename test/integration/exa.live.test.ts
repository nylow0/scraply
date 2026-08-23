import { describe, expect, test } from "bun:test";
import { ExaClient } from "../../src/providers/exa";

const enabled = process.env.RUN_EXA_LIVE === "1" && Boolean(process.env.EXA_API_KEY);
const liveTest = enabled ? test : test.skip;

describe("Exa live probe", () => {
  liveTest("validates configured key", async () => {
    const client = new ExaClient(process.env.EXA_API_KEY!);
    const result = await client.validateKey();
    expect(result.valid).toBe(true);
  }, 30000);
});
