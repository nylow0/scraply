import { fireEvent } from "@testing-library/svelte";

/** Picks a model the way a user does: open the picker, open "Legacy models" when the model is there, click its row. */
export async function pickModel(picker: HTMLElement, key: string): Promise<void> {
  await fireEvent.click(picker);
  const row = () => document.querySelector<HTMLElement>(`[role="listbox"] [data-value="${key}"]`);
  if (!row()) await fireEvent.click(document.querySelector<HTMLElement>('[role="listbox"] .legacy-row')!);
  await fireEvent.click(row()!);
}

/** Model names in the order an open picker lists them, with legacy models opened. */
export async function listedModels(picker: HTMLElement): Promise<string[]> {
  await fireEvent.click(picker);
  const legacy = document.querySelector<HTMLElement>('[role="listbox"] .legacy-row');
  if (legacy && !document.querySelector('[role="listbox"] .legacy-row ~ [data-value]')) await fireEvent.click(legacy);
  const names = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map((item) => item.textContent?.trim() ?? "");
  await fireEvent.keyDown(picker, { key: "Escape" });
  return names;
}
