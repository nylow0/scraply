import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CredentialResultSchema, GenerationStartPayloadSchema, InitializeResultSchema,
  ModelMetadataSchema, RUNTIME_PROTOCOL_VERSION, ServerEnvelopeSchema,
} from "../../src/shared/runtime-protocol";
import { encodeRuntimeEnvelope } from "../../src/providers/runtime";

const FIXTURE_DIRECTORY = join(import.meta.dir, "..", "fixtures", "runtime-v1.1");
const FROZEN_RUNTIME_COMMIT = "ab9fcfc859ee19fff8dfd4c05c854ab5d145baf8";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, name), "utf8"));
}

describe(`runtime 1.1 contract snapshots from ${FROZEN_RUNTIME_COMMIT}`, () => {
  test("parses every copied server envelope without projecting away terminal metadata", () => {
    const responseNames = readdirSync(FIXTURE_DIRECTORY).filter((name) => name.endsWith("response.json") || name.endsWith("event.json"));
    for (const name of responseNames) ServerEnvelopeSchema.parse(fixture(name));

    const initialized = ServerEnvelopeSchema.parse(fixture("initialize.response.json"));
    expect("result" in initialized ? InitializeResultSchema.parse(initialized.result).selectedProtocolVersion : null)
      .toBe(RUNTIME_PROTOCOL_VERSION);

    const completed = ServerEnvelopeSchema.parse(fixture("generation.completed.event.json"));
    if (!("event" in completed) || completed.event.kind !== "generation.completed") throw new Error("Expected completed fixture");
    expect(completed.event.result.metadata.attempts[0]).toMatchObject({
      outcome: "completed",
      providerCompletion: "confirmed",
      usage: { status: "known" },
      cost: { status: "not_reported" },
    });

    const failed = ServerEnvelopeSchema.parse(fixture("generation.repair-failed.event.json"));
    if (!("event" in failed) || failed.event.kind !== "generation.failed") throw new Error("Expected failed fixture");
    expect(failed.event.attempts).toHaveLength(2);
    expect(failed.event.attempts?.[1]).toMatchObject({ attempt: "schema_repair", outcome: "failed" });
  });

  test("validates the exact qualified request, account credential, and model shapes", () => {
    const start = fixture("generation.start.request.json") as { payload: unknown };
    expect(GenerationStartPayloadSchema.parse(start.payload).model).toEqual({
      providerId: "openai-subscription",
      modelId: "gpt-fixture",
    });

    const refresh = ServerEnvelopeSchema.parse(fixture("account.refresh.response.json"));
    if (!("result" in refresh)) throw new Error("Expected refresh response");
    expect(CredentialResultSchema.parse(refresh.result).credential).toBe("opaque-session-credential");

    const models = ServerEnvelopeSchema.parse(fixture("model.list.response.json"));
    if (!("result" in models)) throw new Error("Expected model response");
    const parsed = models.result as { models: unknown[] };
    expect(parsed.models.map((model) => ModelMetadataSchema.parse(model).identity.providerId))
      .toEqual(["openai-subscription"]);
  });

  test("counts the envelope limit before the trailing line delimiter", () => {
    const base = encodeRuntimeEnvelope("i", "account.list", { padding: "" });
    const exact = encodeRuntimeEnvelope("i", "account.list", { padding: "x".repeat(16_777_217 - base.length) });
    expect(exact.length).toBe(16_777_217);
    expect(() => encodeRuntimeEnvelope("i", "account.list", { padding: "x".repeat(16_777_218 - base.length) }))
      .toThrow("request is too large");
  });
});
