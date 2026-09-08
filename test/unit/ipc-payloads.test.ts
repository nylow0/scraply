import { describe, expect, test } from "bun:test";
import { toFavoriteModelPayload, toRunConfigPayload } from "../../src/renderer/lib/ipc-payloads";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

describe("renderer IPC payloads", () => {
  test("validates the compact run configuration", () => {
    const payload = toRunConfigPayload("thread-1", new Proxy(DEFAULT_RUN_CONFIG, {}));
    expect(payload).toEqual({ threadId: "thread-1", config: DEFAULT_RUN_CONFIG });
    expect(structuredClone(payload)).toEqual(payload);
  });

  test("validates favorite model changes", () => {
    const payload = toFavoriteModelPayload(new Proxy({ providerId: "legacy-codex-cli", modelId: "gpt-5.6" }, {}), true);
    expect(payload).toEqual({ model: { providerId: "legacy-codex-cli", modelId: "gpt-5.6" }, favorite: true });
  });

  test("rejects malformed depth and model data", () => {
    expect(() => toRunConfigPayload("thread-1", { ...DEFAULT_RUN_CONFIG, discoveryDepth: "wide" as never })).toThrow();
    expect(() => toFavoriteModelPayload({ providerId: "legacy-codex-cli", modelId: "" }, true)).toThrow();
  });

  test("defaults legacy configurations to market exploration", () => {
    const legacy = {
      model: "gpt-5.6-luna", reasoningEffort: "medium", discoveryDepth: "standard" as const, maxRunMinutes: 90,
    };
    expect(toRunConfigPayload("thread-1", legacy as never).config).toMatchObject({
      researchMode: "explore-market", knownProblem: "",
    });
  });
});
