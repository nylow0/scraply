import { describe, expect, test } from "bun:test";
import { deriveJsonSchema, type JsonSchema } from "../../src/shared/json-schema";
import { STRUCTURED_OUTPUT_SCHEMAS } from "../../src/shared/structured-output-schemas";

const FORBIDDEN_CONSTRAINTS = new Set([
  "minItems",
  "minLength",
  "maxLength",
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
  for (const [name, zodSchema] of Object.entries(STRUCTURED_OUTPUT_SCHEMAS)) {
    test(`${name} derives a Codex-compatible JSON Schema`, () => {
      assertCodexCompatible(deriveJsonSchema(zodSchema));
    });
  }

  test("nullable values remain required keys with explicit null support", () => {
    const jsonSchema = deriveJsonSchema(STRUCTURED_OUTPUT_SCHEMAS.problemCandidates);
    const problems = jsonSchema.properties?.problems;
    const problem = problems?.items?.properties;
    if (!problems?.items || !problem?.scaleBasisFactorId) {
      throw new Error("Problem candidate JSON Schema is missing its nested object shape");
    }

    expect(problems.items.required).toContain("scaleBasisFactorId");
    expect(problem.scaleBasisFactorId.anyOf).toContainEqual({ type: "null" });
  });
});
