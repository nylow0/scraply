import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockBackend } from "./mock-backend";

// The backend here is the in-process mock, so this covers renderer rehydration only — checkpoint
// persistence itself is covered by the research-engine resume tests.
test("the renderer restores the problem-selection step after a restart", async ({}, testInfo) => {
  const mock = await startMockBackend();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const executablePath = process.env.SCRAPLY_E2E_EXECUTABLE ?? path.join(process.cwd(), "release", "win-unpacked", "Scraply.exe");
  const launch = (): Promise<ElectronApplication> => _electron.launch({ executablePath, args: [`--user-data-dir=${userDataDir}`], env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  let electron: ElectronApplication | undefined = await launch();
  try {
    let page = await electron.firstWindow();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("welcome.png") });
    await page.getByRole("button", { name: "Create research" }).click();
    await page.getByLabel("Research name").fill("Repair delays");
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    const settingsBounds = await settings.boundingBox();
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(settingsBounds!.x).toBeLessThan(250);
    expect(settingsBounds!.y).toBeGreaterThan(viewport.height - 110);
    await settings.click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings.png") });
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Exa", { exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings-connections.png") });
    await page.getByRole("button", { name: "Local files", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open data folder" })).toBeVisible();
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await expect(page.getByLabel("Research name")).toHaveValue("Repair delays");
    const startBounds = await page.getByRole("button", { name: "Discover problems" }).boundingBox();
    expect(startBounds!.y + startBounds!.height).toBeLessThan(viewport.height);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("setup.png") });
    await page.setViewportSize({ width: 960, height: 640 });
    expect(await page.locator(".main-content").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("setup-compact.png") });
    await page.setViewportSize(viewport);
    // Discovery must start from the context alone: the audience field is optional and is left blank here
    // on purpose, so reinstating an audience requirement fails this test instead of shipping.
    await page.getByLabel("What do you want to explore?").fill("Parts sourcing");
    await page.getByRole("button", { name: "Discover problems" }).click();
    await expect(page.getByText("Choose problems to develop")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export research JSON" })).toBeVisible();
    await page.getByText("Failed evidence requirements").click();
    await expect(page.getByText("Not evidence-backed")).toBeVisible();
    await page.getByRole("button", { name: "Use as user-asserted problem" }).click();
    const userProblem = page.getByRole("textbox", { name: "Or state the problem yourself." });
    await expect(userProblem).toHaveValue("Repair shops cannot compare every supplier on one marketplace.");
    await userProblem.fill("");

    await electron.close();
    electron = undefined;
    electron = await launch();
    page = await electron.firstWindow();
    await expect(page.getByText("Choose problems to develop")).toBeVisible();

    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Find research" })).toBeVisible();
    await page.getByRole("textbox", { name: "Search research", exact: true }).fill("no matching research");
    await expect(page.getByText("No research found.", { exact: false })).toBeVisible();
    await page.getByRole("textbox", { name: "Search research", exact: true }).fill("Repair");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("research-finder.png") });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Find research" })).not.toBeVisible();
    await page.getByRole("textbox", { name: "Search problems" }).fill("nothing matches");
    await expect(page.getByText('No problems match "nothing matches".')).toBeVisible();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("research.png") });
    await expect(page.getByRole("checkbox", { name: "Develop this problem" })).not.toBeVisible();
    const problemTitle = page.locator(".problem-disclosure > summary").first();
    await problemTitle.focus();
    await page.keyboard.press("Enter");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("research-expanded.png") });
    await page.getByRole("checkbox", { name: "Develop this problem" }).check();
    await page.getByRole("textbox", { name: "Search problems" }).fill("nothing matches");
    await page.getByRole("button", { name: "Clear filter" }).click();
    await page.locator(".problem-disclosure > summary").first().click();
    await expect(page.getByRole("checkbox", { name: "Develop this problem" })).toBeChecked();
    await page.getByRole("button", { name: "Commit selection" }).click();
    await expect(page.getByText("Supplier reliability ledger")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("ideas.png") });
    await page.getByRole("textbox", { name: "Search ideas" }).fill("nothing matches");
    await expect(page.getByText('No ideas match "nothing matches".')).toBeVisible();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(page.getByText(/Options are not ranked/)).toBeVisible();
    await expect(page.getByText(/independently confirmed outcomes/)).toHaveCount(0);
    await expect(page.getByText("Highest risk: likely · project ends")).not.toBeVisible();
    await page.getByText("Supplier reliability ledger").click();
    await expect(page.getByText("Highest risk: likely · project ends")).toBeVisible();
    await page.getByText("Review all risks and responses").click();
    await expect(page.getByText("Volume is too sparse")).toBeVisible();
    await page.getByText("Evidence behind this problem").click();
    await expect(page.getByText("Backorders add days to routine repairs.")).toBeVisible();
    await page.getByRole("tab", { name: /Research/ }).click();
    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await page.getByText("Small repair shops cannot reliably predict parts arrival times.", { exact: true }).click();
    // Cited factors stay collapsed so the archive can be scanned; the evidence must survive one expand.
    await page.getByText("1 cited factors", { exact: true }).click();
    await expect(page.getByText("Backorders add days to routine repairs.")).toBeVisible();
    await page.getByRole("tab", { name: /Setup/ }).click();
    await expect(page.getByText("Where this work started.")).toBeVisible();
    await page.getByRole("tab", { name: /Ideas/ }).click();
    await expect(page.getByText("Supplier reliability ledger")).toBeVisible();
    await page.setViewportSize({ width: 960, height: 640 });
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    expect(await page.locator(".main-content").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("ideas-compact.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("tab", { name: /Research/ }).click();
    const reducedTitle = page.locator(".problem-disclosure > summary").first();
    await reducedTitle.click();
    expect(await reducedTitle.evaluate((element) => getComputedStyle(element, "::after").transitionDuration)).toBe("0s");
    await expect(page.getByText("1 cited factors", { exact: true })).toBeVisible();
  } finally {
    await electron?.close(); await mock.close(); rmSync(userDataDir, { recursive: true, force: true });
  }
});
