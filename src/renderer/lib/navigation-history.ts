export type SolutionsRoute = { kind: "list" } | { kind: "idea" | "conversation"; ideaId: string };
export type NavigationRoute = {
  threadId: string;
  step: "setup" | "research" | "ideas";
  settings: boolean;
  solution: SolutionsRoute;
};
export type HistoryEntry = { route: NavigationRoute; scrollTop: number };
export type NavigationHistory = { entries: HistoryEntry[]; index: number };
export type ResolveRoute = (route: NavigationRoute) => NavigationRoute | null;

export function routeResolver(threads: ReadonlyArray<{ id: string; archivedAt?: string | null | undefined }>, knownIdeas: Readonly<Record<string, readonly string[]>>): ResolveRoute {
  return target => {
    if (!threads.some(thread => thread.id === target.threadId && !thread.archivedAt)) return null;
    const ids = knownIdeas[target.threadId];
    return target.solution.kind !== "list" && ids && !ids.includes(target.solution.ideaId)
      ? { ...target, solution: { kind: "list" } } : target;
  };
}

export function sameRoute(left: NavigationRoute, right: NavigationRoute): boolean {
  return left.threadId === right.threadId && left.step === right.step && left.settings === right.settings
    && left.solution.kind === right.solution.kind
    && (left.solution.kind === "list" || (right.solution.kind !== "list" && left.solution.ideaId === right.solution.ideaId));
}

export function pushHistory(history: NavigationHistory, route: NavigationRoute, scrollTop = 0): NavigationHistory {
  const current = history.entries[history.index];
  if (current && sameRoute(current.route, route)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), { route, scrollTop }].slice(-100);
  return { entries, index: entries.length - 1 };
}

export function replaceHistory(history: NavigationHistory, route: NavigationRoute, scrollTop = 0): NavigationHistory {
  if (history.index < 0) return pushHistory(history, route, scrollTop);
  const entries = history.entries.map((entry, index) => index === history.index ? { route, scrollTop } : entry);
  return { entries, index: history.index };
}

export function rememberScroll(history: NavigationHistory, scrollTop: number): NavigationHistory {
  const current = history.entries[history.index];
  return current ? replaceHistory(history, current.route, scrollTop) : history;
}

export function findHistoryIndex(history: NavigationHistory, direction: -1 | 1, resolve: ResolveRoute): number {
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    if (resolve(history.entries[index]!.route)) return index;
  }
  return -1;
}

// Resolution skips unavailable projects and replaces a removed idea with its list.
// Adjacent parent entries are reused so stale idea entries disappear from the stack.
export function traverseHistory(history: NavigationHistory, direction: -1 | 1, resolve: ResolveRoute): NavigationHistory {
  const target = findHistoryIndex(history, direction, resolve);
  if (target < 0) return history;
  return reconcileHistory({ ...history, index: target }, resolve);
}

export function reconcileHistory(history: NavigationHistory, resolve: ResolveRoute): NavigationHistory {
  const target = history.index;
  const entries: HistoryEntry[] = [];
  let index = -1;
  for (let oldIndex = 0; oldIndex < history.entries.length; oldIndex += 1) {
    const entry = history.entries[oldIndex]!;
    const route = resolve(entry.route);
    if (!route) continue;
    const previous = entries.at(-1);
    if (!sameRoute(route, entry.route) && previous && sameRoute(previous.route, route)) {
      if (oldIndex === target) index = entries.length - 1;
      continue;
    }
    entries.push(sameRoute(route, entry.route) ? entry : { route, scrollTop: 0 });
    if (oldIndex === target) index = entries.length - 1;
  }
  return { entries, index };
}

export function parentHistory(history: NavigationHistory, parent: NavigationRoute, resolve: ResolveRoute): NavigationHistory {
  const index = findHistoryIndex(history, -1, resolve);
  const previous = history.entries[index];
  return previous && sameRoute(resolve(previous.route)!, parent)
    ? traverseHistory(history, -1, resolve) : pushHistory(history, parent);
}
