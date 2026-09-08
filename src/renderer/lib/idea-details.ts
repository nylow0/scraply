import type { SolutionView } from "../../shared/ipc";

// Keep only a few expanded results. Revisions change after a stage commit or a decision edit.
const cache = new Map<string, { value: SolutionView; bytes: number }>();
let retainedBytes = 0;
export async function loadIdeaDetail(summary: SolutionView): Promise<SolutionView> {
  if (summary.detailsLoaded !== false && summary.workflowVersion !== 2) return summary;
  const key = `${summary.id}:${summary.detailRevision ?? ""}`;
  const saved = cache.get(key);
  if (saved) { cache.delete(key); cache.set(key, saved); return saved.value; }
  const value = await window.scraply.getIdeaDetail(summary.id);
  const bytes = JSON.stringify(value).length * 2;
  for (const [oldKey, item] of cache) {
    if (oldKey.startsWith(`${summary.id}:`)) { cache.delete(oldKey); retainedBytes -= item.bytes; }
  }
  if (bytes <= 2_000_000) {
    cache.set(key, { value, bytes });
    retainedBytes += bytes;
    for (const [oldKey, item] of cache) {
      if (cache.size <= 12 && retainedBytes <= 2_000_000) break;
      cache.delete(oldKey); retainedBytes -= item.bytes;
    }
  }
  return value;
}
