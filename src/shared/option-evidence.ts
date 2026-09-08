import type { SolutionView } from "./ipc";

/** Resolve option citations without changing the source's original discovery role. */
export function optionEvidenceReferences(idea: SolutionView, ids: readonly string[]) {
  const sources = new Map([
    ...idea.factors.map((factor) => [factor.sourceId, { title: factor.sourceTitle, url: factor.sourceUrl }] as const),
    ...(idea.contrarySources ?? []).map((source) => [source.id, { title: source.title, url: source.url }] as const),
  ]);
  return [...new Set(ids)].map((id) => ({
    id,
    title: sources.get(id)?.title ?? `Source unavailable (${id})`,
    url: sources.get(id)?.url ?? null,
  }));
}
