import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function launchIsolatedApp() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  env.SCRAPLY_E2E = "1";
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  return electron.launch({
    args: [
      path.join(process.cwd(), "out/main/index.js"),
      `--user-data-dir=${userDataDir}`,
    ],
    env,
  });
}

test("electron app shows setup screen on launch", async () => {
  const app = await launchIsolatedApp();

  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Starting Scraply…")).toBeHidden({ timeout: 30000 });
    await expect(page.getByRole("heading", { name: "Connect Scraply" })).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test("creates a thread when setup is already complete", async () => {
  test.skip(!process.env.SCRAPLY_E2E_CONFIGURED, "Set SCRAPLY_E2E_CONFIGURED=1 with saved keys to run the full thread smoke path");

  const app = await launchIsolatedApp();

  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Starting Scraply…")).toBeHidden({ timeout: 30000 });
    await page.getByRole("button", { name: "Create new research thread" }).click();
    await expect(
      page.getByText("Start a research thread").or(page.getByText(/trying to generate ideas/i)),
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});
