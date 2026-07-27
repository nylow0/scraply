import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../src/db/migrations";
import { startMockBackend, type MockBackend } from "./mock-backend";

interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  targetUrl: string;
  close: () => Promise<void>;
}

async function launchIsolatedApp(
  mock: MockBackend | null,
  userDataDir: string,
  options: { productionBackend?: boolean } = {},
): Promise<LaunchedApp> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RENDERER_URL;
  delete env.SCRAPLY_E2E_BACKEND_URL;
  delete env.SCRAPLY_E2E_BACKEND_TOKEN;
  delete env.SCRAPLY_E2E_REAL_BACKEND;
  env.SCRAPLY_E2E = "1";
  if (mock) {
    env.SCRAPLY_E2E_BACKEND_URL = mock.url;
    env.SCRAPLY_E2E_BACKEND_TOKEN = mock.token;
  } else if (!options.productionBackend) {
    env.SCRAPLY_E2E_REAL_BACKEND = "1";
  }
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

  const electronExe = process.env.SCRAPLY_E2E_EXECUTABLE
    ?? path.join(process.cwd(), "release", "win-unpacked", "Scraply.exe");

  const electronApp = await _electron.launch({
    executablePath: electronExe,
    args: [`--user-data-dir=${userDataDir}`],
    env,
    timeout: 30_000,
  });
  const childProcess = electronApp.process();
  let page: Page | undefined;
  try {
    page = await electronApp.firstWindow({ timeout: 30_000 });
  } catch (error) {
    if (childProcess.exitCode === null && !childProcess.killed) childProcess.kill();
    throw error;
  }
  const targetUrl = page.url();
  const close = async (): Promise<void> => {
    await Promise.race([
      electronApp.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (childProcess.exitCode === null && !childProcess.killed) childProcess.kill();
  };
  return {
    electronApp,
    page,
    targetUrl,
    close,
  };
}

function createInvalidLegacyDatabase(userDataDir: string): void {
  const dataDir = path.join(userDataDir, "scraply");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "scraply.db"));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter((item) => item.id <= 3)) {
    if (migration.id === 1) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, "2026-07-01T00:00:00.000Z");
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, "2026-07-01T00:00:00.000Z");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.prepare(`
    INSERT INTO threads (id, title, status, created_at, updated_at)
    VALUES ('thread-legacy', 'Legacy', 'ideas-ready', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO ideas (id, thread_id, title, description, bucket, scores_json, supporting_claim_ids_json, created_at)
    VALUES ('idea-legacy', 'thread-legacy', 'Legacy idea', 'Description', 'strong-fit', '{}', '[]', '2026-07-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO ratings (idea_id, rating, notes, created_at)
    VALUES ('idea-legacy', 6, NULL, '2026-07-01T00:00:00.000Z')
  `).run();
  db.close();
}

async function removeUserDataDir(userDataDir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

test("completes setup, approved research, synthesis, ideas, rating, restart, and a child branch", async () => {
  const mock = await startMockBackend();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  let app: LaunchedApp | null = null;
  try {
    app = await launchIsolatedApp(mock, userDataDir);
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
    await app.page.getByLabel("Exa API key").fill("exa-local-e2e-key");
    await app.page.getByRole("button", { name: "Validate API keys and continue" }).click();

    await expect(app.page.getByRole("button", { name: "Create new research thread" })).toBeVisible();
    expect(existsSync(path.join(userDataDir, "secrets.bin"))).toBe(true);
    await app.page.getByRole("button", { name: "Create new research thread" }).click();
    await expect(app.page.getByRole("heading", { name: "What are you trying to decide, create, or improve?" })).toBeVisible();

    const starterText = "Find an evidence-backed software product a student can ship in six weeks.";
    await app.page.getByLabel("Your brief").fill(starterText);
    await app.page.getByRole("button", { name: "Use guided setup" }).click();
    await expect(app.page.getByRole("heading", { name: "Build the research brief" })).toBeVisible();
    await app.page.getByRole("button", { name: "Back to smart input" }).click();
    await expect(app.page.getByLabel("Your brief")).toHaveValue(starterText);
    await app.page.getByRole("button", { name: "Build research brief" }).click();
    await expect.poll(() => mock.requests.filter((request) => request.path === "/intake/brief").length).toBe(1);
    expect(mock.requests.find((request) => request.path === "/intake/brief")?.body).toEqual({
      threadId: "thread-1",
      text: starterText,
    });

    await expect(app.page.getByRole("heading", { name: "Inspect the inferred brief" })).toBeVisible({ timeout: 15_000 });
    await app.page.getByLabel("Objective").fill("");
    await app.page.getByRole("button", { name: "Confirm brief & review run" }).click();
    await expect(app.page.getByRole("alert")).toBeVisible();
    expect(mock.requests.filter((request) => request.path === "/brief/confirm")).toHaveLength(0);
    await app.page.getByLabel("Objective").fill("Find evidence-backed software ideas a student can ship.");
    await app.page.getByRole("button", { name: "Confirm brief & review run" }).click();

    await expect(app.page.getByRole("heading", { name: "Know what Scraply will execute" })).toBeVisible();
    await expect(app.page.getByText("Fixed for this version")).toBeVisible();
    await expect(app.page.locator("section.streams ol > li")).toHaveCount(6);
    await app.page.getByRole("button", { name: "Edit brief" }).click();
    await expect(app.page.getByRole("heading", { name: "Edit the research brief" })).toBeVisible();
    await app.page.getByLabel("Title").fill("Student Income Lab E2E");
    await app.page.getByRole("button", { name: "Save brief" }).click();
    await expect(app.page.getByRole("heading", { name: "Know what Scraply will execute" })).toBeVisible();
    await expect(app.page.getByRole("heading", { name: "Student Income Lab E2E" })).toBeVisible();
    await expect(app.page.getByLabel("Research approval summary")).toContainText("6 fixed streams");
    await expect(app.page.getByRole("button", { name: "Start research" })).toHaveCount(1);
    await app.page.getByLabel("Parallelism").fill("0");
    await expect(app.page.getByRole("alert")).toBeVisible();
    await expect(app.page.getByRole("button", { name: "Start research" })).toBeDisabled();
    expect(mock.requests.filter((request) => request.path === "/research/start")).toHaveLength(0);
    await app.page.getByLabel("Parallelism").fill("2");
    await app.page.getByRole("button", { name: "Start research" }).click();

    await expect(app.page.getByRole("complementary", { name: "Research progress" })).toBeVisible();
    await expect(app.page.getByLabel("Report: Composite synthesis")).toBeVisible();
    await app.page.getByLabel("Report: Composite synthesis").getByText("Composite synthesis").click();
    await expect(app.page.getByText("Demand is supported by deterministic local evidence.")).toBeVisible();

    await app.close();
    app = await launchIsolatedApp(mock, userDataDir);
    await expect(app.page.getByRole("heading", { name: "Student Income Lab" })).toBeVisible();
    await expect(app.page.getByLabel("Report: Composite synthesis")).toBeVisible();

    await app.page.getByRole("button", { name: "Generate ideas" }).click();
    await expect(app.page.getByRole("heading", { name: "Idea workspace" })).toBeVisible();
    await expect(app.page.getByRole("heading", { name: "Exam Feedback Copilot" })).toBeVisible();
    await app.page.getByRole("button", { name: "Rate 4" }).click();
    await expect.poll(() => mock.requests.filter((request) => request.path === "/ideas/rate").length).toBe(1);
    expect(mock.requests.find((request) => request.path === "/ideas/rate")?.body).toMatchObject({ rating: 4 });
    await expect(app.page.getByText("Saved: 4/5")).toBeVisible();
    await app.page.getByText("Inspect supporting evidence").click();
    await expect(app.page.getByText("Students repeatedly requested actionable feedback.")).toBeVisible();
    expect(mock.requests.some((request) => request.path === "/ideas/idea-1")).toBe(true);

    await app.close();
    app = await launchIsolatedApp(mock, userDataDir);
    await expect(app.page.getByRole("heading", { name: "Exam Feedback Copilot" })).toBeVisible();
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
    await removeUserDataDir(userDataDir);
  }
});

test("surfaces an actionable migration failure during packaged startup", async () => {
  test.skip(process.env.SCRAPLY_E2E_SKIP_REAL_BACKEND === "1", "Requires the deterministic E2E utility backend");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-migration-"));
  createInvalidLegacyDatabase(userDataDir);
  const app = await launchIsolatedApp(null, userDataDir);
  try {
    await expect(app.page.getByRole("alert")).toContainText("Legacy ratings require repair before migration");
    await expect(app.page.getByRole("button", { name: "Open data folder" })).toBeVisible();
    await expect(app.page.getByRole("button", { name: "Open logs folder" })).toBeVisible();
  } finally {
    await app.close();
    await removeUserDataDir(userDataDir);
  }
});

test("does not persist provider keys that fail validation", async () => {
  test.skip(process.env.SCRAPLY_E2E_SKIP_REAL_BACKEND === "1", "Requires the deterministic E2E utility backend");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-invalid-keys-"));
  const app = await launchIsolatedApp(null, userDataDir);
  try {
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
    await app.page.getByLabel("Exa API key").fill("invalid-e2e-key");
    await app.page.getByRole("button", { name: "Validate API keys and continue" }).click();
    await expect(app.page.getByText("Exa · Deterministic invalid Exa key")).toBeVisible();
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
    expect(existsSync(path.join(userDataDir, "secrets.bin"))).toBe(false);
  } finally {
    await app.close();
    await removeUserDataDir(userDataDir);
  }
});

test("persists setup and threads through the real utility backend and SQLite", async () => {
  test.skip(process.env.SCRAPLY_E2E_SKIP_REAL_BACKEND === "1", "Requires the deterministic E2E utility backend");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-real-"));
  let app: LaunchedApp | null = null;
  try {
    app = await launchIsolatedApp(null, userDataDir);
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
    expect(existsSync(path.join(userDataDir, "scraply", "logs", "scraply.log"))).toBe(true);
    await app.page.getByLabel("Exa API key").fill("exa-local-e2e-key");
    await app.page.getByRole("button", { name: "Validate API keys and continue" }).click();

    await expect(app.page.getByRole("button", { name: "Create new research thread" })).toBeVisible();
    expect(existsSync(path.join(userDataDir, "secrets.bin"))).toBe(true);
    expect(existsSync(path.join(userDataDir, "scraply", "scraply.db"))).toBe(true);
    await app.page.getByRole("button", { name: "Create new research thread" }).click();
    await expect(app.page.getByRole("heading", { name: "What are you trying to decide, create, or improve?" })).toBeVisible();

    await app.close();
    app = await launchIsolatedApp(null, userDataDir);
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeHidden();
    await expect(app.page.getByRole("button", { name: "Open thread New research" })).toBeVisible();
  } finally {
    await app?.close();
    await removeUserDataDir(userDataDir);
  }
});

test("keeps partial reports when an interrupted run is cancelled", async () => {
  const mock = await startMockBackend("interrupted");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const app = await launchIsolatedApp(mock, userDataDir);
  try {
    await expect(app.page.getByText("Interrupted research")).toBeVisible();
    await app.page.getByRole("button", { name: "Cancel interrupted research and keep partial reports" }).click();
    await expect(app.page.getByText("Interrupted research")).toBeHidden();
    await expect(app.page.getByLabel("Report: Partial market evidence")).toBeVisible();
    expect(mock.requests.some((request) => request.path === "/research/cancel-incomplete")).toBe(true);
  } finally {
    await app.close();
    await mock.close();
    await removeUserDataDir(userDataDir);
  }
});

test("surfaces a typed provider failure without claiming the run completed", async () => {
  const mock = await startMockBackend("provider-failure");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const app = await launchIsolatedApp(mock, userDataDir);
  try {
    await expect(app.page.getByRole("heading", { name: "Know what Scraply will execute" })).toBeVisible();
    await app.page.getByRole("button", { name: "Start research" }).click();
    await expect(app.page.getByRole("alert")).toContainText("Deterministic provider timeout");
    await expect(app.page.getByRole("button", { name: "Generate ideas" })).toBeHidden();
    expect(mock.requests.filter((request) => request.path === "/research/start")).toHaveLength(1);
  } finally {
    await app.close();
    await mock.close();
    await removeUserDataDir(userDataDir);
  }
});

test("keeps an asynchronous run failure visible after workspace reconciliation", async () => {
  const mock = await startMockBackend("interrupted");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const app = await launchIsolatedApp(mock, userDataDir);
  try {
    await expect(app.page.getByText("Interrupted research")).toBeVisible();
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.webContents.send("scraply:backend-event", {
        type: "run-failed",
        runId: "run-background-failure",
        threadId: "thread-1",
        error: "Background research failed after startup",
      });
    });
    await expect(app.page.getByRole("alert")).toContainText("Background research failed after startup");
    await app.page.waitForTimeout(500);
    await expect(app.page.getByRole("alert")).toContainText("Background research failed after startup");
    expect(mock.requests.filter((request) => request.path === "/workspace").length).toBeGreaterThan(1);
  } finally {
    await app.close();
    await mock.close();
    await removeUserDataDir(userDataDir);
  }
});

test("starts and restarts the packaged production utility backend", async () => {
  test.skip(process.env.SCRAPLY_E2E_SKIP_REAL_BACKEND !== "1", "Runs only against production or installed artifacts");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-production-backend-"));
  let app: LaunchedApp | null = null;
  try {
    app = await launchIsolatedApp(null, userDataDir, { productionBackend: true });
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
    expect(existsSync(path.join(userDataDir, "scraply", "scraply.db"))).toBe(true);
    expect(existsSync(path.join(userDataDir, "scraply", "logs", "scraply.log"))).toBe(true);
    await app.close();

    app = await launchIsolatedApp(null, userDataDir, { productionBackend: true });
    await expect(app.page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible();
  } finally {
    await app?.close();
    await removeUserDataDir(userDataDir);
  }
});

test("blocks remote navigation and new windows in the Electron shell", async () => {
  const mock = await startMockBackend("interrupted");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const app = await launchIsolatedApp(mock, userDataDir);
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
    await removeUserDataDir(userDataDir);
  }
});
