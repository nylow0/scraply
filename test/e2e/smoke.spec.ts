import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockBackend, type MockBackend } from "./mock-backend";

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  targetUrl: string;
  close: () => Promise<void>;
}

async function launchIsolatedApp(mock: MockBackend): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RENDERER_URL;
  env.SCRAPLY_E2E = "1";
  env.SCRAPLY_E2E_BACKEND_URL = mock.url;
  env.SCRAPLY_E2E_BACKEND_TOKEN = mock.token;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

  const electronExe = process.platform === "win32"
    ? path.join(process.cwd(), "node_modules/electron/dist/electron.exe")
    : path.join(process.cwd(), "node_modules/electron/dist/electron");
  const appEntryArgs = [path.join(process.cwd(), "out/main/index.js")];

  const electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [
      ...appEntryArgs,
      `--user-data-dir=${userDataDir}`,
    ],
    env,
    timeout: 30_000,
  });
  let page: Page | undefined;
  try {
    page = await electronApp.firstWindow({ timeout: 30_000 });
  } catch (error) {
    if (!electronApp.process().killed) electronApp.process().kill();
    throw error;
  }
  const targetUrl = page.url();
  const close = async (): Promise<void> => {
    await Promise.race([
      electronApp.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (!electronApp.process().killed) electronApp.process().kill();
  };
  return {
    electronApp,
    page,
    targetUrl,
    close,
  };
}

test("completes setup, approved research, synthesis, ideas, rating, restart, and a child branch", async () => {
  const mock = await startMockBackend();
  let app: LaunchedApp | null = null;
  try {
    app = await launchIsolatedApp(mock);
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
    await app.page.getByLabel("Exa API key").fill("exa-local-e2e-key");
    await app.page.getByRole("button", { name: "Validate API keys and continue" }).click();

    await expect(app.page.getByRole("button", { name: "Create new research thread" })).toBeVisible();
    await app.page.getByRole("button", { name: "Create new research thread" }).click();
    await expect(app.page.getByRole("heading", { name: "New research" })).toBeVisible();

    const requiredAnswers = app.page.locator("section.setup textarea");
    await expect(requiredAnswers).toHaveCount(15);
    for (let index = 0; index < 10; index += 1) await requiredAnswers.nth(index).fill(`Deterministic answer ${index + 1}`);
    await app.page.getByRole("button", { name: "Review brief" }).click();

    await expect(app.page.getByRole("heading", { name: "Project brief" })).toBeVisible();
    await app.page.getByLabel("Project name").fill("Student Income Lab E2E");
    await app.page.getByRole("button", { name: "Confirm brief & review cost" }).click();

    await expect(app.page.getByRole("heading", { name: "Run configuration" })).toBeVisible();
    await expect(app.page.getByLabel("Research approval summary")).toContainText("6 research lenses");
    await app.page.getByRole("button", { name: "Approve & start research" }).click();

    await expect(app.page.getByLabel("Research progress")).toBeVisible();
    await expect(app.page.getByLabel("Report: Composite synthesis")).toBeVisible();
    await app.page.getByLabel("Report: Composite synthesis").getByText("Composite synthesis").click();
    await expect(app.page.getByText("Demand is supported by deterministic local evidence.")).toBeVisible();

    await app.close();
    app = await launchIsolatedApp(mock);
    await expect(app.page.getByRole("heading", { name: "Student Income Lab" })).toBeVisible();
    await expect(app.page.getByLabel("Report: Composite synthesis")).toBeVisible();

    await app.page.getByRole("button", { name: "Generate ideas" }).click();
    await expect(app.page.getByRole("heading", { name: "Idea workspace" })).toBeVisible();
    await expect(app.page.getByRole("heading", { name: "Exam Feedback Copilot" })).toBeVisible();
    await app.page.getByRole("button", { name: "Rate 4" }).click();
    await expect(app.page.getByText("Saved: 4/5")).toBeVisible();
    await app.page.getByRole("button", { name: "Dive deeper" }).click();
    await expect(app.page.getByRole("dialog", { name: /Explore/ })).toBeVisible();
    await app.page.getByLabel("Exploration angle").fill("Validate demand before implementation");
    await app.page.getByRole("button", { name: "Create focused branch" }).click();
    await expect(app.page.getByRole("heading", { name: "Explore: Exam Feedback Copilot" })).toBeVisible();

    expect(mock.requests.filter((request) => request.path === "/research/start")).toHaveLength(1);
    expect(mock.requests.some((request) => request.path === "/ideas/rate" && (request.body as { rating?: number }).rating === 4)).toBe(true);
    expect(mock.requests.some((request) => request.path === "/threads/branch")).toBe(true);
  } finally {
    await app?.close();
    await mock.close();
  }
});

test("keeps partial reports when an interrupted run is cancelled", async () => {
  const mock = await startMockBackend("interrupted");
  const app = await launchIsolatedApp(mock);
  try {
    await expect(app.page.getByText("Interrupted research")).toBeVisible();
    await app.page.getByRole("button", { name: "Cancel interrupted research and keep partial reports" }).click();
    await expect(app.page.getByText("Interrupted research")).toBeHidden();
    await expect(app.page.getByLabel("Report: Partial market evidence")).toBeVisible();
    expect(mock.requests.some((request) => request.path === "/research/cancel-incomplete")).toBe(true);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("surfaces a typed provider failure without claiming the run completed", async () => {
  const mock = await startMockBackend("provider-failure");
  const app = await launchIsolatedApp(mock);
  try {
    await expect(app.page.getByRole("heading", { name: "Run configuration" })).toBeVisible();
    await app.page.getByRole("button", { name: "Approve & start research" }).click();
    await expect(app.page.getByRole("alert")).toContainText("Deterministic provider timeout");
    await expect(app.page.getByRole("button", { name: "Generate ideas" })).toBeHidden();
    expect(mock.requests.filter((request) => request.path === "/research/start")).toHaveLength(1);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("blocks remote navigation and new windows in the Electron shell", async () => {
  const mock = await startMockBackend("interrupted");
  const app = await launchIsolatedApp(mock);
  try {
    expect(app.targetUrl).toContain("/out/renderer/index.html");
    const originalUrl = app.page.url();
    await app.page.evaluate(() => window.location.assign("https://example.com/blocked"));
    await app.page.waitForTimeout(250);
    expect(app.page.url()).toBe(originalUrl);

    const context = app.page.context();
    const pageCount = context.pages().length;
    await app.page.evaluate(() => window.open("https://example.com/new-window", "_blank"));
    await app.page.waitForTimeout(250);
    expect(context.pages()).toHaveLength(pageCount);
  } finally {
    await app.close();
    await mock.close();
  }
});
