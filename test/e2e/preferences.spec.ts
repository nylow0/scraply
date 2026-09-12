import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockBackend } from "./mock-backend";

test("research defaults persist after reopen while a saved project keeps its choices", async ({}, testInfo) => {
  const mock = await startMockBackend();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-defaults-"));
  const launch = () => _electron.launch({
    executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? path.join(process.cwd(), "release/win-unpacked/Scraply.exe"),
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token },
  });
  let electron: ElectronApplication | undefined = await launch();
  try {
    let page = await electron.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Research defaults", exact: true }).click();
    await expect(page.getByLabel("Default search provider", { exact: true })).toHaveValue("exa");
    await expect(page.getByLabel("Default model", { exact: true })).toHaveValue("openai-subscription:gpt-5.6-sol");
    await expect(page.getByLabel("Default model").getByRole("option", { name: "GPT-6 Astra", exact: true })).toHaveCount(1);
    await page.getByLabel("Default search provider", { exact: true }).selectOption("perplexity");
    await page.getByLabel("Default model", { exact: true }).selectOption("openai-subscription:gpt-6-astra");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(page.getByText("Defaults saved", { exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("defaults.png") });
    await electron.close();
    electron = await launch();
    page = await electron.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Research defaults", exact: true }).click();
    await expect(page.getByLabel("Default search provider", { exact: true })).toHaveValue("perplexity");
    await expect(page.getByLabel("Default model", { exact: true })).toHaveValue("openai-subscription:gpt-6-astra");
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Research name", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("openai-subscription:gpt-6-astra");
    await expect(page.getByLabel("Search provider", { exact: true })).toHaveValue("perplexity");
    // Per-run overrides remain separate from the defaults saved in Settings.
    await page.getByLabel("Model", { exact: true }).selectOption("openai-subscription:gpt-5.6-sol");
    await page.getByLabel("Search provider", { exact: true }).selectOption("exa");
    await page.getByLabel("Research name", { exact: true }).fill("Saved provider choices");
    await page.getByLabel("What do you want to explore?").fill("Parts sourcing");
    await page.getByRole("button", { name: "Discover problems", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose problems to develop" })).toBeVisible();
    await electron.close();
    electron = await launch();
    page = await electron.firstWindow();
    await page.getByRole("tab", { name: /Setup/ }).click();
    await expect(page.locator(".setup .run-settings").getByText("gpt-5.6-sol", { exact: true })).toBeVisible();
    await expect(page.locator(".setup .run-settings").getByText("exa", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Research defaults", exact: true }).click();
    await expect(page.getByLabel("Default model", { exact: true })).toHaveValue("openai-subscription:gpt-6-astra");
    await expect(page.getByLabel("Default search provider", { exact: true })).toHaveValue("perplexity");
  } finally {
    await electron?.close();
    await mock.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
