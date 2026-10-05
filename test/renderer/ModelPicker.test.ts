import { fireEvent, render } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import ModelPicker from "../../src/renderer/components/ModelPicker.svelte";
import type { ModelOption } from "../../src/shared/schemas";

// The account lists models in its own order; the picker must not follow it.
const options: ModelOption[] = ["gpt-5.6-sol", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"].map((modelId) => ({
  providerId: "openai-subscription", modelId, displayName: modelId, defaultReasoningEffort: "medium",
  reasoningEfforts: [{ id: "medium", description: "Balanced" }],
}));
const key = (modelId: string) => `openai-subscription:${modelId}`;
const names = () => [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent?.trim());

test("lists the latest models first with GPT-6.1 Sol on top and the rest behind a counted Legacy row", async () => {
  const view = render(ModelPicker, { options, value: key("gpt-6.1-sol"), label: "Model" });
  const picker = view.getByRole("combobox", { name: "Model" });
  expect(picker.textContent?.trim()).toBe("GPT-6.1 Sol");
  await fireEvent.click(picker);
  expect(names()).toEqual(["GPT-6.1 Sol", "GPT-6 Astra", "GPT-6 Luna", "Legacy models3"]);
  await fireEvent.click(view.getByText("Legacy models"));
  expect(names()).toEqual(["GPT-6.1 Sol", "GPT-6 Astra", "GPT-6 Luna", "Legacy models3", "GPT-5.6 Sol", "GPT-6 Sol", "GPT-5.6 Luna"]);
});

test("works with the keyboard alone: open, move, pick, and close without picking", async () => {
  const onchange = vi.fn();
  const view = render(ModelPicker, { options, value: key("gpt-6.1-sol"), label: "Model", onchange });
  const picker = view.getByRole("combobox", { name: "Model" }) as HTMLButtonElement;
  picker.focus();
  await fireEvent.keyDown(picker, { key: "Enter" });
  expect(picker.getAttribute("aria-expanded")).toBe("true");
  await fireEvent.keyDown(picker, { key: "ArrowDown" });
  await fireEvent.keyDown(picker, { key: "Enter" });
  expect(onchange).toHaveBeenCalledWith(key("gpt-6-astra"));
  expect(picker.value).toBe(key("gpt-6-astra"));
  expect(view.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(picker);

  // Arrow to the Legacy row, open it with Enter, move into it, then leave with Escape: nothing changes.
  await fireEvent.keyDown(picker, { key: "ArrowDown" });
  await fireEvent.keyDown(picker, { key: "End" });
  await fireEvent.keyDown(picker, { key: "Enter" });
  expect(names()).toContain("GPT-6 Sol");
  await fireEvent.keyDown(picker, { key: "ArrowDown" });
  await fireEvent.keyDown(picker, { key: "Escape" });
  expect(view.queryByRole("listbox")).toBeNull();
  expect(onchange).toHaveBeenCalledTimes(1);
  expect(picker.value).toBe(key("gpt-6-astra"));
});

test("a project saved with a legacy model shows it selected, with its group already open", async () => {
  const view = render(ModelPicker, { options, value: key("gpt-6-sol"), label: "Model" });
  const picker = view.getByRole("combobox", { name: "Model" });
  expect(picker.textContent?.trim()).toBe("GPT-6 Sol");
  await fireEvent.click(picker);
  // The test DOM has no top layer, so the open list counts as hidden to role queries.
  expect(view.getByRole("option", { name: "GPT-6 Sol", hidden: true }).getAttribute("aria-selected")).toBe("true");
});
