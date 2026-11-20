import { describe, expect, test } from "bun:test";
import { filterRoutedSources, isContentFarm } from "../../src/providers/source-routes";

describe("source filtering", () => {
  test("drops content farms and always-excluded hosts, and keeps look-alike hosts", () => {
    const sources = ["worldmetrics.org", "www.worldmetrics.org", "stats.worldmetrics.org", "worldmetrics.org.example.test", "reddit.com"]
      .map((host) => ({ id: host, url: `https://${host}/page`, title: host, text: "Saved quote" }));
    expect(isContentFarm(sources[2]!.url)).toBe(true);
    expect(filterRoutedSources(sources).map((source) => source.id)).toEqual(["worldmetrics.org.example.test", "reddit.com"]);
    expect(filterRoutedSources([{ id: "linkedin", url: "https://www.linkedin.com/posts/example", title: "Post", text: "Quote" }])).toEqual([]);
  });

  test("drops the hosts a search excluded, including their subdomains", () => {
    const sources = ["vendor.test", "blog.vendor.test", "forum.example"].map((host) => ({ id: host, url: `https://${host}/page`, title: host, text: "Quote" }));
    expect(filterRoutedSources(sources, { excludeDomains: ["vendor.test"] }).map((source) => source.id)).toEqual(["forum.example"]);
  });
});
