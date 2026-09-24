import { expect, test, _electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScraplyApi } from "../../src/preload/index";

test("setup hierarchy, source preferences, keyboard controls, and sidebar fit in the installed app", async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-setup-polish-"));
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
    const appIcon = await app.evaluate(async ({ app }) => (await app.getFileIcon(process.execPath, { size: "large" })).toPNG().toString("base64"));
    await testInfo.attach("installed-app-icon", { body: Buffer.from(appIcon, "base64"), contentType: "image/png" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
    await expect(page.getByLabel("Research name", { exact: true })).toBeVisible();
    // Seed a real library through the preload API in this disposable profile.
    await page.evaluate(async () => {
      const api = (window as unknown as { scraply: ScraplyApi }).scraply;
      for (let index = 1; index <= 19; index++) await api.createThread(`Saved research ${index}`);
      await api.createThread();
    });
    await page.reload();
    const name = page.getByLabel("Research name", { exact: true });
    await expect(name).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("setup.png") });
    await expect(name).toBeInViewport();
    await expect(page.locator("main h1:visible")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Your brief" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Research setup" })).toHaveCount(0);
    await expect(page.locator(".workflow-tabs .active i")).toHaveCount(0);
    expect(await page.locator(".brief-panel").evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
    expect(await page.locator(".mode-picker input").first().evaluate(el => el.getBoundingClientRect().width)).toBe(14);

    await page.getByText("Find problems to solve", { exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: /^I have a problem/ })).toBeChecked();
    await expect(page.getByText("What problem do you want to solve?", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Vibe" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("known-problem.png") });
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("radio", { name: /^Find problems/ })).toBeChecked();

    const count = page.getByRole("spinbutton", { name: "Solutions per problem", exact: true });
    const fewer = page.getByRole("button", { name: "Fewer solutions per problem", exact: true });
    const more = page.getByRole("button", { name: "More solutions per problem", exact: true });
    await more.click();
    await expect(count).toHaveValue("4");
    await fewer.click();
    await expect(count).toHaveValue("3");
    await count.fill("1");
    await expect(fewer).toBeDisabled();
    await count.fill("20");
    await expect(more).toBeDisabled();
    await fewer.click();
    await expect(count).toHaveValue("19");
    await count.fill("");
    await more.click();
    await expect(count).toHaveValue("4");
    await count.focus();
    await page.keyboard.press("ArrowDown");
    await expect(count).toHaveValue("3");
    const countBox = (await count.boundingBox())!;
    const moreBox = (await more.boundingBox())!;
    expect(Math.abs((moreBox.y + moreBox.height / 2) - (countBox.y + countBox.height / 2))).toBeLessThan(1);
    expect(moreBox.x + moreBox.width).toBeLessThan(countBox.x + countBox.width);
    await page.screenshot({ path: testInfo.outputPath("run-controls.png") });

    const coverage = page.getByLabel("Search coverage", { exact: true });
    await expect(coverage).toHaveValue("web");
    expect(await coverage.evaluate(el => getComputedStyle(el, "::picker-icon").content)).toBe('""');
    expect(await coverage.evaluate(el => getComputedStyle(el, "::picker(select)").transitionDuration)).toBe("0s");
    await coverage.click();
    await page.screenshot({ path: testInfo.outputPath("source-picker.png") });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(coverage).toHaveValue("communities");
    await expect(page.getByText("Audience evidence from Reddit and Hacker News. Market research still searches all sites.")).toBeVisible();
    await coverage.click();
    await page.keyboard.press("Escape");
    await expect(coverage).toBeFocused();
    await coverage.selectOption("web");

    const list = page.getByRole("list", { name: "Research threads" });
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = list.getByRole("listitem").last();
    const lastBox = (await last.boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(listBox.y + listBox.height - 8);
    expect(await list.evaluate(el => getComputedStyle(el, "::-webkit-scrollbar-button").display)).toBe("none");
    await page.screenshot({ path: testInfo.outputPath("setup-sidebar-bottom.png") });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog.locator(".account-emblem svg")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("account.png") });
    await dialog.getByRole("button", { name: "Research defaults", exact: true }).click();
    await expect(page.getByLabel("Default model").getByRole("option", { name: "GPT-6 Astra", exact: true })).toHaveCount(1);
    await expect(page.getByLabel("Title model").getByRole("option", { name: "GPT-6 Astra", exact: true })).toHaveCount(1);
    await page.getByLabel("Default model", { exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("model-picker.png") });
    await page.keyboard.press("Escape");
    const defaultCoverage = page.getByLabel("Default search coverage");
    await defaultCoverage.selectOption("communities");
    await page.getByLabel("Default research depth").selectOption("deep");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect(page.getByText("Defaults saved", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("advanced-search.png") });
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.reload();
    await expect(coverage).toHaveValue("communities");
    await expect(page.getByLabel("Research depth", { exact: true })).toHaveValue("deep");

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 800));
    await name.scrollIntoViewIfNeeded();
    expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("setup-960.png") });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
