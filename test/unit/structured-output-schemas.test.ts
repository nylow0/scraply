import { describe, expect, test } from "bun:test";
import { deriveJsonSchema, type JsonSchema } from "../../src/shared/json-schema";
import { BoundedWorkflowV2FactorHarvestOutputSchema, LabeledWorkflowV2FactorHarvestOutputSchema, STRUCTURED_OUTPUT_SCHEMAS } from "../../src/shared/structured-output-schemas";

const FORBIDDEN_CONSTRAINTS = new Set([
  "minItems",
  "minLength",
  "minimum",
  "maximum",
]);

function assertCodexCompatible(schema: JsonSchema, path = "$"): void {
  for (const key of Object.keys(schema)) {
    expect(FORBIDDEN_CONSTRAINTS.has(key), `${path} contains forbidden keyword ${key}`).toBe(false);
  }

  if (schema.type === "object") {
    expect(schema, `${path} must reject extra properties for native strict output`).toHaveProperty("additionalProperties", false);
    const propertyNames = Object.keys(schema.properties ?? {});
    expect(schema.required, `${path}.required must contain every property`).toEqual(propertyNames);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      assertCodexCompatible(child, `${path}.properties.${name}`);
    }
  }

  if (schema.items) assertCodexCompatible(schema.items, `${path}.items`);
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    assertCodexCompatible(child, `${path}.anyOf[${index}]`);
  }
}

describe("structured output schemas", () => {
  test("factor text ceilings reach the provider schema, including nullable origin keys", () => {
    const schema = deriveJsonSchema(BoundedWorkflowV2FactorHarvestOutputSchema);
    const variants = schema.properties?.factors?.items?.anyOf;
    expect(variants).toHaveLength(2);
    for (const variant of variants ?? []) {
      expect(variant.properties?.uncertainty).toEqual({ type: "string", maxLength: 600 });
      expect(variant.properties?.quote).toEqual({ type: "string", maxLength: 1_000 });
    }
    expect(variants?.[1]?.properties?.independentSourceKey?.anyOf).toContainEqual({ type: "string", maxLength: 160 });
    expect(variants?.[1]?.properties?.demandEvidenceUncertainty).toEqual({ type: "string", maxLength: 600 });
  });

  test("new runs accept only labeled facts", () => {
    const fact = { subject: "Bookkeepers", behavior: "chase receipts", quote: "I chase receipts weekly.", sourceId: "source-1",
      uncertainty: "One account.", modelConfidence: 0.8 };
    expect(BoundedWorkflowV2FactorHarvestOutputSchema.safeParse({ factors: [fact] }).success).toBe(true);
    expect(LabeledWorkflowV2FactorHarvestOutputSchema.safeParse({ factors: [fact] }).success).toBe(false);
    expect(LabeledWorkflowV2FactorHarvestOutputSchema.safeParse({ factors: [{ ...fact, sourceRole: "firsthand", audienceFit: "intended-buyer",
      independentSourceKey: "Example bookkeeper", supportsDemand: false, demandEvidenceUncertainty: "No purchase described." }] }).success).toBe(true);
    assertCodexCompatible(deriveJsonSchema(LabeledWorkflowV2FactorHarvestOutputSchema));
  });

  for (const [name, zodSchema] of Object.entries(STRUCTURED_OUTPUT_SCHEMAS)) {
    test(`${name} derives a Codex-compatible JSON Schema`, () => {
      assertCodexCompatible(deriveJsonSchema(zodSchema));
    });
  }

  test("nullable values remain required keys with explicit null support", () => {
    const jsonSchema = deriveJsonSchema(STRUCTURED_OUTPUT_SCHEMAS.problemCandidates);
    const problems = jsonSchema.properties?.problems;
    const problemVariants = problems?.items?.anyOf;
    if (!problemVariants?.length) {
      throw new Error("Problem candidate JSON Schema is missing its object variants");
    }

    for (const problem of problemVariants) {
      expect(problem.required).toContain("scaleBasisFactorId");
      expect(problem.properties?.scaleBasisFactorId?.anyOf).toContainEqual({ type: "null" });
    }
  });
});
