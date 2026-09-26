import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstalledApp } from "./installed-app";

// Real main process, credential store, and backend (the E2E entry). Its OpenAI account is always connected,
// and every search key is accepted except "invalid-e2e-key", so no provider is contacted.
test("adds a search key from the welcome prompt, keeps it encrypted across a relaunch, and removes it in Settings", async ({}, testInfo) => {
  const installedApp = createInstalledApp({ directoryPrefix: "scraply-e2e-search-keys-" });
  // Environment keys override saved ones; this test covers keys the user enters in the app.
  const inherited = Object.entries(process.env).filter(([name]) => name !== "EXA_API_KEY" && name !== "PERPLEXITY_API_KEY");
  const environment = { ...Object.fromEntries(inherited), SCRAPLY_E2E: "1", SCRAPLY_E2E_REAL_BACKEND: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
  const exaKey = "e2e-exa-key-0000-3f9a";
  try {
    let page = await (await installedApp.launch(environment)).firstWindow();
    const prompt = page.getByRole("dialog", { name: "Add web search" });
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt.getByText("OpenAI connected")).toBeVisible();
    await prompt.getByLabel("Exa API key").fill("invalid-e2e-key");
    await prompt.getByRole("button", { name: "Save and continue" }).click();
    await expect(prompt.getByRole("alert")).toHaveText("Deterministic invalid Exa key");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("welcome-key-rejected.png") });
    await prompt.getByLabel("Exa API key").fill(`  ${exaKey}\n`);
    await prompt.getByRole("button", { name: "Save and continue" }).click();
    await expect(prompt).toBeHidden();

    // Stored with Windows-backed encryption: the key never appears in the file as text.
    const stored = readFileSync(join(installedApp.directory, "secrets.bin"));
    expect(stored.includes(Buffer.from(exaKey, "utf8"))).toBe(false);
    expect(stored.includes(Buffer.from(exaKey, "utf16le"))).toBe(false);

    await installedApp.close();
    page = await (await installedApp.launch(environment)).firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const exa = page.getByLabel("Exa account");
    await expect(exa).toContainText("Connected", { timeout: 20_000 });
    await expect(exa).toContainText("Saved key ending in••••3f9a");
    await expect(page.locator("body")).not.toContainText(exaKey);
    await expect(page.getByRole("dialog", { name: "Add web search" })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings-saved-key.png") });

    await exa.getByRole("button", { name: "Remove Exa key" }).click();
    await exa.getByRole("group", { name: "Remove the saved Exa key?" }).getByRole("button", { name: "Remove key" }).click();
    await expect(exa.getByRole("button", { name: "Add key for Exa" })).toBeVisible();
    await expect(exa).toContainText("Not connected");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings-key-removed.png") });

    // The removal is durable: after a relaunch the welcome prompt asks for a key again.
    await installedApp.close();
    page = await (await installedApp.launch(environment)).firstWindow();
    await expect(page.getByRole("dialog", { name: "Add web search" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await installedApp.cleanup();
  }
});
