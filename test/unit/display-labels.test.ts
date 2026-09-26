import { describe, expect, test } from "bun:test";
import { modelDisplayName, providerDisplayName } from "../../src/renderer/lib/research-defaults";
import { verdictLabel } from "../../src/renderer/lib/status";

describe("display labels", () => {
  test("names every OpenAI model variant the same way, whatever the catalog calls it", () => {
    expect(modelDisplayName({ modelId: "gpt-6-sol", displayName: "Sol" })).toBe("GPT-6 Sol");
    expect(modelDisplayName({ modelId: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" })).toBe("GPT-5.6 Terra");
    expect(modelDisplayName({ modelId: "gpt-5.5", displayName: "GPT-5.5" })).toBe("GPT-5.5");
    expect(modelDisplayName({ modelId: "gpt-test" })).toBe("gpt-test");
  });

  test("shows problem verdicts as words instead of stored codes", () => {
    expect(verdictLabel("user-asserted")).toBe("User-stated");
    expect(verdictLabel("insufficient-evidence")).toBe("Insufficient evidence");
    expect(verdictLabel("newly-added-verdict")).toBe("Newly added verdict");
  });

  test("names current and historical providers in saved setup", () => {
    expect(providerDisplayName("openai-subscription")).toBe("OpenAI");
    expect(providerDisplayName("legacy-codex-cli")).toBe("Codex CLI (legacy)");
    expect(providerDisplayName("future-provider")).toBe("Future provider");
  });
});
