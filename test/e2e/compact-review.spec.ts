import { expect, test, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockBackend } from "./mock-backend";
import type { ScraplyApi } from "../../src/preload/index";

async function invokeHistoryCommand(app: ElectronApplication, page: Page, direction: "back" | "forward", source: "menu" | "shortcut", guarded = false) {
  // Observe the preload delivery before checking a blocked command, so an unchanged route cannot pass early.
  // An allowed shortcut is consumed by the renderer before Electron's menu accelerator can send a command.
  const receipt = source === "menu" || guarded ? await page.evaluateHandle((expected) => {
    const state = { received: false };
    const { scraply } = window as unknown as { scraply: Pick<ScraplyApi, "onAppCommand"> };
    const unsubscribe = scraply.onAppCommand(command => {
      if (command === expected) {
        state.received = true;
        unsubscribe();
      }
    });
    return state;
  }, direction) : undefined;
  try {
    if (source === "shortcut") {
      await app.evaluate(({ BrowserWindow }, keyCode) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.focus();
        // Use Electron input so blocked renderer shortcuts still reach the native menu and preload.
        window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["alt"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["alt"] });
      }, direction === "back" ? "Left" : "Right");
    } else {
      await app.evaluate(({ Menu, BrowserWindow }, label) => {
        const item = Menu.getApplicationMenu()?.items.find(menu => menu.label === "View")
          ?.submenu?.items.find(menu => menu.label === label);
        if (!item?.enabled) throw new Error(`Native ${label} menu item is missing or disabled`);
        item.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
      }, direction === "back" ? "Back" : "Forward");
    }
    if (receipt) await expect.poll(() => receipt.evaluate(state => state.received)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  } finally {
    await receipt?.dispose();
  }
}

test("desktop navigation and compact idea review preserve dismissed ideas", async ({}, testInfo) => {
  const mock = await startMockBackend({ longIdeaTitle: true });
  const directory = mkdtempSync(join(tmpdir(), "scraply-review-"));
  const env = Object.fromEntries(Object.entries({ ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_REAL_BACKEND: "0",
    SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token,
    SCRAPLY_DEV_DATA_DIR: directory, SCRAPLY_DEV_SHARED_CREDENTIALS: "0", EXA_API_KEY: "", PERPLEXITY_API_KEY: "" })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({
    executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
    // Electron's development executable also needs the app entry; packaged executables need no entry argument.
    args: [...(process.env.SCRAPLY_E2E_APP ? [process.env.SCRAPLY_E2E_APP] : []), `--user-data-dir=${directory}`],
    env,
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
    await page.getByRole("radio", { name: /^Controlled/ }).check();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Research" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: /Setup/ }).click();
    await expect(page.getByRole("tab", { name: /Setup/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Reducing repair shop delays" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeEnabled();
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
      for (const selector of [".main-content", ".workspace", ".groups", ".idea-row"]) {
        expect(await page.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), selector).toBe(true);
      }
    }
    await page.getByRole("button", { name: "Open idea: Pool observed delivery windows by supplier and part category" }).click();
    await expect(page.locator(".idea-detail").getByRole("heading", { level: 1, name: "Pool observed delivery windows by supplier and part category", exact: true })).toBeVisible();
    await expect(page.getByText("Highest risk:", { exact: false })).not.toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("idea-first.png") });
    await page.getByRole("button", { name: "Back to ideas" }).click();
    await expect(page.locator(".idea-row:visible")).toHaveCount(1);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".idea-row:visible")).toHaveCount(1);
  } finally {
    await app?.close();
    await mock.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("native history respects the setup dialog and input composition", async () => {
  const mock = await startMockBackend();
  const directory = mkdtempSync(join(tmpdir(), "scraply-navigation-guards-"));
  const env = Object.fromEntries(Object.entries({ ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_REAL_BACKEND: "0",
    SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token,
    SCRAPLY_DEV_DATA_DIR: directory, SCRAPLY_DEV_SHARED_CREDENTIALS: "0", EXA_API_KEY: "", PERPLEXITY_API_KEY: "" })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
      args: [...(process.env.SCRAPLY_E2E_APP ? [process.env.SCRAPLY_E2E_APP] : []), `--user-data-dir=${directory}`],
      env,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.items[0]!.submenu!.items[0]!;
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
    });
    const brief = page.getByLabel("What do you want to explore?");
    await brief.fill("Parts delivery uncertainty.");
    const settings = page.getByRole("region", { name: "Settings", exact: true });

    // Keep Setup editable and put Settings on both sides without starting research or creating another project.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settings).toBeVisible();
    await invokeHistoryCommand(app, page, "back", "menu");
    await expect(settings).not.toBeVisible();
    for (const name of ["Go back", "Go forward"]) await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Advanced settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Advanced settings", exact: true });
    await expect(dialog).toBeVisible();
    for (const direction of ["back", "forward"] as const) {
      for (const source of ["menu", "shortcut"] as const) {
        await invokeHistoryCommand(app, page, direction, source, true);
        await expect(dialog).toBeVisible();
        await expect(settings).not.toBeVisible();
      }
    }
    await dialog.getByRole("button", { name: "Close advanced settings" }).click();
    await expect(dialog).not.toBeVisible();
    await brief.focus();
    await expect(brief).toBeFocused();
    await brief.dispatchEvent("compositionstart");
    try {
      for (const direction of ["back", "forward"] as const) {
        for (const source of ["menu", "shortcut"] as const) {
          await invokeHistoryCommand(app, page, direction, source, true);
          await expect(settings).not.toBeVisible();
          await expect(brief).toBeFocused();
        }
      }
    } finally {
      await brief.dispatchEvent("compositionend");
    }

    // Each blocked command must work once its guard ends, including shortcuts while the brief has focus.
    for (const direction of ["back", "forward"] as const) {
      for (const source of ["menu", "shortcut"] as const) {
        await brief.focus();
        await expect(brief).toBeFocused();
        await invokeHistoryCommand(app, page, direction, source);
        await expect(settings).toBeVisible();
        await invokeHistoryCommand(app, page, direction === "back" ? "forward" : "back", source);
        await expect(settings).not.toBeVisible();
        await expect(brief).toHaveValue("Parts delivery uncertainty.");
      }
    }
    expect(mock.requests.filter(request => request.method === "POST" && request.path === "/workflows/start")).toHaveLength(0);
  } finally {
    await app?.close();
    await mock.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
