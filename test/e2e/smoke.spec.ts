import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockBackend } from "./mock-backend";

// The backend here is the in-process mock, so this covers renderer rehydration only — checkpoint
// persistence itself is covered by the research-engine resume tests.
test("the renderer restores the problem-selection step after a restart", async () => {
  const mock = await startMockBackend();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const executablePath = process.env.SCRAPLY_E2E_EXECUTABLE ?? path.join(process.cwd(), "release", "win-unpacked", "Scraply.exe");
  const launch = (): Promise<ElectronApplication> => _electron.launch({ executablePath, args: [`--user-data-dir=${userDataDir}`], env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  let electron: ElectronApplication | undefined = await launch();
  try {
    let page = await electron.firstWindow();
    await page.getByRole("button", { name: "Create research" }).click();
    await page.getByLabel("Research name").fill("Repair delays");
    // Discovery must start from the context alone: the audience field is optional and is left blank here
    // on purpose, so reinstating an audience requirement fails this test instead of shipping.
    await page.getByLabel("What do you want to explore?").fill("Parts sourcing");
    await page.getByRole("button", { name: "Discover problems" }).click();
    await expect(page.getByText("Which problems deserve development?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export research JSON" })).toBeVisible();

    await electron.close();
    electron = undefined;
    electron = await launch();
    page = await electron.firstWindow();
    await expect(page.getByText("Which problems deserve development?")).toBeVisible();

    await page.getByRole("checkbox", { name: "Develop this problem" }).check();
    await page.getByRole("button", { name: "Commit selection" }).click();
    await expect(page.getByText("Supplier reliability ledger")).toBeVisible();
    await expect(page.getByText("Scan the list first. Expand only the idea and evidence you want to inspect.")).toBeVisible();
    await page.getByRole("tab", { name: /Research/ }).click();
    await expect(page.getByText("The evidence behind the ideas.")).toBeVisible();
    // Cited factors stay collapsed so the archive can be scanned; the evidence must survive one expand.
    await page.getByText("1 cited factors", { exact: true }).click();
    await expect(page.getByText("Backorders add days to routine repairs.")).toBeVisible();
    await page.getByRole("tab", { name: /Setup/ }).click();
    await expect(page.getByText("Where this work started.")).toBeVisible();
    await page.getByRole("tab", { name: /Ideas/ }).click();
    await expect(page.getByText("Supplier reliability ledger")).toBeVisible();
  } finally {
    await electron?.close(); await mock.close(); rmSync(userDataDir, { recursive: true, force: true });
  }
});
