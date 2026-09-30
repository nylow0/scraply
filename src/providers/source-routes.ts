import { z } from "zod";
import type { Source } from "../shared/schemas";
import type { SearchOptions, SearchProvider, SearchProviderChoice } from "./search";

export const SourceRouteSchema = z.enum(["open-web", "community", "issue-tracker", "social", "studies-official", "alternatives", "contrary", "buying"]);
export type SourceRoute = z.infer<typeof SourceRouteSchema>;
export type SearchIntent = "firsthand-experience" | "measured-behavior" | "current-alternative" | "buying-signal" | "contrary-evidence" | "unclassified";

// Reviewed from the workflow audit. Add a host only after inspecting its source content.
export const CONTENT_FARM_DOMAINS = ["worldmetrics.org"] as const;
export const EXCLUDED_SOURCE_DOMAINS = [...CONTENT_FARM_DOMAINS, "linkedin.com"] as const;
const COMMUNITY_DOMAINS = ["reddit.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com"];
const ISSUE_DOMAINS = ["github.com", "gitlab.com"];
const SOCIAL_DOMAINS = ["x.com", "bsky.app", "threads.net"];

export const SourceVenueSchema = z.object({
  name: z.string().trim().min(1),
  domain: z.string().trim().min(1).optional(),
  kind: z.enum(["community", "issue-tracker", "social", "official", "publication"]),
}).strict();
export type SourceVenue = z.infer<typeof SourceVenueSchema>;
export interface SourceRoutingContext {
  goalKind?: "market-opportunity" | "competition-entry" | "research-question" | "community-or-personal" | "process-improvement" | "other";
  venues?: SourceVenue[];
  languages?: string[];
  region?: string;
  /** Social remains opt-in until the evaluation suite demonstrates qualifying yield. */
  socialEnabled?: boolean;
  excludedFirsthandDomains?: string[];
  previousFirsthandRoute?: SourceRoute;
  /** Old completed extraction inputs must retain their saved sources; new provider results are still filtered. */
  preserveHistoricalSources?: boolean;
  now?: Date;
}

export function sourceHostname(url: string): string | null {
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

export function filterRoutedSources(sources: Source[], options: Pick<SearchOptions, "route" | "excludeDomains"> = {}): Source[] {
  return sources.filter((source) => {
    if (isContentFarm(source.url)) return false;
    const host = sourceHostname(source.url);
    if (host && EXCLUDED_SOURCE_DOMAINS.some((domain) => matchesDomain(host, domain))) return false;
    return !host || !(options.excludeDomains ?? []).some((domain) => matchesDomain(host, domain));
  });
}

export function chooseSearchProvider(choice: SearchProviderChoice, available: Partial<Record<SearchProvider, boolean>>,
  route: SourceRoute = "open-web"): SearchProvider {
  if (choice !== "auto") {
    if (!available[choice]) throw new Error(`Search provider ${choice} is unavailable.`);
    return choice;
  }
  const preferred = ["community", "issue-tracker", "social", "studies-official", "contrary"].includes(route) ? "exa" : "perplexity";
  if (available[preferred]) return preferred;
  const fallback = preferred === "exa" ? "perplexity" : "exa";
  if (available[fallback]) return fallback;
  throw new Error("Connect Exa or Perplexity before discovering problems.");
}

export function searchRoutes(intent: SearchIntent, context: SourceRoutingContext = {}): SourceRoute[] {
  if (intent === "firsthand-experience") {
    let firsthand: SourceRoute = context.venues?.some((venue) => venue.kind === "issue-tracker") ? "issue-tracker"
      : context.socialEnabled && context.venues?.some((venue) => venue.kind === "social") ? "social" : "community";
    if (context.previousFirsthandRoute === firsthand) firsthand = firsthand === "community" ? "issue-tracker" : "community";
    return ["open-web", firsthand];
  }
  if (intent === "measured-behavior") return ["studies-official"];
  if (intent === "current-alternative") return ["alternatives"];
  if (intent === "contrary-evidence") return ["contrary"];
  if (intent === "buying-signal") return ["buying"];
  return ["open-web"];
}

export function routingLanguages(languages: readonly string[] = []): string[] {
  return [...new Set(["en", ...languages.map((language) => language.trim().toLowerCase()).filter((language) => /^[a-z]{2}$/.test(language))])].slice(0, 3);
}

/** Frame venues must be verified by the caller before this helper receives them. */
export function routeSearchOptions(route: SourceRoute, context: SourceRoutingContext = {}, pairedFirsthand = false): SearchOptions {
  const firsthand = ["community", "issue-tracker", "social"].includes(route) || pairedFirsthand;
  const denied = [...EXCLUDED_SOURCE_DOMAINS, ...(firsthand ? context.excludedFirsthandDomains ?? [] : [])];
  const venues = (context.venues ?? []).flatMap((venue) => {
    if (!venue.domain) return [];
    const domain = sourceHostname(`https://${venue.domain}`);
    return domain && !EXCLUDED_SOURCE_DOMAINS.some((blocked) => matchesDomain(domain, blocked)) ? [{ ...venue, domain }] : [];
  });
  const base = route === "community" ? COMMUNITY_DOMAINS : route === "issue-tracker" ? ISSUE_DOMAINS
    : route === "social" ? SOCIAL_DOMAINS : [];
  const selectedVenues = venues.filter((venue) => venue.kind === route
    || route === "studies-official" && (venue.kind === "official" || venue.kind === "publication"));
  const includeDomains = [...new Set([...base, ...selectedVenues.map((venue) => venue.domain)])]
    .filter((domain) => !denied.some((blocked) => matchesDomain(domain, blocked)));
  const now = context.now ?? new Date();
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  return {
    route,
    excludeDomains: denied,
    ...(includeDomains.length ? { includeDomains } : {}),
    // Publication categories can suppress agency reports, so verified official venues use ordinary web search.
    ...(route === "studies-official" && !selectedVenues.some(venue => venue.kind === "official") ? { category: "publication" as const }
      : route === "contrary" ? { category: "news" as const } : {}),
    ...(firsthand || route === "buying" ? { startPublishedDate: start.toISOString() } : {}),
    ...(firsthand || route === "studies-official" ? { languages: routingLanguages(context.languages) } : {}),
    ...(context.region && /^[a-z]{2}$/i.test(context.region) ? { userLocation: context.region.toUpperCase() } : {}),
  };
}

export function vendorDominatedDomains(factors: ReadonlyArray<{ sourceRole: string; source: { url: string } }>): string[] {
  const counts = new Map<string, { total: number; vendor: number }>();
  for (const factor of factors) {
    const host = sourceHostname(factor.source.url);
    if (!host) continue;
    const count = counts.get(host) ?? { total: 0, vendor: 0 };
    count.total += 1;
    if (factor.sourceRole === "vendor" || factor.sourceRole === "illustration") count.vendor += 1;
    counts.set(host, count);
  }
  return [...counts.entries()].filter(([, count]) => count.vendor / count.total >= 0.8).map(([host]) => host);
}
