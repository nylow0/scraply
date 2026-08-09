import { createHash, randomUUID } from "node:crypto";
import { canonicalizeUrl } from "../db/repositories/evidence";
import type {
  DiscoveryFactorRecord,
  DiscoveryProblemRecord,
  DiscoverySourceRecord,
} from "../db/repositories/discovery";
import type { ExaClient, ExaSearchOptions } from "../providers/exa";
import { ProviderFailure, type StructuredModelClient } from "../providers/structured";
import { deriveJsonSchema } from "../shared/json-schema";
import {
  FactorHarvestOutputSchema,
  ProblemCandidatesOutputSchema,
  ProblemKillOutputSchema,
  QueryPlanOutputSchema,
  type Scope,
} from "../shared/structured-output-schemas";
import type { Source } from "../shared/schemas";
import { loadPrompt } from "./prompts";

export type DiscoveryDepth = "quick" | "standard" | "deep";
export type HarvestMode = "domain" | "audience";
export type DiscoveryArm = "A" | "C";

export const DISCOVERY_DEPTHS = {
  quick: { queriesPerMode: 3, searchResultsPerQuery: 4, factorCap: 30 },
  standard: { queriesPerMode: 6, searchResultsPerQuery: 5, factorCap: 80 },
  deep: { queriesPerMode: 10, searchResultsPerQuery: 6, factorCap: 150 },
} as const;

export const SOURCE_BATCH_CHARACTERS = 60_000;
export const SOURCE_MAX_CHARACTERS = 6_000;
export const FACTOR_SUBJECT_MAX_CHARACTERS = 160;
export const FACTOR_BEHAVIOR_MAX_CHARACTERS = 280;
export const DEFAULT_PROBLEM_CANDIDATE_LIMIT = 4;
export const DEFAULT_AUDIENCE_DOMAINS = ["reddit.com", "news.ycombinator.com"];

export interface HarvestedSource extends DiscoverySourceRecord {
  url: string;
}

export interface HarvestedFactor extends DiscoveryFactorRecord {
  source: HarvestedSource;
}

export interface FactorRejection {
  harvestMode: HarvestMode;
  sourceId: string;
  reason: "unknown-source" | "quote-mismatch" | "empty-field" | "length-ceiling" | "invalid-confidence";
}

export interface FactorHarvestMetrics {
  extracted: Record<HarvestMode, number>;
  accepted: Record<HarvestMode, number>;
  retained: Record<HarvestMode, number>;
  rejected: Record<HarvestMode, number>;
  quoteRejected: Record<HarvestMode, number>;
  quoteRejectionRate: Record<HarvestMode, number>;
}

export interface HarvestResult {
  factors: HarvestedFactor[];
  sources: HarvestedSource[];
  rejections: FactorRejection[];
  metrics: FactorHarvestMetrics;
}

export interface DiscoveryProblem extends DiscoveryProblemRecord {
  factors: HarvestedFactor[];
  sourceHostnames: string[];
  singleHarvestModeWarning: boolean;
}

export interface BlockedProblemCandidate {
  statement: string;
  reason: string;
}

export interface DiscoveryArmResult {
  arm: DiscoveryArm;
  problems: DiscoveryProblem[];
  blockedCandidates: BlockedProblemCandidate[];
  killSources: HarvestedSource[];
  factorUtilizationRate: number;
}

export interface Phase1AblationResult {
  scope: Scope;
  harvest: HarvestResult;
  armA: DiscoveryArmResult;
  armC: DiscoveryArmResult;
}

export interface DiscoveryDependencies {
  modelClient: StructuredModelClient;
  exa: Pick<ExaClient, "search">;
  model: string;
  depth?: DiscoveryDepth;
  audienceSearch?: Pick<ExaSearchOptions, "includeDomains" | "category" | "startPublishedDate">;
  candidateLimit?: number;
  signal?: AbortSignal;
  random?: () => number;
  onProjection?: (message: string) => void;
}

export function discoveryProjection(
  depth: DiscoveryDepth,
  candidateLimit = DEFAULT_PROBLEM_CANDIDATE_LIMIT,
): {
  harvestSearches: number;
  killSearches: number;
  searches: number;
  modelCalls: number;
  factorCap: number;
} {
  const config = DISCOVERY_DEPTHS[depth];
  const harvestSearches = config.queriesPerMode * 2;
  // Both arms run one kill search per surviving candidate.
  const killSearches = candidateLimit * 2;
  const batchesPerMode = Math.max(1, Math.ceil(
    (config.queriesPerMode * config.searchResultsPerQuery * SOURCE_MAX_CHARACTERS) / SOURCE_BATCH_CHARACTERS,
  ));
  // 2 query plans + harvest batches per mode + 1 candidate call per arm + 1 kill call per candidate.
  const modelCalls = 2 + batchesPerMode * 2 + 2 + killSearches;
  return {
    harvestSearches,
    killSearches,
    searches: harvestSearches + killSearches,
    modelCalls,
    factorCap: config.factorCap,
  };
}

export async function runPhase1Ablation(
  scope: Scope,
  dependencies: DiscoveryDependencies,
): Promise<Phase1AblationResult> {
  const depth = dependencies.depth ?? "standard";
  const projection = discoveryProjection(depth, dependencies.candidateLimit);
  dependencies.onProjection?.(
    `~${projection.searches} searches (${projection.harvestSearches} harvest + up to ${projection.killSearches} kill)`
    + ` · ~${projection.modelCalls} model calls before schema retries · factor cap ${projection.factorCap}`,
  );
  const harvest = await harvestFactors(scope, dependencies);
  const armA = await runDiscoveryArm("A", scope, harvest.factors, harvest.sources, dependencies);
  const armC = await runDiscoveryArm("C", scope, [], [], dependencies);
  return { scope, harvest, armA, armC };
}

export async function harvestFactors(
  scope: Scope,
  dependencies: DiscoveryDependencies,
): Promise<HarvestResult> {
  const depth = dependencies.depth ?? "standard";
  const depthConfig = DISCOVERY_DEPTHS[depth];
  const allSources: HarvestedSource[] = [];
  const rawFactors: Array<Omit<HarvestedFactor, "source">> = [];
  const rejections: FactorRejection[] = [];
  const extracted: Record<HarvestMode, number> = { domain: 0, audience: 0 };

  for (const mode of ["domain", "audience"] as const) {
    const queries = await planQueries(scope, mode, depthConfig.queriesPerMode, dependencies);
    const searchedSources = await searchQueries(queries, mode, depthConfig.searchResultsPerQuery, dependencies);
    const modeSources = dedupeSources(searchedSources, allSources);
    allSources.push(...modeSources);
    const sourceById = new Map(allSources.map((source) => [source.id, source]));
    for (const batch of batchSources(modeSources)) {
      const response = await structuredCall(
        dependencies,
        loadPrompt("factor-harvest", "Extract concrete source-backed factors from the supplied sources."),
        buildFactorHarvestInput(scope, mode, batch),
        FactorHarvestOutputSchema,
      );
      extracted[mode] += response.factors.length;
      for (const candidate of response.factors) {
        const rejection = validateFactor(candidate, mode, sourceById);
        if (rejection) {
          rejections.push(rejection);
          continue;
        }
        const source = sourceById.get(candidate.sourceId)!;
        rawFactors.push({
          id: randomUUID(),
          subject: candidate.subject.trim(),
          behavior: candidate.behavior.trim(),
          quote: candidate.quote.trim(),
          sourceId: source.id,
          harvestMode: mode,
          modelConfidence: candidate.modelConfidence,
        });
      }
    }
  }

  const shuffled = shuffleOnce(rawFactors, dependencies.random ?? Math.random)
    .slice(0, depthConfig.factorCap)
    .map((factor) => ({ ...factor, source: allSources.find((source) => source.id === factor.sourceId)! }));
  const accepted = {
    domain: rawFactors.filter((factor) => factor.harvestMode === "domain").length,
    audience: rawFactors.filter((factor) => factor.harvestMode === "audience").length,
  };
  const retained = {
    domain: shuffled.filter((factor) => factor.harvestMode === "domain").length,
    audience: shuffled.filter((factor) => factor.harvestMode === "audience").length,
  };
  const rejected = {
    domain: rejections.filter((item) => item.harvestMode === "domain").length,
    audience: rejections.filter((item) => item.harvestMode === "audience").length,
  };
  const quoteRejected = {
    domain: rejections.filter((item) => item.harvestMode === "domain" && item.reason === "quote-mismatch").length,
    audience: rejections.filter((item) => item.harvestMode === "audience" && item.reason === "quote-mismatch").length,
  };
  return {
    factors: shuffled,
    sources: allSources,
    rejections,
    metrics: {
      extracted,
      accepted,
      retained,
      rejected,
      quoteRejected,
      quoteRejectionRate: {
        domain: rate(quoteRejected.domain, extracted.domain),
        audience: rate(quoteRejected.audience, extracted.audience),
      },
    },
  };
}

export async function runDiscoveryArm(
  arm: DiscoveryArm,
  scope: Scope,
  factors: HarvestedFactor[],
  existingSources: HarvestedSource[],
  dependencies: DiscoveryDependencies,
): Promise<DiscoveryArmResult> {
  const response = await structuredCall(
    dependencies,
    loadPrompt("problem-candidates", "Find direct problem statements from the supplied scope and factors."),
    buildProblemCandidatesInput(scope, arm === "A" ? factors : []),
    ProblemCandidatesOutputSchema,
  );
  const candidateLimit = dependencies.candidateLimit ?? DEFAULT_PROBLEM_CANDIDATE_LIMIT;
  const candidates = response.problems.slice(0, candidateLimit);
  dependencies.onProjection?.(
    `Arm ${arm}: ${candidates.length} kill searches · ${candidates.length + 1} model calls`,
  );

  const factorById = new Map(factors.map((factor) => [factor.id, factor]));
  const sourcesByUrl = new Map(existingSources.map((source) => [source.canonicalUrl, source]));
  const killSources: HarvestedSource[] = [];
  const problems: DiscoveryProblem[] = [];
  const blockedCandidates: BlockedProblemCandidate[] = [];

  for (const candidate of candidates) {
    const citedFactors = arm === "A"
      ? [...new Set(candidate.factorIds)].map((id) => factorById.get(id)).filter(Boolean) as HarvestedFactor[]
      : [];
    const hostnames = [...new Set(citedFactors.map((factor) => new URL(factor.source.canonicalUrl).hostname))];
    if (arm === "A" && hostnames.length < 2) {
      blockedCandidates.push({
        statement: candidate.statement,
        reason: `Corpus diversity failed: cited factors span ${hostnames.length} source hostname(s); 2 required.`,
      });
      continue;
    }

    const searched = await dependencies.exa.search(buildKillQuery(candidate.statement), {
      numResults: DISCOVERY_DEPTHS[dependencies.depth ?? "standard"].searchResultsPerQuery,
      maxCharacters: SOURCE_MAX_CHARACTERS,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    const { all: candidateSources, fresh } = resolveSources(searched, sourcesByUrl, dependencies.onProjection);
    for (const source of fresh) {
      sourcesByUrl.set(source.canonicalUrl, source);
      killSources.push(source);
    }
    const kill = await structuredCall(
      dependencies,
      loadPrompt("problem-kill", "Evaluate whether the candidate problem survives contrary evidence."),
      buildProblemKillInput(candidate, candidateSources),
      ProblemKillOutputSchema,
    );
    const validVerdictSourceIds = kill.verdictSourceIds.filter((id) => candidateSources.some((source) => source.id === id));
    const factorIds = citedFactors.map((factor) => factor.id);
    problems.push({
      id: randomUUID(),
      statement: candidate.statement.trim(),
      whyItPersists: candidate.whyItPersists.trim(),
      affected: candidate.affected.trim(),
      scaleEstimate: candidate.scaleEstimate.trim(),
      scaleBasisFactorId: factorIds.includes(candidate.scaleBasisFactorId ?? "") ? candidate.scaleBasisFactorId : null,
      factorIds,
      verdict: kill.verdict,
      verdictReason: kill.verdictReason.trim(),
      verdictSourceIds: validVerdictSourceIds,
      factors: citedFactors,
      sourceHostnames: hostnames,
      singleHarvestModeWarning: new Set(citedFactors.map((factor) => factor.harvestMode)).size === 1 && citedFactors.length > 0,
    });
  }

  const usedFactorIds = new Set(problems.flatMap((problem) => problem.factorIds));
  return {
    arm,
    problems,
    blockedCandidates,
    killSources,
    factorUtilizationRate: arm === "A" ? rate(usedFactorIds.size, factors.length) : 0,
  };
}

export function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function quoteAppearsVerbatim(sourceText: string, quote: string): boolean {
  const normalizedQuote = normalizeEvidenceText(quote);
  return normalizedQuote.length > 0 && normalizeEvidenceText(sourceText).includes(normalizedQuote);
}

export function batchSources(sources: HarvestedSource[], maxCharacters = SOURCE_BATCH_CHARACTERS): HarvestedSource[][] {
  const batches: HarvestedSource[][] = [];
  let current: HarvestedSource[] = [];
  let characters = 0;
  for (const source of sources) {
    const size = renderSource(source).length;
    if (current.length > 0 && characters + size > maxCharacters) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(source);
    characters += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function planQueries(
  scope: Scope,
  mode: HarvestMode,
  count: number,
  dependencies: DiscoveryDependencies,
): Promise<string[]> {
  const system = loadPrompt("query-plan", "Plan search queries for the supplied scope and harvest mode.");
  const user = [
    `Harvest mode: ${mode}`,
    `Produce ${count} search queries.`,
    JSON.stringify(scope),
  ].join("\n\n");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await structuredCall(dependencies, system, user, QueryPlanOutputSchema);
    const queries = [...new Set(response.queries.map((query) => query.trim()).filter(Boolean))];
    if (queries.length >= count) return queries.slice(0, count);
    if (attempt === 1) {
      throw new ProviderFailure(
        "schema",
        `Query planner returned ${queries.length} unique non-empty queries; expected ${count}`,
        false,
      );
    }
  }
  throw new Error("Unreachable query planning state");
}

async function searchQueries(
  queries: string[],
  mode: HarvestMode,
  resultsPerQuery: number,
  dependencies: DiscoveryDependencies,
): Promise<HarvestedSource[]> {
  const gathered: Source[] = [];
  for (const query of queries) {
    gathered.push(...await dependencies.exa.search(query, {
      numResults: resultsPerQuery,
      maxCharacters: SOURCE_MAX_CHARACTERS,
      ...(mode === "audience"
        ? { includeDomains: DEFAULT_AUDIENCE_DOMAINS, ...dependencies.audienceSearch }
        : {}),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    }));
  }
  return resolveSources(gathered, new Map(), dependencies.onProjection).fresh;
}

/**
 * `all` is what the model must see; `fresh` is what may still be inserted. A source that is already
 * known stays in `all` so that a run holding a large corpus does not get a thinner prompt than one
 * holding none — which would silently bias Arm A against the Arm C control.
 */
function resolveSources(
  sources: Source[],
  known: Map<string, HarvestedSource>,
  onSkipped?: (message: string) => void,
): { all: HarvestedSource[]; fresh: HarvestedSource[] } {
  const all: HarvestedSource[] = [];
  const fresh: HarvestedSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const canonicalUrl = safeCanonicalizeUrl(source.url);
    if (!canonicalUrl) {
      onSkipped?.(`Skipped a search result with an unparsable URL: ${source.url}`);
      continue;
    }
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    const existing = known.get(canonicalUrl);
    if (existing) {
      all.push(existing);
      continue;
    }
    const retrievedText = source.text.trim();
    const prepared: HarvestedSource = {
      id: randomUUID(),
      providerSourceId: source.id,
      canonicalUrl,
      url: source.url,
      title: source.title.trim(),
      retrievedText,
      author: source.author ?? null,
      publishedAt: source.publishedDate ?? null,
      contentHash: createHash("sha256").update(retrievedText).digest("hex"),
      retrievedAt: new Date().toISOString(),
    };
    all.push(prepared);
    fresh.push(prepared);
  }
  return { all, fresh };
}

function safeCanonicalizeUrl(value: string): string | null {
  try {
    return canonicalizeUrl(value);
  } catch {
    return null;
  }
}

function dedupeSources(sources: HarvestedSource[], existing: HarvestedSource[]): HarvestedSource[] {
  const urls = new Set(existing.map((source) => source.canonicalUrl));
  const deduped: HarvestedSource[] = [];
  for (const source of sources) {
    if (urls.has(source.canonicalUrl)) continue;
    urls.add(source.canonicalUrl);
    deduped.push(source);
  }
  return deduped;
}

function validateFactor(
  factor: {
    subject: string;
    behavior: string;
    quote: string;
    sourceId: string;
    modelConfidence: number;
  },
  harvestMode: HarvestMode,
  sourceById: Map<string, HarvestedSource>,
): FactorRejection | null {
  const rejection = (reason: FactorRejection["reason"]): FactorRejection => ({
    harvestMode,
    sourceId: factor.sourceId,
    reason,
  });
  const source = sourceById.get(factor.sourceId);
  if (!source) return rejection("unknown-source");
  if (![factor.subject, factor.behavior, factor.quote].every((value) => value.trim().length > 0)) return rejection("empty-field");
  if (factor.subject.length > FACTOR_SUBJECT_MAX_CHARACTERS || factor.behavior.length > FACTOR_BEHAVIOR_MAX_CHARACTERS) {
    return rejection("length-ceiling");
  }
  if (factor.modelConfidence < 0 || factor.modelConfidence > 1) return rejection("invalid-confidence");
  if (!quoteAppearsVerbatim(source.retrievedText, factor.quote)) return rejection("quote-mismatch");
  return null;
}

async function structuredCall<T>(
  dependencies: DiscoveryDependencies,
  system: string,
  user: string,
  schema: import("zod").z.ZodType<T>,
): Promise<T> {
  const execute = () => dependencies.modelClient.structuredCompletion(
    dependencies.model,
    system,
    user,
    schema,
    deriveJsonSchema(schema),
    dependencies.signal ? { signal: dependencies.signal } : {},
  );
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ProviderFailure && error.code === "schema") return execute();
    throw error;
  }
}

function buildFactorHarvestInput(scope: Scope, mode: HarvestMode, sources: HarvestedSource[]): string {
  return [
    `Harvest mode: ${mode}`,
    `Scope: ${JSON.stringify(scope)}`,
    "Sources:",
    sources.map(renderSource).join("\n\n"),
  ].join("\n\n");
}

function buildProblemCandidatesInput(scope: Scope, factors: HarvestedFactor[]): string {
  const stage2Scope = {
    title: scope.title,
    audience: scope.audience,
    domain: scope.domain,
    offLimits: scope.offLimits,
  };
  return [
    `Scope: ${JSON.stringify(stage2Scope)}`,
    `Factors: ${JSON.stringify(factors.map(({ source: _source, ...factor }) => factor))}`,
  ].join("\n\n");
}

function buildProblemKillInput(
  candidate: { statement: string; whyItPersists: string; affected: string; scaleEstimate: string },
  sources: HarvestedSource[],
): string {
  return [
    `Candidate: ${JSON.stringify(candidate)}`,
    "Look for contrary evidence: already solved, overstated scale, self-correction, and prior attempts that failed.",
    sources.map(renderSource).join("\n\n"),
  ].join("\n\n");
}

function buildKillQuery(statement: string): string {
  return `${statement} already solved widespread self-correcting attempted failed shutdown`;
}

function renderSource(source: HarvestedSource): string {
  return `[${source.id}] ${source.title}\nURL: ${source.canonicalUrl}\n${source.retrievedText}`;
}

function shuffleOnce<T>(values: T[], random: () => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
  }
  return shuffled;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
