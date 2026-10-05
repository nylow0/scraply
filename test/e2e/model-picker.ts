import type { Locator } from "@playwright/test";

/** Picks a model in the shared ModelPicker: open it, open "Legacy models" when the model is there, click its row. */
export async function pickModel(picker: Locator, key: string): Promise<void> {
  const page = picker.page();
  await picker.click();
  const row = page.locator(`[role="listbox"] [data-value="${key}"]`);
  if (await row.count() === 0) await page.locator('[role="listbox"] .legacy-row').click();
  await row.click();
}
