import { z } from "zod";
import type { DatabaseClient } from "../db/client";
import { OpportunityExplorationRepository } from "../db/repositories/opportunity-exploration";
import type { SearchClient, SearchProvider } from "../providers/search";
import { canonicalJson } from "../shared/content-identity";
import { SourceSchema, type Source } from "../shared/schemas";

const MAX_RESULTS = 5;
const MAX_CHARACTERS = 4_000;
const TIMEOUT_MS = 45_000;
const PROMPT_VERSION = "opportunity-gap-search-managed-v1";
const SavedSearchInputSchema = z.object({
  gapId: z.string().min(1),
  evidenceNeeded: z.string().min(1),
  query: z.string().min(1),
  numResults: z.literal(MAX_RESULTS),
  maxCharacters: z.literal(MAX_CHARACTERS),
}).strict();
const SearchCheckpointSchema = z.object({
  sources: SourceSchema.array().max(MAX_RESULTS),
  noEvidenceReason: z.string().min(1).nullable(),
}).strict();

export interface ManagedCoverageSearchInput {
  db: DatabaseClient;
  threadId: string;
  sessionId: string;
  workItemId: string;
  gapId: string;
  searchProvider: SearchProvider;
  searchClient?: SearchClient | undefined;
  signal: AbortSignal;
  /** The caller records its own search reservation dispatch after this attempt is marked dispatched. */
  onDispatched?: (attemptId: string) => void;
}

export interface ManagedCoverageSearchResult {
  attemptId: string;
  sources: Source[];
  noEvidenceReason: string | null;
  replayed: boolean;
}

/** Returns only evidence from a completed search checkpoint for this session and gap. */
export function loadManagedCoverageSearchSources(db: DatabaseClient, threadId: string,
  sessionId: string, gapId: string): Source[] {
  const saved = new OpportunityExplorationRepository(db).completedAttempt(threadId, `gap-search:${gapId}`, sessionId);
  return saved ? SearchCheckpointSchema.parse(saved.result).sources : [];
}

/** Searches only the saved gap query. A dispatched or uncertain attempt is never sent again. */
export async function runManagedCoverageSearch(input: ManagedCoverageSearchInput): Promise<ManagedCoverageSearchResult> {
  input.signal.throwIfAborted();
  const repository = new OpportunityExplorationRepository(input.db);
  const gap = repository.listGaps(input.threadId, input.sessionId).find((candidate) => candidate.id === input.gapId);
  if (!gap || !gap.evidenceNeeded || !gap.searchQuery) {
    throw new Error("Coverage gap has no bounded evidence request for this session.");
  }
  const stageKey = `gap-search:${gap.id}`;
  const model = { providerId: input.searchProvider, modelId: "search", reasoningEffort: "bounded" };
  const saved = repository.loadAttempt(input.threadId, stageKey, input.sessionId);
  const savedSearchInput = saved ? SavedSearchInputSchema.parse(saved.input) : null;
  if (saved) {
    if (savedSearchInput!.gapId !== input.gapId || saved.promptText !== savedSearchInput!.query) {
      throw new Error("Saved gap search input identity changed.");
    }
    if (saved.workItemId !== input.workItemId || canonicalJson(saved.model) !== canonicalJson(model)
      || saved.promptVersion !== PROMPT_VERSION) {
      throw new Error("Saved gap search belongs to a different task or provider.");
    }
    if (saved.status === "completed") {
      return applyCheckpoint(input, saved.attemptId, SearchCheckpointSchema.parse(saved.result), true);
    }
    if (saved.status !== "prepared") {
      throw new Error("Gap search may have completed before its result was saved. It will not be replayed automatically.");
    }
  }
  const searchClient = input.searchClient;
  if (!searchClient || searchClient.provider !== input.searchProvider) {
    throw new Error(`Search provider ${input.searchProvider} is unavailable for a new gap search.`);
  }
  const searchInput = savedSearchInput ?? {
    gapId: gap.id, evidenceNeeded: gap.evidenceNeeded, query: gap.searchQuery,
    numResults: MAX_RESULTS, maxCharacters: MAX_CHARACTERS,
  };
  const attempt = saved ? { kind: "prepared" as const, attemptId: saved.attemptId }
    : input.db.immediateTransaction(() => repository.prepareAttempt(input.threadId, {
      stageKey, stageName: "gap-search", input: searchInput, model,
      promptVersion: PROMPT_VERSION, promptText: gap.searchQuery!, workItemId: input.workItemId,
    }, input.sessionId));
  if (attempt.kind === "unknown-dispatch") {
    throw new Error("Gap search may have completed before its result was saved. It will not be replayed automatically.");
  }
  if (attempt.kind === "completed") {
    return applyCheckpoint(input, attempt.attemptId, SearchCheckpointSchema.parse(attempt.result), true);
  }
  if (attempt.kind !== "prepared") throw new Error("Gap search attempt was not prepared.");

  let sources: Source[];
  try {
    input.db.immediateTransaction(() => repository.markAttemptDispatched(
      input.threadId, attempt.attemptId, "none", input.sessionId));
    input.onDispatched?.(attempt.attemptId);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const result = await searchClient.search(searchInput.query, {
      numResults: MAX_RESULTS, maxCharacters: MAX_CHARACTERS, timeoutMs: TIMEOUT_MS, signal,
    });
    sources = usableSources(result);
  } catch (error) {
    const current = repository.loadAttempt(input.threadId, stageKey, input.sessionId);
    if (current?.status === "prepared" || current?.status === "dispatched") {
      input.db.immediateTransaction(() => repository.failAttempt(
        input.threadId, attempt.attemptId, error instanceof Error ? error.message : String(error), false, input.sessionId));
    }
    throw error;
  }
  const checkpoint = SearchCheckpointSchema.parse({
    sources,
    noEvidenceReason: sources.length === 0
      ? `No usable evidence was returned for "${gap.name}" by the saved bounded query.` : null,
  });
  return applyCheckpoint(input, attempt.attemptId, checkpoint, false);
}

function applyCheckpoint(input: ManagedCoverageSearchInput, attemptId: string,
  checkpoint: z.infer<typeof SearchCheckpointSchema>, replayed: boolean): ManagedCoverageSearchResult {
  const repository = new OpportunityExplorationRepository(input.db);
  input.db.immediateTransaction(() => {
    if (!replayed) repository.completeAttempt(input.threadId, attemptId, checkpoint, input.sessionId);
    const gap = repository.listGaps(input.threadId, input.sessionId).find((candidate) => candidate.id === input.gapId);
    if (!gap) throw new Error("Saved coverage gap is missing from its session.");
    if (gap.status === "search-needed") {
      repository.saveGap(input.threadId, {
        ...gap, status: checkpoint.sources.length > 0 ? "ready" : "exhausted",
        updatedAt: new Date().toISOString(),
      }, input.sessionId, true);
    }
  });
  return { attemptId, sources: checkpoint.sources, noEvidenceReason: checkpoint.noEvidenceReason, replayed };
}

function usableSources(sources: Source[]): Source[] {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const usable: Source[] = [];
  for (const source of sources) {
    if (usable.length >= MAX_RESULTS) break;
    const id = source.id?.trim();
    const url = source.url?.trim();
    if (!id || id.length > 256 || !url || url.length > 2_048) continue;
    const author = source.author?.trim();
    const publishedDate = source.publishedDate?.trim();
    const parsed = SourceSchema.safeParse({ id, url,
      title: source.title?.trim().slice(0, 500), text: source.text?.trim().slice(0, MAX_CHARACTERS),
      ...(author ? { author: author.slice(0, 200) } : {}),
      ...(publishedDate ? { publishedDate: publishedDate.slice(0, 100) } : {}),
    });
    if (!parsed.success || seenIds.has(parsed.data.id) || seenUrls.has(parsed.data.url)) continue;
    seenIds.add(parsed.data.id);
    seenUrls.add(parsed.data.url);
    usable.push(parsed.data);
  }
  return usable;
}
