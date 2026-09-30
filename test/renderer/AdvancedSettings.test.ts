import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import AdvancedSettings from "../../src/renderer/components/AdvancedSettings.svelte";

test("saves concurrent model capacity and restores the saved preference on reopen", async () => {
  let settings = { maxConcurrentModelCalls: 1 };
  const saveAdvancedSettings = vi.fn(async (next: typeof settings) => { settings = next; return next; });
  Object.defineProperty(window, "scraply", { configurable: true, value: {
    getAdvancedSettings: async () => settings, saveAdvancedSettings,
  } });
  const first = render(AdvancedSettings);
  const selector = first.getByRole("combobox", { name: "Concurrent model calls" }) as HTMLSelectElement;
  await waitFor(() => expect(selector.disabled).toBe(false));
  await fireEvent.change(first.getByRole("combobox", { name: "Concurrent model calls" }), { target: { value: "2" } });
  await fireEvent.click(first.getByRole("button", { name: "Save advanced settings" }));
  await waitFor(() => expect(first.getByRole("status").textContent).toBe("Advanced settings saved"));
  expect(saveAdvancedSettings).toHaveBeenCalledWith({ maxConcurrentModelCalls: 2 });
  first.unmount();
  const reopened = render(AdvancedSettings);
  const restored = reopened.getByRole("combobox", { name: "Concurrent model calls" }) as HTMLSelectElement;
  await waitFor(() => expect(restored.disabled).toBe(false));
  expect((reopened.getByRole("combobox", { name: "Concurrent model calls" }) as HTMLSelectElement).value).toBe("2");
});
