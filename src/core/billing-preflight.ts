import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "../shared/content-identity";
import { AppError } from "../shared/errors";
import {
  isBillableOperation, OperationProposalSchema, OperationRequestSchema,
  type OperationProposal,
} from "../shared/cli-contracts";

type Operation = OperationProposal["operation"];
export interface BillingPreflightOptions {
  capabilities: () => Promise<string>;
  state: (operation: Operation) => string | Promise<string>;
  validate: (operation: Operation) => void | Promise<void>;
  describe: (operation: Operation) => string;
}

/** Owner-issued consent, shared by transports. A restart invalidates outstanding proofs, never replays them. */
export function createBillingPreflight(options: BillingPreflightOptions) {
  const signingKey = randomBytes(32);
  const consumed = new Map<string, number>();
  const sign = (proposal: Omit<OperationProposal, "previewHash">) => createHmac("sha256", signingKey)
    .update(canonicalJson(proposal)).digest("hex");

  async function preview(input: unknown): Promise<OperationProposal> {
    for (const [hash, expiresAt] of consumed) if (expiresAt <= Date.now()) consumed.delete(hash);
    const operation = OperationRequestSchema.parse(input);
    if (!isBillableOperation(operation.channel, operation.payload)) {
      throw new AppError("validation_error", "This operation does not require a billing preview.");
    }
    const capabilityFingerprint = await options.capabilities();
    await options.validate(operation);
    const payload = operation.payload as { previewExpiresAt?: string; action?: { previewExpiresAt?: string } };
    const existingExpiry = payload.previewExpiresAt ?? payload.action?.previewExpiresAt;
    const expiry = Math.min(Date.now() + 10 * 60_000, existingExpiry ? Date.parse(existingExpiry) : Infinity);
    if (expiry <= Date.now()) throw new AppError("PREVIEW_STALE");
    const proposal = {
      operation, expiresAt: new Date(expiry).toISOString(), capabilityFingerprint,
      stateFingerprint: await options.state(operation), summary: options.describe(operation), billing: "billable" as const,
    };
    return OperationProposalSchema.parse({ ...proposal, previewHash: sign(proposal) });
  }

  async function verify(input: unknown): Promise<OperationProposal> {
    const proposal = OperationProposalSchema.parse(input);
    const { previewHash, ...signed } = proposal;
    if (consumed.has(previewHash) || sign(signed) !== previewHash || !isBillableOperation(proposal.operation.channel, proposal.operation.payload)
      || Date.parse(proposal.expiresAt) <= Date.now() || Date.parse(proposal.expiresAt) > Date.now() + 10 * 60_000
      || proposal.capabilityFingerprint !== await options.capabilities()) throw new AppError("PREVIEW_STALE");
    if (proposal.stateFingerprint !== await options.state(proposal.operation)) throw new AppError("PREVIEW_STALE", "The project changed. Preview this operation again.");
    await options.validate(proposal.operation);
    if (proposal.stateFingerprint !== await options.state(proposal.operation)) throw new AppError("PREVIEW_STALE", "The project changed. Preview this operation again.");
    return proposal;
  }

  async function execute<T>(input: unknown, dispatch: (operation: Operation) => Promise<T>): Promise<T> {
    const proposal = await verify(input);
    // Recheck after every await: another execution may have consumed this proof,
    // or expiry cleanup may have removed its record while verification was waiting.
    if (consumed.has(proposal.previewHash) || Date.parse(proposal.expiresAt) <= Date.now()) {
      throw new AppError("PREVIEW_STALE");
    }
    // Consume before dispatch, including failures and lost responses. Clients must deliberately preview again.
    consumed.set(proposal.previewHash, Date.parse(proposal.expiresAt));
    return dispatch(proposal.operation);
  }
  return { preview, verify, execute };
}
