import { fireEvent, render, within } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, test, vi } from "vitest";
import Sidebar from "../../src/renderer/components/Sidebar.svelte";
import type { Thread } from "../../src/shared/schemas";

function history(count: number): Thread[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i), title: `Research ${i}`, status: i === count - 2 ? "discovery-running" : i === count - 1 ? "failed" : i % 2 ? "problems-ready" : "solutions-ready",
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: new Date(Date.UTC(2026, 8, 23) - i * 60_000).toISOString(),
  }));
}
function show(threads: Thread[], activeThreadId: string | null = null) {
  const callbacks = { onNew: vi.fn(), onSelect: vi.fn(), onArchive: vi.fn(), onRestore: vi.fn() };
  const props = { threads, activeThreadId, busy: false, ...callbacks, settingsControl: createRawSnippet(() => ({ render: () => "<button>Settings</button>" })) };
  return { ...render(Sidebar, props), callbacks, props };
}

describe("compact research navigation", () => {
  test.each([18, 80])("keeps six deduplicated rows with the current item outside %i recent projects", async (count) => {
    const view = show(history(count), String(count - 3));
    const list = within(view.getByRole("list", { name: "Research threads" }));
    const rows = list.getAllByRole("button", { name: /^Open thread/ });
    expect(rows).toHaveLength(6);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(new Set(rows.map((row) => row.textContent)).size).toBe(6);
    expect(list.getByRole("button", { name: "Open thread Research 1" }).getAttribute("aria-describedby")).toBe("thread-status-1");
    expect(view.getByText("Problems ready", { selector: "#thread-status-1" })).toBeTruthy();
    expect(view.getByText("Solutions ready", { selector: "#thread-status-0" })).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Running & attention 2" }));
    const dialog = within(view.getByRole("dialog", { name: "All research" }));
    expect(dialog.getByText("2 results")).toBeTruthy();
    expect(dialog.getByText(`Research ${count - 2}`)).toBeTruthy();
    expect(dialog.getByText(`Research ${count - 1}`)).toBeTruthy();
    await fireEvent.click(dialog.getByRole("button", { name: "All" }));
    expect(dialog.getByText(`${count} results`)).toBeTruthy();
    await fireEvent.input(dialog.getByRole("textbox"), { target: { value: `Research ${count - 4}` } });
    expect(dialog.getByText("1 result")).toBeTruthy();
    await fireEvent.keyDown(dialog.getByRole("textbox"), { key: "Enter" });
    expect(view.callbacks.onSelect).toHaveBeenCalledWith(String(count - 4));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("keeps archive and restore available in the complete collection and preserves full names", async () => {
    const threads = history(18);
    threads[8]!.title = "A very long existing research name that must remain intact across archival and restoration";
    const view = show(threads, "8");
    const current = view.getByRole("button", { name: `Open thread ${threads[8]!.title}` });
    expect(current.getAttribute("title")).toContain(threads[8]!.title);
    await fireEvent.click(view.getByRole("button", { name: "All research" }));
    const dialog = within(view.getByRole("dialog"));
    await fireEvent.click(dialog.getByRole("button", { name: `Archive research ${threads[8]!.title}` }));
    expect(view.callbacks.onArchive).toHaveBeenCalledWith("8");
    const archived = threads.map((thread) => thread.id === "8" ? { ...thread, archivedAt: "2026-09-23T00:00:00.000Z" } : thread);
    await view.rerender({ ...view.props, threads: archived });
    await fireEvent.click(dialog.getByRole("button", { name: "Archived" }));
    expect(dialog.getByText(threads[8]!.title)).toBeTruthy();
    await fireEvent.click(dialog.getByRole("button", { name: `Restore ${threads[8]!.title}` }));
    expect(view.callbacks.onRestore).toHaveBeenCalledWith("8");
    await view.rerender(view.props);
    expect(dialog.getByText("No archived research found.")).toBeTruthy();
  });

  test("keeps the empty collection and keyboard shortcut usable", async () => {
    const view = show([]);
    expect(view.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Open thread/ })).toBeNull();
    await fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Search research" }));
    expect(view.getByText("No research found.")).toBeTruthy();
  });
});
