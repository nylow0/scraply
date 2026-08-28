import { describe, expect, test } from "bun:test";
import { BackendToMainMessageSchema, MainToBackendMessageSchema } from "../../src/shared/backend-process";

const secrets = { exaApiKey: "exa-test", perplexityApiKey: "perplexity-test" };

describe("backend utility protocol", () => {
  test("requires request IDs for acknowledged secret updates", () => {
    expect(MainToBackendMessageSchema.safeParse({
      type: "update-secrets",
      requestId: "request-1",
      secrets,
    }).success).toBe(true);
    expect(MainToBackendMessageSchema.safeParse({ type: "update-secrets", secrets }).success).toBe(false);
    expect(BackendToMainMessageSchema.safeParse({
      type: "secrets-updated",
      requestId: "request-1",
    }).success).toBe(true);
  });

  test("rejects malformed startup and event messages", () => {
    expect(MainToBackendMessageSchema.safeParse({
      type: "start",
      dataDir: "data",
      dbPath: "database",
      bundledPromptsDir: "prompts",
      promptOverridesDir: "overrides",
      appVersion: "0.3.0",
      secrets,
    }).success).toBe(true);
    expect(MainToBackendMessageSchema.safeParse({ type: "start", secrets }).success).toBe(false);
    expect(BackendToMainMessageSchema.safeParse({
      type: "event",
      event: { type: "run-failed", runId: "run-1", error: "missing thread" },
    }).success).toBe(false);
  });
});
