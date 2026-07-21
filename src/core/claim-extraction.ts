import { ClaimExtractionSchema, type ClaimExtraction, type Source } from "../shared/schemas";
import type { StructuredCallOptions, StructuredModelClient } from "../providers/structured";

export const CLAIM_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sourceId: { type: "string" },
                quote: { type: "string" },
              },
              required: ["sourceId", "quote"],
            },
          },
          confidence: { type: "number" },
        },
        required: ["text", "sourceIds", "evidence", "confidence"],
      },
    },
  },
  required: ["claims"],
} as const;

export function extractClaims(
  client: StructuredModelClient,
  model: string,
  query: string,
  sources: Source[],
  systemPrompt: string,
  options: StructuredCallOptions = {},
): Promise<ClaimExtraction> {
  const sourceText = sources.map((source) =>
    `<source id="${source.id}" title=${JSON.stringify(source.title)} url=${JSON.stringify(source.url)}>\n${source.text}\n</source>`,
  ).join("\n\n");
  return client.structuredCompletion(
    model,
    systemPrompt,
    `Research query: ${query}\n\nSources:\n${sourceText}`,
    ClaimExtractionSchema,
    CLAIM_EXTRACTION_JSON_SCHEMA,
    options,
  );
}
