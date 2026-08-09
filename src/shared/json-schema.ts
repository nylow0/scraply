import { z } from "zod";

export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  anyOf?: JsonSchema[];
};

export function deriveJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const definition = schema._def;

  switch (definition.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = definition.shape() as z.ZodRawShape;
      const properties = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, deriveJsonSchema(value)]),
      );
      return { type: "object", properties, required: Object.keys(properties) };
    }
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: deriveJsonSchema(definition.type) };
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: "string" };
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const isInteger = definition.checks.some((check: { kind: string }) => check.kind === "int");
      return { type: isInteger ? "integer" : "number" };
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...definition.values] };
    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const value = definition.value as string | number | boolean;
      return { type: typeof value as "string" | "number" | "boolean", enum: [value] };
    }
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return { anyOf: [deriveJsonSchema(definition.innerType), { type: "null" }] };
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: definition.options.map((option: z.ZodTypeAny) => deriveJsonSchema(option)) };
    default:
      throw new Error(`Unsupported structured-output schema type: ${String(definition.typeName)}`);
  }
}

