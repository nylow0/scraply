import { describe, expect, test } from "bun:test";
import { chooseSearchProvider, filterRoutedSources, isContentFarm, routeSearchOptions, routingLanguages, searchRoutes } from "../../src/providers/source-routes";
import { ExaClient } from "../../src/providers/exa";
import { PerplexityClient } from "../../src/providers/perplexity";
import type { SourceRoutingContext } from "../../src/providers/source-routes";

describe("source routing", () => {
  test("keeps verified study domains outside the publication category and retains broad publication search", () => {
    expect(routeSearchOptions("studies-official", { venues: [{ name: "Government reports", domain: "ons.gov.uk", kind: "official" }] }))
      .toMatchObject({ includeDomains: ["ons.gov.uk"] });
    expect(routeSearchOptions("studies-official", { venues: [{ name: "Government reports", domain: "ons.gov.uk", kind: "official" }] }).category).toBeUndefined();
    expect(routeSearchOptions("studies-official", { venues: [{ name: "Research publications", domain: "nature.com", kind: "publication" }] }))
      .toMatchObject({ includeDomains: ["nature.com"] });
    expect(routeSearchOptions("studies-official", { venues: [{ name: "Research publications", domain: "nature.com", kind: "publication" }] }).category).toBeUndefined();
    expect(routeSearchOptions("studies-official")).toMatchObject({ category: "publication" });
  });
  test("sends the exact Clinics study query without the rejected publication include filter", async () => {
    const query = "electronic patient records small primary care clinics low-resource settings donor-funded pilot ended follow-up record use discontinued continued";
    const includeDomains = ["bmchealthservres.biomedcentral.com", "mhealth.jmir.org"];
    const context: SourceRoutingContext = { languages: ["en"], venues: includeDomains.map(domain => ({ name: domain, domain, kind: "publication" })) };
    const options = { numResults: 4, maxCharacters: 6000, ...routeSearchOptions("studies-official", context) };
    let dispatches = 0;
    let body: unknown;
    const client = new ExaClient("offline-secret", async (_input, init) => {
      dispatches += 1;
      body = JSON.parse(String(init?.body));
      if ((body as { category?: string }).category === "publication") return Response.json({
        requestId: "clinics-regression", tag: "UNSUPPORTED_PUBLICATION_INCLUDE_FILTER",
        error: "The provided domain 'bmchealthservres.biomedcentral.com' is not supported for category=publication",
      }, { status: 400 });
      return Response.json({ results: [{ url: `https://${includeDomains[0]}/articles/study`, text: "Retrieved study quote" },
        { url: "https://worldmetrics.org/page", text: "Blocked quote" }] });
    });
    expect(await client.search(query, options)).toMatchObject([{ text: "Retrieved study quote" }]);
    expect(dispatches).toBe(1);
    expect(options).toEqual({ numResults: 4, maxCharacters: 6000, route: "studies-official", includeDomains,
      excludeDomains: ["worldmetrics.org", "linkedin.com"], languages: ["en"] });
    expect(body).toEqual({ query, type: "auto", numResults: 4, includeDomains,
      excludeDomains: ["worldmetrics.org", "linkedin.com"], contents: { text: { maxCharacters: 6000 } } });
  });
  test("preserves both provider choices and Perplexity filters for domain-constrained studies", async () => {
    const context: SourceRoutingContext = { languages: ["uk"], region: "ua", venues: [
      { name: "BMC studies", domain: "bmchealthservres.biomedcentral.com", kind: "publication" },
      { name: "JMIR studies", domain: "mhealth.jmir.org", kind: "publication" },
    ] };
    const options = { numResults: 4, maxCharacters: 8, ...routeSearchOptions("studies-official", context) };
    const ready = { exa: true, perplexity: true };
    expect(chooseSearchProvider("auto", ready, options.route)).toBe("exa");
    expect(chooseSearchProvider("exa", ready, options.route)).toBe("exa");
    expect(chooseSearchProvider("perplexity", ready, options.route)).toBe("perplexity");
    expect(chooseSearchProvider("auto", { perplexity: true }, options.route)).toBe("perplexity");
    let body: unknown;
    const client = new PerplexityClient("offline-secret", async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ results: [{ url: "https://mhealth.jmir.org/study", snippet: "Evidence longer than limit" },
        { url: "https://linkedin.com/page", snippet: "Blocked quote" }] });
    });
    expect(await client.search("original study query", options)).toMatchObject([{ text: "Evidence" }]);
    expect(body).toEqual({ query: "original study query", max_results: 4, max_tokens_per_page: 2000,
      search_domain_filter: ["bmchealthservres.biomedcentral.com", "mhealth.jmir.org"],
      search_language_filter: ["en", "uk"], country: "UA" });
    expect(options.startPublishedDate).toBeUndefined();
    expect(options.excludeDomains).toEqual(["worldmetrics.org", "linkedin.com"]);
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

  test("excludes demoted hosts only on firsthand routes", () => {
    const context = { excludedFirsthandDomains: ["vendor.test"] };
    expect(routeSearchOptions("community", context).excludeDomains).toContain("vendor.test");
    expect(routeSearchOptions("open-web", context, true).excludeDomains).toContain("vendor.test");
    expect(routeSearchOptions("alternatives", context).excludeDomains).not.toContain("vendor.test");
  });
});
