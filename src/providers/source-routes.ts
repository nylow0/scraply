import type { Source } from "../shared/schemas";
import type { SearchOptions } from "./search";

/** Hosts whose pages are never kept as sources. Add a host only after inspecting its content. */
export const CONTENT_FARM_DOMAINS = ["worldmetrics.org"] as const;
export const EXCLUDED_SOURCE_DOMAINS = [...CONTENT_FARM_DOMAINS, "linkedin.com"] as const;

function sourceHostname(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isContentFarm(url: string): boolean {
  const host = sourceHostname(url);
  return host !== null && CONTENT_FARM_DOMAINS.some((domain) => matchesDomain(host, domain));
}

/** Drop content farms, always-excluded hosts, and the hosts a search excluded, from a provider's results. */
export function filterRoutedSources(sources: Source[], options: Pick<SearchOptions, "excludeDomains"> = {}): Source[] {
  return sources.filter((source) => {
    if (isContentFarm(source.url)) return false;
    const host = sourceHostname(source.url);
    if (host && EXCLUDED_SOURCE_DOMAINS.some((domain) => matchesDomain(host, domain))) return false;
    return !host || !(options.excludeDomains ?? []).some((domain) => matchesDomain(host, domain));
  });
}
