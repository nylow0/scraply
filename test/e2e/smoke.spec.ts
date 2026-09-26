import { expect, test } from "@playwright/test";
import { createInstalledApp } from "./installed-app";
import { startMockBackend } from "./mock-backend";

// The backend here is the in-process mock, so this covers renderer rehydration only — checkpoint
// persistence itself is covered by the research-engine resume tests.
test("the renderer restores the problem-selection step after a restart", async ({}, testInfo) => {
  const mock = await startMockBackend();
  const installedApp = createInstalledApp({ directoryPrefix: "scraply-e2e-" });
  const launch = () => installedApp.launch({
    ...process.env,
    SCRAPLY_E2E: "1",
    SCRAPLY_E2E_BACKEND_URL: mock.url,
    SCRAPLY_E2E_BACKEND_TOKEN: mock.token,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  });
  try {
    let electron = await launch();
    let page = await electron.firstWindow();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("welcome.png") });
    await expect(page.getByLabel("Audience", { exact: true })).toBeVisible();
    await page.getByLabel("Audience", { exact: true }).fill("Repair shops");
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    const settingsBounds = await settings.boundingBox();
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(settingsBounds!.x).toBeLessThan(250);
    expect(settingsBounds!.y).toBeGreaterThan(viewport.height - 110);
    await settings.click();
    await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings.png") });
    // The OpenAI account and the search providers share one Accounts section.
    await expect(page.locator(".provider-name").getByText("Exa", { exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings-accounts.png") });
    await page.getByRole("button", { name: "Local files", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open data folder" })).toBeVisible();
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await expect(page.getByLabel("Audience", { exact: true })).toHaveValue("Repair shops");
    await page.getByRole("radio", { name: /^Babysit/ }).check();
    await page.getByRole("button", { name: "Start", exact: true }).scrollIntoViewIfNeeded();
    const startBounds = await page.getByRole("button", { name: "Start", exact: true }).boundingBox();
    expect(startBounds!.y + startBounds!.height).toBeLessThan(viewport.height);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("setup.png") });
    await page.setViewportSize({ width: 960, height: 640 });
    expect(await page.locator(".main-content").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("setup-compact.png") });
    await page.setViewportSize(viewport);
    // Discovery must start from the context alone: the audience field is optional and is left blank here
    // on purpose, so reinstating an audience requirement fails this test instead of shipping.
    await page.getByLabel("What do you want to explore?").fill("Parts sourcing");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText("Choose problems to develop")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export research JSON" })).toBeVisible();
    await page.getByText("Failed evidence requirements").click();
    await expect(page.getByText("Not evidence-backed")).toBeVisible();
    await page.getByRole("button", { name: "Use as user-asserted problem" }).click();
    const userProblem = page.getByRole("textbox", { name: "Or state the problem yourself." });
    await expect(userProblem).toHaveValue("Repair shops cannot compare every supplier on one marketplace.");
    await userProblem.fill("");

    await installedApp.close();
    electron = await launch();
    page = await electron.firstWindow();
    await expect(page.getByText("Choose problems to develop")).toBeVisible();

    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "All research" })).toBeVisible();
    await page.getByRole("textbox", { name: "Search research", exact: true }).fill("no matching research");
    await expect(page.getByText("No research found.", { exact: false })).toBeVisible();
    await page.getByRole("textbox", { name: "Search research", exact: true }).fill("Repair");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("research-finder.png") });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "All research" })).not.toBeVisible();
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
    await page.getByRole("button", { name: "Generate all selected" }).click();
    await expect(page.getByText("Supplier reliability ledger")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("ideas.png") });
    await page.getByRole("textbox", { name: "Search ideas" }).fill("nothing matches");
    await expect(page.getByText('No ideas match "nothing matches".')).toBeVisible();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(page.getByText(/Ideas are shown in saved order/)).toBeVisible();
    await expect(page.getByText(/independently confirmed outcomes/)).toHaveCount(0);
    await expect(page.getByText("Highest risk: likely · project ends")).not.toBeVisible();
    await page.getByRole("button", { name: "Open idea: Pool observed delivery windows by supplier and part category." }).click();
    await expect(page.locator(".idea-detail").getByText("Pool observed delivery windows by supplier and part category.")).toBeVisible();
    await expect(page.getByText("Highest risk: likely · project ends")).not.toBeVisible();
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
    // No name was entered: the title agent named the research.
    await expect(page.locator(".fields .primary strong")).toHaveText("Reducing repair shop delays");
    await page.getByRole("tab", { name: /Solutions/ }).click();
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
    await installedApp.cleanup(() => mock.close());
  }
});
