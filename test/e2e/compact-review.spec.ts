import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockBackend } from "./mock-backend";

test("desktop navigation and compact idea review preserve dismissed ideas", async ({}, testInfo) => {
  const mock = await startMockBackend({ longIdeaTitle: true });
  const directory = mkdtempSync(join(tmpdir(), "scraply-review-"));
  const launch = () => _electron.launch({
    executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
    args: [`--user-data-dir=${directory}`],
    env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token },
  });
  let app: ElectronApplication | undefined = await launch();
  try {
    let page = await app.firstWindow();
    // The top bar shows the brand instead of menu buttons; the hidden menu still carries the shortcuts.
    await expect(page.locator(".desktop-bar")).toContainText("Scraply");
    await expect(page.getByRole("button", { name: "File", exact: true })).toHaveCount(0);
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label))).toEqual(["File", "Edit", "View"]);
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[1]?.submenu?.items.map((item) => item.role))).toContain("paste");
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.items[0]!.submenu!.items[0]!;
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
    });
    await page.getByLabel("What do you want to explore?").fill("Parts delivery uncertainty.");
    await page.getByRole("radio", { name: /^Babysit/ }).check();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Research" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: /Setup/ }).click();
    await expect(page.getByRole("tab", { name: /Setup/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Reducing repair shop delays" })).toBeVisible();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(page.getByRole("tab", { name: /Research/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Go forward", exact: true }).click();
    await expect(page.getByRole("tab", { name: /Setup/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await expect(page.locator(".sidebar")).toHaveClass(/collapsed/);
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await expect(page.locator(".sidebar")).not.toHaveClass(/collapsed/);
    const rowHeight = await page.getByRole("button", { name: "Open thread Reducing repair shop delays", exact: true }).evaluate((el) => el.getBoundingClientRect().height);
    expect(rowHeight).toBeLessThan(70);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("compact-setup.png") });
    await page.getByRole("tab", { name: /Research/ }).click();
    await page.locator(".problem-disclosure > summary").first().click();
    await page.getByRole("checkbox", { name: "Develop this problem" }).check();
    await page.getByRole("button", { name: "Generate all selected", exact: true }).click();
    for (const width of [1400, 960]) {
      await page.setViewportSize({ width, height: 800 });
      for (const selector of [".main-content", ".workspace", ".solutions", ".idea-row"]) {
        expect(await page.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), selector).toBe(true);
      }
    }
    await page.getByRole("button", { name: "Open idea: Pool observed delivery windows by supplier and part category." }).click();
    await expect(page.locator(".idea-detail").getByText("Pool observed delivery windows by supplier and part category.", { exact: true })).toBeVisible();
    await expect(page.getByText("Highest risk:", { exact: false })).not.toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("idea-first.png") });
    await page.getByRole("button", { name: "Back to ideas" }).click();
    await page.getByRole("button", { name: /^Discard idea:/ }).click();
    await expect(page.locator(".idea-row:visible")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Discarded 1", exact: true })).toBeVisible();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".idea-row:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "Discarded 1", exact: true }).click();
    await expect(page.locator(".idea-row:visible")).toHaveCount(1);
    await page.getByRole("button", { name: /^Restore idea:/ }).click();
    await page.getByRole("button", { name: "Discarded 0", exact: true }).click();
    await expect(page.locator(".idea-row:visible")).toHaveCount(1);
    expect(mock.requests.filter((request) => request.path === "/ideas/discard").map((request) => request.body)).toEqual([
      { threadId: "thread-1", ideaId: "solution-1", discarded: true },
      { threadId: "thread-1", ideaId: "solution-1", discarded: false },
    ]);
  } finally {
    await app?.close();
    await mock.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
