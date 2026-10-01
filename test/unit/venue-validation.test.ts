import { describe, expect, spyOn, test } from "bun:test";
import * as dns from "node:dns/promises";
import { routeSearchOptions, type SourceVenue } from "../../src/providers/source-routes";
import { RESEARCH_VENUE_DNS_TIMEOUT_MS, validateResearchVenues } from "../../src/providers/venue-validation";

const venue = (domain?: string): SourceVenue => ({ name: "Operators' forum", kind: "community", ...(domain ? { domain } : {}) });

describe("research venue validation", () => {
  test("uses OS resolution when direct DNS is refused, while keeping DNS-only venues provisional", async () => {
    const refused = Object.assign(new Error("Direct DNS refused"), { code: "ECONNREFUSED" });
    const raw4 = spyOn(dns.Resolver.prototype, "resolve4").mockRejectedValue(refused);
    const raw6 = spyOn(dns.Resolver.prototype, "resolve6").mockRejectedValue(refused);
    const osDns: { lookup: (host: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>> } = dns;
    const system = spyOn(osDns, "lookup").mockResolvedValue([
      { address: "104.21.38.205", family: 4 }, { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const proposed = [venue("cakecentral.com"), { ...venue("cakecentral.com"), name: "Cake business forum" }];
    try {
      const result = await validateResearchVenues(proposed);
      expect(system).toHaveBeenCalledTimes(1);
      expect(system).toHaveBeenCalledWith("cakecentral.com", { all: true });
      expect(result.proofs).toEqual([{ domain: "cakecentral.com", method: "dns" }]);
      expect(result.verified).toEqual([]);
      expect(result.unresolved).toEqual(proposed.map(item => ({
        venue: item, reason: "Domain resolves but has no retrieved source proof",
      })));
      expect(raw4).not.toHaveBeenCalled();
      expect(raw6).not.toHaveBeenCalled();
      expect(routeSearchOptions("community", { venues: result.verified }).includeDomains).not.toContain("cakecentral.com");
      system.mockResolvedValue([{ address: "104.21.38.205", family: 4 }, { address: "127.0.0.1", family: 4 }]);
      const unsafe = await validateResearchVenues([venue("cakecentral.com")]);
      expect(unsafe.proofs).toEqual([]);
      expect(unsafe.verified).toEqual([]);
      expect(unsafe.unresolved[0]?.reason).toBe("Domain resolved to an unsafe or reserved address");
    } finally { system.mockRestore(); raw4.mockRestore(); raw6.mockRestore(); }
  });

  test("an unresolved proposed domain keeps the common route fallback", async () => {
    const result = await validateResearchVenues([venue("made-up-forum.org")], { resolve: async () => [] });
    expect(result.verified).toEqual([]);
    expect(result.unresolved).toEqual([{ venue: venue("made-up-forum.org"), reason: "Domain did not resolve" }]);
    expect(routeSearchOptions("community", { venues: result.verified }).includeDomains)
      .toEqual(["reddit.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com"]);
  });

  test("missing, private, excluded and malformed domains never reach DNS", async () => {
    let lookups = 0;
    const proposed = [venue(), ...["localhost", "service.local", "reports.internal", "reports.test", "127.0.0.1",
      "[::1]", "https://forum.org/path", "user@forum.org", "forum.org:443", "forum.org/path", "sub.worldmetrics.org",
      "linkedin.com", `${"a".repeat(64)}.org`].map(venue)];
    const result = await validateResearchVenues(proposed, { resolve: async () => { lookups++; return ["1.1.1.1"]; } });
    expect(lookups).toBe(0);
    expect(result.verified).toEqual([]);
    expect(result.unresolved).toHaveLength(proposed.length);
  });

  test("all frame areas share one domain lookup while keeping their named venues", async () => {
    const domains: string[] = [];
    const proposed = [venue("Forum.org"), { ...venue("forum.org"), name: "Official reports", kind: "official" as const },
      { ...venue("forum.org"), name: "Maintainers", kind: "issue-tracker" as const }];
    const result = await validateResearchVenues(proposed, { resolve: async domain => { domains.push(domain); return ["1.1.1.1", "2606:4700:4700::1111"]; } });
    expect(domains).toEqual(["forum.org"]);
    expect(result.verified).toEqual([]);
    expect(result.proofs).toEqual([{ domain: "forum.org", method: "dns" }]);
    expect(result.unresolved).toEqual(proposed.map(item => ({
      venue: { ...item, domain: "forum.org" }, reason: "Domain resolves but has no retrieved source proof",
    })));
    expect(routeSearchOptions("community", { venues: result.verified }).includeDomains).not.toContain("forum.org");
  });

  test("a DNS-only venue enters domain filters only after a provider returns a nonempty source", async () => {
    const proposed = venue("forum.org");
    const provisional = await validateResearchVenues([proposed], { resolve: async () => ["1.1.1.1"] });
    expect(provisional.verified).toEqual([]);
    expect(provisional.proofs).toEqual([{ domain: "forum.org", method: "dns" }]);
    expect(routeSearchOptions("community", { venues: provisional.verified }).includeDomains).not.toContain("forum.org");
    const empty = await validateResearchVenues([proposed], {
      resolve: async () => ["1.1.1.1"], retrievedSources: [{ url: "https://forum.org/thread", text: " " }],
    });
    expect(empty.verified).toEqual([]);
    const retrieved = await validateResearchVenues([proposed], {
      resolve: async () => { throw new Error("Saved retrieval needs no new DNS lookup"); },
      retrievedSources: [{ url: "https://forum.org/thread", text: "We repeated this filing last week." }],
    });
    expect(retrieved.verified).toEqual([proposed]);
    expect(retrieved.proofs).toEqual([{ domain: "forum.org", method: "saved-source", sourceUrl: "https://forum.org/thread" }]);
    expect(routeSearchOptions("community", { venues: retrieved.verified }).includeDomains).toContain("forum.org");
  });

  test.each(["127.0.0.1", "10.1.2.3", "172.16.0.2", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.1.1.1", "::1", "fc00::1", "fe80::1", "2001:db8::1",
    "::ffff:127.0.0.1", "2002:7f00:1::1", "not-an-address"])("rejects resolution containing %s even alongside a public address", async address => {
    const result = await validateResearchVenues([venue("forum.org")], { resolve: async () => ["1.1.1.1", address] });
    expect(result.verified).toEqual([]);
    expect(result.unresolved[0]?.reason).toBe("Domain resolved to an unsafe or reserved address");
  });

  test("a retrieved nonempty source from the venue domain provides saved proof without another lookup", async () => {
    let lookups = 0;
    const source = { url: "https://reports.agency.gov/observations", text: "Measured adoption was retained after the pilot." };
    const result = await validateResearchVenues([{ name: "Agency reports", kind: "official", domain: "agency.gov" }], {
      retrievedSources: [source], resolve: async () => { lookups++; return []; },
    });
    expect(lookups).toBe(0);
    expect(result.verified).toHaveLength(1);
    expect(result.proofs).toEqual([{ domain: "agency.gov", method: "saved-source", sourceUrl: source.url }]);
  });

  test("empty excerpts, credentials and look-alike source hosts cannot prove a venue", async () => {
    let lookups = 0;
    const result = await validateResearchVenues([venue("agency.gov")], {
      retrievedSources: [{ url: "https://agency.gov/empty", text: " " }, { url: "https://user@agency.gov/report", text: "Claim" },
        { url: "https://notagency.gov/report", text: "Claim" }, { url: "file://agency.gov/report", text: "Claim" }],
      resolve: async () => { lookups++; throw new Error("DNS unavailable"); },
    });
    expect(lookups).toBe(1);
    expect(result.verified).toEqual([]);
    expect(result.unresolved[0]?.reason).toBe("Domain lookup failed");
  });

  test("an unresponsive resolver times out and receives cancellation", async () => {
    let lookupSignal: AbortSignal | undefined;
    const result = await validateResearchVenues([venue("forum.org")], {
      timeoutMs: 10, resolve: async (_domain, { signal }) => { lookupSignal = signal; return new Promise<readonly string[]>(() => {}); },
    });
    expect(RESEARCH_VENUE_DNS_TIMEOUT_MS).toBe(2_000);
    expect(lookupSignal?.aborted).toBe(true);
    expect(result.verified).toEqual([]);
    expect(result.unresolved[0]?.reason).toBe("Domain verification timed out");
  });

  test("user cancellation aborts validation rather than checkpointing an unresolved venue", async () => {
    const controller = new AbortController();
    let lookupSignal: AbortSignal | undefined;
    const running = validateResearchVenues([venue("forum.org")], {
      signal: controller.signal,
      resolve: async (_domain, { signal }) => { lookupSignal = signal; return new Promise<readonly string[]>(() => {}); },
    });
    controller.abort(new Error("User cancelled"));
    await expect(running).rejects.toThrow("User cancelled");
    expect(lookupSignal?.aborted).toBe(true);
  });
});
