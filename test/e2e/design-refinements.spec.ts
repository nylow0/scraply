import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockBackend } from "./mock-backend";

test("compact settings, consistent fields, title defaults, and archive recovery", async ({}, testInfo) => {
  const mock = await startMockBackend();
  const directory = mkdtempSync(join(tmpdir(), "scraply-design-"));
  const launch = () => _electron.launch({
    executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
    args: [`--user-data-dir=${directory}`],
    env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token },
  });
  let app: ElectronApplication | undefined = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByLabel("Audience", { exact: true })).toBeVisible();
    await expect(page.locator(".heading-icon,.welcome")).toHaveCount(0);
    const fields = await page.locator(".scope-page input:not([type=radio]),.scope-page textarea:not(.main-brief textarea),.scope-page select").evaluateAll((items) => items.map((el) => ({ font: getComputedStyle(el).fontSize, resize: getComputedStyle(el).resize, textarea: el.tagName === "TEXTAREA" })));
    expect(new Set(fields.map((field) => field.font))).toEqual(new Set(["14px"]));
    expect(fields.filter((field) => field.textarea).every((field) => field.resize === "vertical")).toBe(true);
    await expect(page.locator(".main-brief textarea")).toHaveCSS("font-size", "15px");
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    const settingsBounds = await settings.boundingBox();
    await settings.click();
    const popup = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(popup).toBeVisible();
    const popupBounds = await popup.boundingBox();
    expect(popupBounds!.width).toBeLessThan(800);
    expect(popupBounds!.height).toBeLessThan(600);
    const back = page.getByRole("button", { name: "Close settings", exact: true });
    const backBounds = await back.boundingBox();
    expect(backBounds!.width).toBeLessThan(50);
    expect(settingsBounds!.y).toBeGreaterThan(backBounds!.y);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings-popup.png") });
    await page.getByRole("button", { name: "Research defaults", exact: true }).click();
    await expect(page.getByLabel("Title model", { exact: true })).toHaveValue("openai-subscription:gpt-6-luna");
    await expect(page.getByLabel("Title reasoning", { exact: true })).toHaveValue("low");
    const provider = page.getByLabel("Default search provider", { exact: true });
    expect(await provider.evaluate((el) => getComputedStyle(el).appearance)).toBe("base-select");
    await provider.click();
    await expect(provider).toHaveJSProperty("value", "exa");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("provider-menu.png") });
    await page.keyboard.press("Escape");
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.getByPlaceholder("What matters most: time, budget, or other limits?")).toBeVisible();
    await page.getByLabel("What do you want to explore?").fill("Reducing repair shop delays");
    await page.getByRole("radio", { name: /^Babysit/ }).check();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".location")).toHaveText("Reducing repair shop delays");
    expect(mock.requests.find((request) => request.path === "/scope")?.body).toMatchObject({
      scope: { title: "Reducing repair shop delays" },
    });
    const bar = page.locator(".topbar");
    const researchBounds = await bar.boundingBox();
    await page.getByRole("tab", { name: /Setup/ }).click();
    const setupBounds = await bar.boundingBox();
    expect(setupBounds!.x).toBe(researchBounds!.x);
    expect(setupBounds!.width).toBe(researchBounds!.width);
    expect(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(0, 0, 0)");
    await page.getByRole("button", { name: "Archive research Reducing repair shop delays", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open thread Reducing repair shop delays", exact: true })).toHaveCount(0);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Archived research", exact: true }).click();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("archive.png") });
    await page.getByRole("button", { name: "Restore Reducing repair shop delays", exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Open thread Reducing repair shop delays", exact: true }).click();
    await expect(page.locator(".location")).toHaveText("Reducing repair shop delays");
    await page.getByRole("button", { name: "Archive research Reducing repair shop delays", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Archived research", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Reducing repair shop delays", exact: true }).click();
    await expect(page.getByText("No archived research.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Research defaults", exact: true }).click();
    await page.getByLabel("Title model", { exact: true }).selectOption("openai-subscription:gpt-6-astra");
    await page.getByLabel("Title reasoning", { exact: true }).selectOption("medium");
    await page.getByRole("button", { name: "Save defaults", exact: true }).click();
    await expect(page.getByText("Defaults saved", { exact: true })).toBeVisible();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Research defaults", exact: true }).click();
    await expect(page.getByLabel("Title model", { exact: true })).toHaveValue("openai-subscription:gpt-6-astra");
    await expect(page.getByLabel("Title reasoning", { exact: true })).toHaveValue("medium");
  } finally {
    await app?.close();
    await mock.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
