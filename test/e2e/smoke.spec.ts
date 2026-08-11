import { expect, test, _electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockBackend } from "./mock-backend";

test("new graph workflow reaches solutions", async () => {
  const mock = await startMockBackend();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const executablePath = process.env.SCRAPLY_E2E_EXECUTABLE ?? path.join(process.cwd(), "release", "win-unpacked", "Scraply.exe");
  const electron = await _electron.launch({ executablePath, args: [`--user-data-dir=${userDataDir}`], env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  try {
    const page = await electron.firstWindow();
    await page.getByRole("button", { name: "Create research" }).click();
    await page.getByLabel("Working title").fill("Repair delays");
    await page.getByLabel("Audience").fill("Independent repair shops");
    await page.getByLabel("Domain").fill("Parts sourcing");
    await page.getByRole("button", { name: "Save scope" }).click();
    await page.getByRole("button", { name: "Start discovery" }).click();
    await expect(page.getByText("Which problems deserve development?")).toBeVisible();
    await page.getByRole("checkbox", { name: "Develop this problem" }).check();
    await page.getByRole("button", { name: "Commit selection" }).click();
    await expect(page.getByText("Supplier reliability ledger")).toBeVisible();
    await expect(page.getByText("Risk never decides viability for you.")).toBeVisible();
  } finally {
    await electron.close(); await mock.close(); rmSync(userDataDir, { recursive: true, force: true });
  }
});
