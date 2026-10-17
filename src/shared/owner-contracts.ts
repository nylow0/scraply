import { z } from "zod";

export const OwnerKindSchema = z.enum(["desktop", "cli"]);
export const OwnerMetadataSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  kind: OwnerKindSchema,
  version: z.string().trim().min(1).max(128),
}).strict();
export const OwnerHealthSchema = OwnerMetadataSchema.omit({ token: true });
export const OwnerInvocationSchema = z.object({
  channel: z.string().min(1).max(128),
  payload: z.unknown().optional(),
}).strict();
export const OwnerStopSchema = z.object({ force: z.boolean().default(false) }).strict();
export const OwnerStopResultSchema = z.object({ stopped: z.boolean() }).strict();
export const OwnerErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(512),
  reference: z.string().min(1).max(128).optional(),
  recovery: z.record(z.unknown()).optional(),
}).strict();
export const OwnerResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: OwnerErrorSchema }).strict(),
]);

export type OwnerMetadata = z.infer<typeof OwnerMetadataSchema>;
export type OwnerHealth = z.infer<typeof OwnerHealthSchema>;
export type OwnerKind = z.infer<typeof OwnerKindSchema>;
export type OwnerErrorPayload = z.infer<typeof OwnerErrorSchema>;

export class OwnerTransportError extends Error {
  readonly code: string;
  readonly recovery: Record<string, unknown> | undefined;
  readonly reference: string | undefined;
  readonly status: number;

  constructor(error: OwnerErrorPayload, status = 503) {
    super(error.message);
    this.name = "OwnerTransportError";
    this.code = error.code;
    this.recovery = error.recovery;
    this.reference = error.reference;
    this.status = status;
  }
}

export function ownerVersionError(owner: OwnerHealth, clientVersion: string) {
  return new OwnerTransportError({
    code: "OWNER_VERSION_MISMATCH",
    message: `Scraply ${owner.kind} owner is version ${owner.version}. Install Scraply ${owner.version} to connect, or close it and start version ${clientVersion}.`,
    recovery: { ownerKind: owner.kind, ownerVersion: owner.version, requiredVersion: owner.version, clientVersion },
  }, 409);
}
