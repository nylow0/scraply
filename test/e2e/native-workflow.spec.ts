import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { IPC_CHANNELS, BackendReadySchema, ResearchEventSchema, type ResearchEvent } from "../../src/shared/ipc";
import type { ScraplyApi } from "../../src/preload/index";

// Installed renderer/preload/main with the production backend loaded from source. Only the native
// child and Exa HTTP responses are fixtures. Live bundled-runtime parity is a separate gate.
for (const workflowVersion of [1, 2]) test(`native v${workflowVersion} research survives the installed selection, development, and reopen interaction`, async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-ui-"));
  const managedPrompt = readFileSync(join(process.cwd(), "prompts", "solutions.md"), "utf8");
  const managedHash = createHash("sha256").update(managedPrompt).digest("hex");
  mkdirSync(join(directory, "prompts"));
  writeFileSync(join(directory, "prompts", "solutions.md"), managedPrompt);
  let electron: ElectronApplication | undefined;
  let events = Promise.resolve();
  const eventErrors: unknown[] = [];
  let backend = await startFixtureServer(directory, (event) => {
    const app = electron;
    if (!app) return;
    events = events.then(async () => {
      await app.evaluate(({ BrowserWindow }, message) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(message.channel, message.event);
      }, { channel: IPC_CHANNELS.BACKEND_EVENT, event });
    }).catch((error: unknown) => { eventErrors.push(error); });
  });
  const launch = () => _electron.launch({
    executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
    args: [`--user-data-dir=${join(directory, "electron")}`],
    env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: `http://127.0.0.1:${backend.port}`,
      SCRAPLY_E2E_BACKEND_TOKEN: backend.token },
  });
  try {
    electron = await launch();
    let page = await electron.firstWindow();
    await page.getByRole("button", { name: "Create research", exact: true }).click();
    await page.getByRole("combobox", { name: /Research workflow/ }).selectOption(String(workflowVersion));
    await expect(page.getByRole("option", { name: /Native OpenAI/ })).toHaveCount(1);
    await page.getByLabel("Research name", { exact: true }).fill("Native protocol UI fixture");
    await page.getByLabel("What do you want to explore?", { exact: false }).fill("Parts delivery uncertainty for repair shops");
    await page.getByLabel("Research depth", { exact: false }).selectOption("quick");
    await page.getByRole("button", { name: "Discover problems", exact: true }).click();
    await expect(page.getByText("Which problems deserve development?", { exact: true })).toBeVisible();
    await expect(page.getByText("overstated", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Develop this problem" }).check();
    await page.getByRole("button", { name: "Commit selection", exact: true }).click();
    await expect(page.getByText("Supplier reliability ledger", { exact: true })).toBeVisible();
    if (workflowVersion === 2) {
      await page.getByRole("button", { name: "Choose and analyze", exact: true }).first().click();
      await expect(page.getByText("Your selected option", { exact: false })).toBeVisible();
      await page.getByText("Evidence, analysis and your decision", { exact: true }).click();
      await expect(page.getByText("Next experiment", { exact: true })).toBeVisible();
      await page.getByLabel("Question", { exact: true }).fill("Which suppliers publish arrival histories?");
      await page.getByRole("button", { name: "Check evidence", exact: true }).click();
      const followUp = page.getByRole("region", { name: "Evidence follow-up result" });
      await expect(followUp.getByText("This option has used its one evidence follow-up.", { exact: true })).toBeVisible();
      await expect(followUp.getByText("Parts delivery windows are uncertain.", { exact: true })).toHaveCount(2);
      await expect(followUp.getByRole("link", { name: "Synthetic delivery report 0" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Check evidence", exact: true })).toHaveCount(0);
      await page.getByLabel("Your decision", { exact: true }).fill("Pilot with one supplier");
      await page.getByLabel("Observed test result", { exact: true }).fill("Nine of ten estimates matched arrivals");
      await page.getByRole("button", { name: "Save decision and result", exact: true }).click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      const progressTarget = await page.evaluate(async () => {
        performance.clearMeasures("scraply-progress-visible");
        const state = await (window as unknown as { scraply: ScraplyApi }).scraply.getWorkspace();
        return { threadId: state.activeThreadId!, runId: state.latestResearchRun!.runId };
      });
      await electron.evaluate(async ({ BrowserWindow }, target) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        for (let index = 0; index < 35; index += 1) {
          contents.send("scraply:backend-event", {
            type: "run-progress", threadId: target.threadId, runId: target.runId,
            message: `Deterministic renderer progress ${index}`, codexCalls: index, searches: index,
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }, progressTarget);
      await page.waitForFunction(() => performance.getEntriesByName("scraply-progress-visible").length >= 30);
      await expect(page.locator(".calls strong").first()).toHaveText("34");
      await expect(page.locator(".calls strong").nth(1)).toHaveText("34");
      const samplesMs = await page.evaluate(() => performance.getEntriesByName("scraply-progress-visible").map((entry) => entry.duration));
      expect(samplesMs).toHaveLength(35);
      writeFileSync(testInfo.outputPath("progress-samples.json"), JSON.stringify({ samplesMs }, null, 2));
    } else {
    await page.getByText("Supplier reliability ledger", { exact: true }).click();
    const solution = page.locator("details.solution").filter({ has: page.getByText("Supplier reliability ledger", { exact: true }) });
    await solution.getByText("Review all risks and responses", { exact: true }).click();
    await expect(solution.getByText("Observed order volume stays too sparse", { exact: true }).first()).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath("native-solutions.png") });
    await events;
    expect(eventErrors).toEqual([]);
    await electron.close();
    electron = undefined;
    await backend.close();
    backend = await startFixtureServer(directory, () => undefined);
    electron = await launch();
    page = await electron.firstWindow();
    await expect(page.getByText("Supplier reliability ledger", { exact: true })).toBeVisible();
    if (workflowVersion === 2) {
      await page.getByText("Evidence, analysis and your decision", { exact: true }).click();
      await expect(page.getByLabel("Observed test result", { exact: true })).toHaveValue("Nine of ten estimates matched arrivals");
      const reopenedFollowUp = page.getByRole("region", { name: "Evidence follow-up result" });
      await expect(reopenedFollowUp.getByText("Which suppliers publish arrival histories?", { exact: true })).toBeVisible();
      await expect(reopenedFollowUp.getByRole("link", { name: "Synthetic delivery report 1" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Check evidence", exact: true })).toHaveCount(0);
    }
    await page.getByRole("tab", { name: /Research/ }).click();
    await expect(page.getByText("The evidence behind the ideas.", { exact: true })).toBeVisible();
    await page.getByText(`${workflowVersion === 1 ? 4 : 2} cited factors`, { exact: true }).click();
    await expect(page.getByText("Parts delivery windows are uncertain.", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("native-reopened-evidence.png") });
    expect(readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n")).toHaveLength(workflowVersion === 1 ? 20 : 8);
    expect(existsSync(join(directory, "prompts", "solutions.md"))).toBe(false);
    expect(readFileSync(join(directory, "prompts", "bundled-copy-backups", managedHash, "solutions.md"), "utf8")).toBe(managedPrompt);
  } finally {
    await events;
    await electron?.close();
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function startFixtureServer(directory: string, onEvent: (event: ResearchEvent) => void) {
  const child = spawn("bun", [join(process.cwd(), "test/fixtures/native-workflow-server.ts"), directory], {
    stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Native workflow server exited: ${code}`)));
  });
  void exited.catch(() => undefined);
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Native workflow server did not start within ten seconds")); }, 10_000);
      void exited.then(() => { clearTimeout(timer); reject(new Error("Native workflow server ended before readiness")); }, (error: unknown) => { clearTimeout(timer); reject(error); });
      lines.on("line", (line) => {
        const value: unknown = JSON.parse(line);
        const started = BackendReadySchema.safeParse(value);
        if (started.success) { clearTimeout(timer); resolve(started.data); return; }
        if (typeof value === "object" && value !== null && "event" in value) {
          onEvent(ResearchEventSchema.parse(value.event));
        }
      });
    });
    let closed = false;
    return { ...ready, async close() {
      if (closed) return;
      closed = true;
      const timeout = setTimeout(() => child.kill(), 5_000);
      child.stdin.end("close\n");
      try { await exited; } finally { clearTimeout(timeout); lines.close(); }
    } };
  } catch (error) {
    child.kill();
    lines.close();
    throw error;
  }
}
