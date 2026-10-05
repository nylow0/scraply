import { expect, type Locator } from "@playwright/test";

/**
 * Picks a model in the shared ModelPicker: open it, open "Legacy models" when the model is there, click its row.
 * Pickers sit inside labels in the app, so each step also checks a click acts once: the list stays open after
 * the Legacy row, and closes on the chosen value.
 */
export async function pickModel(picker: Locator, key: string): Promise<void> {
  const page = picker.page();
  await picker.click();
  const row = page.locator(`[role="listbox"] [data-value="${key}"]`);
  if (await row.count() === 0) await page.locator('[role="listbox"] .legacy-row').click();
  await row.click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(picker).toHaveAttribute("data-value", key);
}
