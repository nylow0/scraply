import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import WorkflowTabs from "../../src/renderer/components/WorkflowTabs.svelte";

describe("WorkflowTabs", () => {
  test("exposes tab semantics and moves focus with the keyboard", async () => {
    const onSelect = vi.fn();
    const view = render(WorkflowTabs, {
      active: "setup",
      setupReady: true,
      researchReady: true,
      ideasReady: false,
      onSelect,
    });
    const tabs = view.getAllByRole("tab") as HTMLButtonElement[];

    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe("workflow-panel-setup");
    expect(tabs[0]?.tabIndex).toBe(0);
    expect(tabs[1]?.tabIndex).toBe(-1);
    expect(tabs[2]?.disabled).toBe(true);

    tabs[0]?.focus();
    await fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });

    expect(onSelect).toHaveBeenCalledWith("research");
    await waitFor(() => expect(document.activeElement).toBe(tabs[1]));
  });

  test("Home and End skip unavailable steps", async () => {
    const onSelect = vi.fn();
    const view = render(WorkflowTabs, {
      active: "ideas",
      setupReady: true,
      researchReady: false,
      ideasReady: true,
      onSelect,
    });
    const tabs = view.getAllByRole("tab") as HTMLButtonElement[];

    await fireEvent.keyDown(tabs[2]!, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("setup");

    await fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("ideas");
  });
});
