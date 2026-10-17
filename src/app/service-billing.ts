import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createBillingPreflight } from "../core/billing-preflight";
import { canonicalJson } from "../shared/content-identity";
import {
  ExecuteOperationRequestSchema, ExecuteOperationResultSchema, PreviewOperationRequestSchema,
  SearchKeyCredentialReferenceSchema, type OperationProposal,
} from "../shared/cli-contracts";
import { AppErrorPayloadSchema, IPC_CHANNELS, SaveSearchKeySchema } from "../shared/ipc";
import { AppError, toErrorPayload } from "../shared/errors";
import type { z } from "zod";

type SearchKey = z.infer<typeof SaveSearchKeySchema>;
type Operation = OperationProposal["operation"];
const channels = new Set<string>([IPC_CHANNELS.GET_VALIDATION, IPC_CHANNELS.RETRY_CONNECTION, IPC_CHANNELS.SAVE_SEARCH_KEY]);

export function isServiceBillingChannel(channel: string): boolean {
  return channels.has(channel);
}

interface ServiceBillingOptions {
  capabilities(): Promise<unknown>;
  privateState(): unknown;
  validate(channel: string, key?: SearchKey): Promise<void>;
  dispatch(channel: string, payload: unknown): Promise<unknown>;
}

/** Provider probes need consent too. Keys stay in this owner's bounded, expiring memory. */
export function createServiceBilling(options: ServiceBillingOptions) {
  const stateKey = randomBytes(32);
  const candidates = new Map<string, { key: SearchKey; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  let epoch = 0;
  const fingerprint = (value: unknown) => createHmac("sha256", stateKey).update(canonicalJson(value)).digest("hex");

  function forget(reference: string): void {
    const candidate = candidates.get(reference);
    if (candidate) clearTimeout(candidate.timer);
    candidates.delete(reference);
  }

  function candidateFor(operation: Operation): SearchKey | undefined {
    if (operation.channel !== IPC_CHANNELS.SAVE_SEARCH_KEY) return undefined;
    const { provider, credentialRef } = SearchKeyCredentialReferenceSchema.parse(operation.payload);
    const candidate = candidates.get(credentialRef);
    if (!candidate || candidate.key.provider !== provider || candidate.expiresAt <= Date.now()) {
      forget(credentialRef);
      throw new AppError("PREVIEW_STALE", "Preview this key change again.");
    }
    return candidate.key;
  }

  const billing = createBillingPreflight({
    capabilities: async () => fingerprint(await options.capabilities()),
    state: operation => fingerprint({ epoch, state: options.privateState(), candidate: candidateFor(operation) ?? null }),
    validate: operation => options.validate(operation.channel, candidateFor(operation)),
    describe: operation => operation.channel === IPC_CHANNELS.SAVE_SEARCH_KEY
      ? `Check and save the ${SearchKeyCredentialReferenceSchema.parse(operation.payload).provider} key. Its connection check uses a provider search and may be billed.`
      : operation.channel === IPC_CHANNELS.RETRY_CONNECTION
        ? "Retry connections and check configured search keys. Provider connection checks use searches and may be billed."
        : "Check configured search keys. Provider connection checks use searches and may be billed.",
  });

  async function preview(input: unknown): Promise<OperationProposal> {
    const requested = PreviewOperationRequestSchema.parse(input);
    if (!isServiceBillingChannel(requested.channel)) throw new AppError("validation_error");
    if (requested.channel !== IPC_CHANNELS.SAVE_SEARCH_KEY) return billing.preview(requested);
    const key = SaveSearchKeySchema.parse(requested.payload);
    for (const [reference, candidate] of candidates) {
      if (candidate.expiresAt <= Date.now() || candidate.key.provider === key.provider) forget(reference);
    }
    // Only two providers exist, but retain a hard bound if the provider contract expands.
    while (candidates.size >= 64) forget(candidates.keys().next().value!);
    const credentialRef = randomUUID();
    const timer = setTimeout(() => forget(credentialRef), 10 * 60_000);
    timer.unref();
    candidates.set(credentialRef, { key, expiresAt: Date.now() + 10 * 60_000, timer });
    try {
      const proposal = await billing.preview({ channel: requested.channel, payload: { provider: key.provider, credentialRef } });
      const candidate = candidates.get(credentialRef);
      if (!candidate) throw new AppError("PREVIEW_STALE");
      candidate.expiresAt = Math.min(candidate.expiresAt, Date.parse(proposal.expiresAt));
      return proposal;
    } catch (error) {
      forget(credentialRef);
      throw error;
    }
  }

  async function execute(input: unknown) {
    const { proposal } = ExecuteOperationRequestSchema.parse(input);
    if (!isServiceBillingChannel(proposal.operation.channel)) throw new AppError("validation_error");
    return billing.execute(proposal, async operation => {
      const key = candidateFor(operation);
      if (key) forget(SearchKeyCredentialReferenceSchema.parse(operation.payload).credentialRef);
      try {
        const result = await options.dispatch(operation.channel, key ?? operation.payload);
        return ExecuteOperationResultSchema.parse({ channel: operation.channel, result });
      } catch (error) {
        if (!key) throw error;
        // A provider may echo a rejected credential in its error. Never send that back to a caller.
        const failure = toErrorPayload(error);
        const encodedKey = JSON.stringify(key.apiKey).slice(1, -1);
        const safe = AppErrorPayloadSchema.parse(JSON.parse(JSON.stringify(failure.error).replaceAll(encodedKey, "[redacted]")));
        throw new AppError(safe.code, safe.message, failure.status, safe.reference, safe.recovery);
      }
    });
  }

  return {
    preview, execute,
    clear() {
      epoch += 1;
      for (const reference of candidates.keys()) forget(reference);
    },
  };
}
