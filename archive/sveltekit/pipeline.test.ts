import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertGroundedClaims, persistResult, runPipeline } from "../src/pipeline";

const source = { id: "s1", url: "https://example.com", title: "Example", text: "Revenue grew by 20 percent in 2025." };
const claim = { text: "Revenue grew by 20 percent in 2025.", sourceIds: ["s1"], evidence: [{ sourceId: "s1", quote: "Revenue grew by 20 percent" }], confidence: 0.95 };

describe("pipeline", () => {
  test("produces and persists validated embedded claims with mocked APIs", async () => {
    const result = await runPipeline("revenue", {
      search: { search: async () => [source] },
      extractor: { extract: async () => ({ claims: [claim] }) },
      embeddings: { embed: async () => ({ vectors: [[0.1, 0.2]], provider: "local", model: "test-model" }) },
      workerModel: "mimo-v2.5",
    });
    expect(result.claims[0]).toMatchObject({ id: "claim-1", embedding: [0.1, 0.2] });
    expect(result.embedding).toEqual({ provider: "local", model: "test-model", dimensions: 2 });

    const path = join(await mkdtemp(join(tmpdir(), "scraply-")), "nested", "result.json");
    await persistResult(result, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
  });

  test("rejects fabricated quotes and unknown sources", () => {
    expect(() => assertGroundedClaims([{ ...claim, evidence: [{ sourceId: "s1", quote: "not in source" }] }], [source])).toThrow("not found verbatim");
    expect(() => assertGroundedClaims([{ ...claim, sourceIds: ["missing"] }], [source])).toThrow("unknown source");
  });
});
