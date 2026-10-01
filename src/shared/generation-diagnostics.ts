import { z } from "zod";
import { GenerationMetadataSchema } from "./runtime-protocol";

/** App-side validation diagnostics; never part of the native generation request or output contract. */
export const SchemaValidationFailureSchema = z.object({
  generationId: z.string().min(1),
  output: z.unknown(),
  issues: z.array(z.object({ code: z.string(), path: z.array(z.union([z.string(), z.number()])), message: z.string() }).strict()),
  metadata: GenerationMetadataSchema,
}).strict();
export type SchemaValidationFailure = z.infer<typeof SchemaValidationFailureSchema>;

export const SavedSchemaValidationFailureSchema = SchemaValidationFailureSchema.extend({
  parentAttemptId: z.string().min(1), parentRequestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.string().datetime(),
}).strict();
