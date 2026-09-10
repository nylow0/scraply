import { expect, test, _electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScraplyApi } from "../../src/preload/index";

test("the packaged backend reuses empty drafts without losing a setup draft or saved project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-packaged-drafts-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(env)) {
    if (key.startsWith("SCRAPLY_E2E") || key.startsWith("SCRAPLY_RUNTIME") || ["EXA_API_KEY", "PERPLEXITY_API_KEY"].includes(key)) delete env[key];
  }
  const app = await _electron.launch({
    executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
    args: [`--user-data-dir=${directory}`], env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Create research", exact: true }).click();
    const name = page.getByLabel("Research name", { exact: true });
    await expect(name).toBeVisible();
    await name.fill("Unsaved research idea");
    const initial = await page.evaluate(() => (window as unknown as { scraply: ScraplyApi }).scraply.getWorkspace());
    const newResearch = page.getByRole("button", { name: "Create new research thread", exact: true });
    for (let index = 0; index < 10; index += 1) {
      await newResearch.click();
      await expect(newResearch).toBeEnabled();
      await expect(name).toHaveValue("Unsaved research idea");
    }
    let state = await page.evaluate(() => (window as unknown as { scraply: ScraplyApi }).scraply.getWorkspace());
    expect(state.threads).toHaveLength(1);
    expect(state.activeThreadId).toBe(initial.activeThreadId);
    await page.evaluate(async () => {
      const api = (window as unknown as { scraply: ScraplyApi }).scraply;
      const current = await api.getWorkspace();
      await api.saveScope({ threadId: current.activeThreadId!, scope: {
        title: "Saved research idea", audience: "Students", domain: "Study planning", observations: "", offLimits: [],
      } });
    });
    await page.reload();
    await newResearch.click();
    await expect(name).toHaveValue("");
    await newResearch.click();
    await expect(newResearch).toBeEnabled();
    state = await page.evaluate(() => (window as unknown as { scraply: ScraplyApi }).scraply.getWorkspace());
    expect(state.threads).toHaveLength(2);
    expect(state.activeThreadId).not.toBe(initial.activeThreadId);
    await page.getByRole("button", { name: "Open thread Saved research idea", exact: true }).click();
    await expect(name).toHaveValue("Saved research idea");
    await newResearch.click();
    await expect(name).toHaveValue("");
    expect((await page.evaluate(() => (window as unknown as { scraply: ScraplyApi }).scraply.getWorkspace())).threads).toHaveLength(2);
  } finally {
    await app.close();
    // Windows may hold database handles briefly after the app and backend exit.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
