import { describe, expect, test } from "bun:test";
import { classifyTraceSource, savedSearchKey } from "../../src/core/run-trace";

describe("saved run trace source classes", () => {
  test.each([
    ["https://old.reddit.com/r/Accounting/comments/1/", "forum"],
    ["https://news.ycombinator.com/item?id=1", "forum"],
    ["https://github.com/org/app/issues/4", "forum"],
    ["https://github.com/org/app", "unknown"],
    ["https://community.xero.com/questions/1", "forum"],
    ["https://www.trustpilot.com/review/tool.com", "review"],
    ["https://pubmed.ncbi.nlm.nih.gov/1234/", "study"],
    ["https://www.nature.com/articles/1", "study"],
    ["https://www.cdc.gov/data/1", "official"],
    ["https://www.gov.uk/government/statistics/1", "official"],
    ["https://moz.gov.ua/report", "official"],
    ["https://www.who.int/publications/1", "official"],
    ["https://www.shopify.com/retail/1", "vendor"],
    ["https://zipdo.co/statistics/1", "content-farm"],
    ["https://fake.shopify.com.attacker.example/", "unknown"],
    ["not a URL", "unknown"],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(classifyTraceSource(url)).toBe(expected);
  });

  test("reconstructs unchanged search identities from normalized query and every parameter", () => {
    const options = { numResults: 4, maxCharacters: 6000, includeDomains: ["reddit.com"] };
    expect(savedSearchKey("  Ｂakery\n orders  ", options)).toBe(savedSearchKey("bakery orders", options));
    expect(savedSearchKey("bakery orders", options)).not.toBe(savedSearchKey("bakery orders", { ...options, includeDomains: [] }));
  });
});
