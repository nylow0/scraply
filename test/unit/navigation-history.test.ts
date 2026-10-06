import { describe, expect, test } from "bun:test";
import { findHistoryIndex, parentHistory, pushHistory, replaceHistory, traverseHistory, rememberScroll, routeResolver,
  type NavigationRoute, type NavigationHistory } from "../../src/renderer/lib/navigation-history";

const list: NavigationRoute = { threadId: "alpha", step: "ideas", settings: false, solution: { kind: "list" } };
const idea: NavigationRoute = { ...list, solution: { kind: "idea", ideaId: "one" } };
const conversation: NavigationRoute = { ...list, solution: { kind: "conversation", ideaId: "one" } };
const empty: NavigationHistory = { entries: [], index: -1 };
const valid = (route: NavigationRoute) => route;

describe("navigation history", () => {
  test("push clears forward and replace keeps the length", () => {
    let history = pushHistory(pushHistory(pushHistory(empty, list), idea), conversation);
    history = traverseHistory(history, -1, valid);
    history = pushHistory(history, { ...list, settings: true });
    expect(history.entries.map(entry => entry.route)).toEqual([list, idea, { ...list, settings: true }]);
    expect(findHistoryIndex(history, 1, valid)).toBe(-1);
    history = replaceHistory(history, conversation, 124);
    expect(history.entries).toHaveLength(3);
    expect(history.entries[history.index]).toEqual({ route: conversation, scrollTop: 124 });
  });
  test("traversal skips unavailable projects in both directions", () => {
    let history = pushHistory(pushHistory(pushHistory(empty, list), { ...list, threadId: "deleted" }), idea);
    const resolve = (route: NavigationRoute) => route.threadId === "deleted" ? null : route;
    history = traverseHistory(history, -1, resolve);
    expect(history.entries[history.index]?.route).toEqual(list);
    expect(history.entries).toHaveLength(2);
    expect(traverseHistory(history, 1, resolve).entries[1]?.route).toEqual(idea);
  });
  test("keeps the latest 100 entries", () => {
    let history = empty;
    for (let index = 0; index < 125; index += 1) history = pushHistory(history, { ...list, threadId: String(index) });
    expect(history.entries).toHaveLength(100);
    expect(history.index).toBe(99);
    expect(history.entries[0]?.route.threadId).toBe("25");
  });
  test("in-page Back reuses the parent and Forward returns to the conversation", () => {
    const history = pushHistory(pushHistory(pushHistory(empty, list), idea), conversation);
    const back = parentHistory(history, idea, valid);
    expect(back.index).toBe(1);
    expect(traverseHistory(back, 1, valid).entries[2]?.route).toEqual(conversation);
    const unrelated = pushHistory(pushHistory(empty, list), conversation);
    const pushed = parentHistory(unrelated, idea, valid);
    expect(pushed.entries.map(entry => entry.route)).toEqual([list, conversation, idea]);
  });
  test("resolves available projects and ideas without reviving archived or deleted work", () => {
    const resolve = routeResolver([{ id: "alpha" }, { id: "archived", archivedAt: "2026-10-05" }], { alpha: [] });
    expect(resolve(idea)).toEqual(list);
    expect(resolve({ ...list, threadId: "archived" })).toBeNull();
    expect(resolve({ ...list, threadId: "deleted" })).toBeNull();
    expect(resolve(list)).toEqual(list);
  });
  test("retains each entry's scroll and drops removed idea routes", () => {
    const history = pushHistory(rememberScroll(pushHistory(empty, list), 531), idea);
    expect(traverseHistory(history, -1, valid).entries[0]?.scrollTop).toBe(531);
    const back = traverseHistory(history, -1, valid);
    const removed = traverseHistory(back, 1, route => route.solution.kind === "list" ? route : list);
    expect(removed.entries).toEqual([{ route: list, scrollTop: 531 }]);
  });
});
