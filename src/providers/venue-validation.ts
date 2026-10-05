import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { Source } from "../shared/schemas";
import { EXCLUDED_SOURCE_DOMAINS, SourceVenueSchema, type SourceVenue } from "./source-routes";

export const RESEARCH_VENUE_DNS_TIMEOUT_MS = 2_000;
export type ResearchVenueResolver = (domain: string, options: { signal: AbortSignal }) => Promise<readonly string[]>;
export type VenueVerificationProof = { domain: string; method: "dns" }
  | { domain: string; method: "saved-source"; sourceUrl: string };
export interface VenueVerificationResult {
  /** Only domains with a nonempty actual retrieved source may constrain provider searches. */
  verified: SourceVenue[];
  unresolved: Array<{ venue: SourceVenue; reason: string }>;
  proofs: VenueVerificationProof[];
}

const PRIVATE_DOMAIN_SUFFIXES = ["localhost", "local", "internal", "home", "lan", "corp", "onion", "test", "invalid", "example", "arpa"];

function publicDomain(value: string | undefined): string | null {
  if (!value) return null;
  const domain = value.trim().toLowerCase();
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || labels.some(label => label.length > 63)
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || PRIVATE_DOMAIN_SUFFIXES.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`))
    || EXCLUDED_SOURCE_DOMAINS.some(blocked => domain === blocked || domain.endsWith(`.${blocked}`))) return null;
  return domain;
}

/** DNS may return split-network or reserved addresses. Accept only public unicast results. */
function publicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a !== undefined && b !== undefined && c !== undefined && a > 0 && a < 224
      && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0 && [0, 2].includes(c)))
      && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
      && !(a === 203 && b === 0 && c === 113);
  }
  if (version !== 6) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const first = Number.parseInt(normalized.split(":")[0]!, 16);
  return first >= 0x2000 && first < 0x3fff && first !== 0x2002 && !normalized.startsWith("2001::")
    && !/^2001:(?:db8|2|1[0-9a-f]|2[0-9a-f]):/.test(normalized);
}

const resolvePublicAddresses: ResearchVenueResolver = async (domain, { signal }) => {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: RESEARCH_VENUE_DNS_TIMEOUT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const responses = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
    signal.throwIfAborted();
    if (responses.every(response => response.status === "rejected")) {
      throw new Error("Domain lookup failed");
    }
    return responses.flatMap(response => response.status === "fulfilled" ? response.value : []);
  } finally { signal.removeEventListener("abort", cancel); }
};

/** Validate one flattened frame so repeated domains share a lookup. No pages or IPs are fetched.
 * DNS-only results remain unresolved until an actual provider result supplies nonempty content.
 * Saved sources can verify retrieval, but extraction still checks the proposed venue's content and kind.
 */
export async function validateResearchVenues(venues: readonly SourceVenue[], options: {
  signal?: AbortSignal;
  resolve?: ResearchVenueResolver;
  retrievedSources?: readonly Pick<Source, "url" | "text">[];
  timeoutMs?: number;
} = {}): Promise<VenueVerificationResult> {
  const parsed = SourceVenueSchema.array().max(96).parse(venues);
  options.signal?.throwIfAborted();
  const proofSources = (options.retrievedSources ?? []).flatMap(source => {
    try {
      const url = new URL(source.url);
      const domain = publicDomain(url.hostname);
      return domain && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && source.text.trim()
        ? [{ domain, url: source.url }] : [];
    } catch { return []; }
  });
  const memo = new Map<string, Promise<{ reason: string } | VenueVerificationResult["proofs"][number]>>();
  const result: VenueVerificationResult = { verified: [], unresolved: [], proofs: [] };
  const verify = async (domain: string) => {
    const savedSource = proofSources.find(source => source.domain === domain || source.domain.endsWith(`.${domain}`));
    if (savedSource) return { domain, method: "saved-source" as const, sourceUrl: savedSource.url };
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Domain verification timed out")),
      Math.max(1, Math.min(RESEARCH_VENUE_DNS_TIMEOUT_MS, options.timeoutMs ?? RESEARCH_VENUE_DNS_TIMEOUT_MS)));
    let rejectInterrupted: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectInterrupted = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectInterrupted, { once: true });
      });
      const addresses = await Promise.race([(options.resolve ?? resolvePublicAddresses)(domain, { signal: controller.signal }), interrupted]);
      if (!addresses.length) return { reason: "Domain did not resolve" };
      if (!addresses.every(publicAddress)) return { reason: "Domain resolved to an unsafe or reserved address" };
      return { domain, method: "dns" as const };
    } catch (error) {
      options.signal?.throwIfAborted();
      return { reason: controller.signal.aborted ? "Domain verification timed out" : error instanceof Error ? "Domain lookup failed" : "Domain did not resolve" };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (rejectInterrupted) controller.signal.removeEventListener("abort", rejectInterrupted);
    }
  };
  // A frame has at most 96 venues. Four lookups at a time keep DNS work bounded.
  for (let index = 0; index < parsed.length; index += 4) {
    options.signal?.throwIfAborted();
    const checked = await Promise.all(parsed.slice(index, index + 4).map(async venue => {
      const domain = publicDomain(venue.domain);
      if (!domain) return { venue, verification: { reason: venue.domain ? "Venue needs an allowed public domain name" : "Venue has no domain to verify" } };
      let pending = memo.get(domain);
      if (!pending) { pending = verify(domain); memo.set(domain, pending); }
      return { venue: { ...venue, domain }, verification: await pending };
    }));
    for (const { venue, verification } of checked) {
      if ("reason" in verification) result.unresolved.push({ venue, reason: verification.reason });
      else {
        if (verification.method === "saved-source") result.verified.push(venue);
        else result.unresolved.push({ venue, reason: "Domain resolves but has no retrieved source proof" });
        if (!result.proofs.some(proof => proof.domain === verification.domain)) result.proofs.push(verification);
      }
    }
  }
  options.signal?.throwIfAborted();
  return result;
}
