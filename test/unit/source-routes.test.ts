import { describe, expect, test } from "bun:test";
import { chooseSearchProvider, filterRoutedSources, isContentFarm, routeSearchOptions, routingLanguages, searchRoutes, vendorDominatedDomains } from "../../src/providers/source-routes";
import { researchSearchAllocation } from "../../src/shared/research-revisions";

describe("source routing", () => {
  test("reserves every paired search leg within an explicit allowance and retains legacy allocations", () => {
    for (const depth of ["quick", "standard", "deep"] as const) for (const languageCount of [1, 2, 3]) for (let searches = 0; searches <= 30; searches += 1) {
      const allocation = researchSearchAllocation(searches, depth, true, languageCount);
      expect(allocation.searchLegs).toBeLessThanOrEqual(searches);
      expect(allocation.searchLegs).toBe((allocation.domainQueries + allocation.audienceQueries) * 2 * languageCount + allocation.candidateLimit);
    }
    expect(researchSearchAllocation(10, "standard", false)).toMatchObject({ domainQueries: 3, audienceQueries: 3, candidateLimit: 4, searchLegs: 10 });
    expect(researchSearchAllocation(10, "quick")).toMatchObject({ domainQueries: 2, audienceQueries: 1, candidateLimit: 3, searchLegs: 9 });
  });
  test("pairs firsthand questions with their venue and keeps review sites for alternatives", () => {
    expect(searchRoutes("firsthand-experience")).toEqual(["open-web", "community"]);
    expect(searchRoutes("firsthand-experience", { venues: [{ name: "Tool tracker", kind: "issue-tracker", domain: "github.com" }] }))
      .toEqual(["open-web", "issue-tracker"]);
    expect(searchRoutes("firsthand-experience", { venues: [{ name: "Public posts", kind: "social", domain: "bsky.app" }] }))
      .toEqual(["open-web", "community"]);
    expect(searchRoutes("firsthand-experience", { socialEnabled: true, venues: [{ name: "Public posts", kind: "social", domain: "bsky.app" }] }))
      .toEqual(["open-web", "social"]);
    expect(searchRoutes("measured-behavior")).toEqual(["studies-official"]);
    expect(searchRoutes("current-alternative")).toEqual(["alternatives"]);
    expect(searchRoutes("contrary-evidence")).toEqual(["contrary"]);
    expect(searchRoutes("buying-signal")).toEqual(["buying"]);
  });

  test("changes a zero-yield firsthand route and routes both valid providers", () => {
    expect(searchRoutes("firsthand-experience", { previousFirsthandRoute: "community" })).toEqual(["open-web", "issue-tracker"]);
    expect(chooseSearchProvider("auto", { exa: true, perplexity: true }, "open-web")).toBe("perplexity");
    expect(chooseSearchProvider("auto", { exa: true, perplexity: true }, "community")).toBe("exa");
    expect(chooseSearchProvider("auto", { exa: true, perplexity: true }, "studies-official")).toBe("exa");
    expect(chooseSearchProvider("auto", { exa: false, perplexity: true }, "community")).toBe("perplexity");
    expect(chooseSearchProvider("auto", { exa: true, perplexity: false }, "alternatives")).toBe("exa");
    expect(() => chooseSearchProvider("exa", { perplexity: true }, "community")).toThrow("unavailable");
    expect(() => chooseSearchProvider("auto", {})).toThrow("Connect");
  });

  test("uses three-year firsthand and buying recency without limiting studies or contrary evidence", () => {
    const context = { now: new Date("2026-09-30T12:00:00.000Z"), languages: ["uk"], region: "ua" };
    expect(routeSearchOptions("community", context)).toMatchObject({
      startPublishedDate: "2023-09-30T12:00:00.000Z", languages: ["en", "uk"], userLocation: "UA",
      includeDomains: ["reddit.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com"],
    });
    expect(routeSearchOptions("open-web", context, true).startPublishedDate).toBe("2023-09-30T12:00:00.000Z");
    expect(routeSearchOptions("buying", context).startPublishedDate).toBe("2023-09-30T12:00:00.000Z");
    expect(routeSearchOptions("studies-official", context)).toMatchObject({ category: "publication", languages: ["en", "uk"] });
    for (const route of ["studies-official", "contrary", "alternatives"] as const) expect(routeSearchOptions(route, context).startPublishedDate).toBeUndefined();
    expect(routingLanguages(["uk", "en", "pl", "de", "invalid"])).toEqual(["en", "uk", "pl"]);
  });

  test("filters content farms even with an allow list and retains undated sources", () => {
    const sources = ["worldmetrics.org", "www.worldmetrics.org", "stats.worldmetrics.org", "worldmetrics.org.example.test", "reddit.com"]
      .map((host) => ({ id: host, url: `https://${host}/page`, title: host, text: "Saved quote" }));
    expect(isContentFarm(sources[2]!.url)).toBe(true);
    expect(filterRoutedSources(sources, { route: "community" }).map((source) => source.id))
      .toEqual(["worldmetrics.org.example.test", "reddit.com"]);
    expect(routeSearchOptions("community", { venues: [{ name: "Bad venue", kind: "community", domain: "worldmetrics.org" }] }).includeDomains)
      .not.toContain("worldmetrics.org");
    expect(routeSearchOptions("social", { venues: [{ name: "Excluded network", kind: "social", domain: "linkedin.com" }] }).includeDomains)
      .not.toContain("linkedin.com");
    expect(filterRoutedSources([{ id: "linkedin", url: "https://www.linkedin.com/posts/example", title: "Post", text: "Quote" }])).toEqual([]);
  });

  test("demotes a host at exactly 80% vendor or illustration and only on firsthand routes", () => {
    const factors = ["vendor", "vendor", "illustration", "vendor", "firsthand"].map((sourceRole) => ({ sourceRole, source: { url: "https://vendor.test/page" } }));
    expect(vendorDominatedDomains(factors)).toEqual(["vendor.test"]);
    expect(vendorDominatedDomains([...factors, { sourceRole: "measured", source: { url: "https://vendor.test/study" } }])).toEqual([]);
    const context = { excludedFirsthandDomains: ["vendor.test"] };
    expect(routeSearchOptions("community", context).excludeDomains).toContain("vendor.test");
    expect(routeSearchOptions("open-web", context, true).excludeDomains).toContain("vendor.test");
    expect(routeSearchOptions("alternatives", context).excludeDomains).not.toContain("vendor.test");
  });
});
