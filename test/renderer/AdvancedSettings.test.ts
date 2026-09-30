import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import AdvancedSettings from "../../src/renderer/components/AdvancedSettings.svelte";

test("shows enabled summaries, saves changes, and restores the saved preference on reopen", async () => {
  let settings = { reasoningSummaries: true, maxConcurrentModelCalls: 1 };
  const saveAdvancedSettings = vi.fn(async (next: typeof settings) => { settings = next; return next; });
  Object.defineProperty(window, "scraply", { configurable: true, value: {
    getAdvancedSettings: async () => settings, saveAdvancedSettings,
  } });
  const first = render(AdvancedSettings);
  const checkbox = first.getByRole("checkbox", { name: "Show reasoning summaries in the trace" }) as HTMLInputElement;
  await waitFor(() => expect(checkbox.disabled).toBe(false));
  expect(checkbox.checked).toBe(true);
  await fireEvent.click(checkbox);
  await fireEvent.change(first.getByRole("combobox", { name: "Concurrent model calls" }), { target: { value: "2" } });
  await fireEvent.click(first.getByRole("button", { name: "Save advanced settings" }));
  await waitFor(() => expect(first.getByRole("status").textContent).toBe("Advanced settings saved"));
  expect(saveAdvancedSettings).toHaveBeenCalledWith({ reasoningSummaries: false, maxConcurrentModelCalls: 2 });
  first.unmount();
  const reopened = render(AdvancedSettings);
  const restored = reopened.getByRole("checkbox", { name: "Show reasoning summaries in the trace" }) as HTMLInputElement;
  await waitFor(() => expect(restored.disabled).toBe(false));
  expect(restored.checked).toBe(false);
  expect((reopened.getByRole("combobox", { name: "Concurrent model calls" }) as HTMLSelectElement).value).toBe("2");
});
