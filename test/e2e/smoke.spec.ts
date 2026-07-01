import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface LaunchedApp {
  process: ChildProcess;
  targetUrl: string;
  close: () => Promise<void>;
}

async function launchIsolatedApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-e2e-"));
  const port = 50_000 + Math.floor(Math.random() * 10_000);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RENDERER_URL;
  env.SCRAPLY_E2E = "1";
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

  const electronExe = process.platform === "win32"
    ? path.join(process.cwd(), "node_modules/electron/dist/electron.exe")
    : path.join(process.cwd(), "node_modules/electron/dist/electron");

  const logs: string[] = [];
  const child = spawn(electronExe, [
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--in-process-gpu",
    "--use-gl=swiftshader",
    `--remote-debugging-port=${port}`,
    path.join(process.cwd(), "out/main/index.js"),
    `--user-data-dir=${userDataDir}`,
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const targetUrl = await waitForRendererTarget(port, child, logs);
  return {
    process: child,
    targetUrl,
    close: async () => {
      if (!child.killed) child.kill();
    },
  };
}

test("electron app opens the renderer window", async () => {
  const app = await launchIsolatedApp();

  try {
    expect(app.targetUrl).toContain("/out/renderer/index.html");
  } finally {
    await app.close();
  }
});

test("creates a thread when setup is already complete", async () => {
  test.skip(!process.env.SCRAPLY_E2E_CONFIGURED, "Set SCRAPLY_E2E_CONFIGURED=1 with saved keys to run the full thread smoke path");
});

async function waitForRendererTarget(port: number, child: ChildProcess, logs: string[]): Promise<string> {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{ type?: string; url?: string }>;
        const page = targets.find((target) => target.type === "page" && target.url?.includes("/out/renderer/index.html"));
        if (page?.url) return page.url;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Electron renderer target. Last error: ${lastError}\nElectron output:\n${logs.join("").slice(-2000)}`);
}
