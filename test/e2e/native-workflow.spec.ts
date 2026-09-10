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
test("recovers an expired native session through installed sign-in and restores it after reopen", async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-auth-ui-"));
  let electron: ElectronApplication | undefined;
  let backend = await startFixtureServer(directory, () => undefined, "auth-recovery");
  const launch = async () => {
    const app = await _electron.launch({
      executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? join(process.cwd(), "release/win-unpacked/Scraply.exe"),
      args: [`--user-data-dir=${join(directory, "electron")}`],
      env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: `http://127.0.0.1:${backend.port}`,
        SCRAPLY_E2E_BACKEND_TOKEN: backend.token },
    });
    await app.evaluate(({ shell }) => { shell.openExternal = async () => undefined; });
    return app;
  };
  try {
    electron = await launch();
    let page = await electron.firstWindow();
    await page.getByRole("button", { name: "Create research", exact: true }).click();

    await page.getByLabel("Research name", { exact: true }).fill("Unsaved auth recovery draft");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const accountCard = page.getByLabel("OpenAI account");
    await expect(accountCard.getByText(/OpenAI .*session.*Sign in again\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with OpenAI", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Use device code", exact: true }).click();
    await expect(page.getByText("FIXTURE-CODE", { exact: true })).toBeVisible();
    const cancellationStartedAt = Date.now();
    await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in with OpenAI", exact: true })).toBeEnabled({ timeout: 2_000 });
    expect(Date.now() - cancellationStartedAt).toBeLessThan(2_000);
    await expect(page.getByText("FIXTURE-CODE", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Research name", { exact: true })).toHaveValue("Unsaved auth recovery draft");

    await page.getByRole("button", { name: "Sign in with OpenAI", exact: true }).click();
    await expect(page.getByText("synthetic-account", { exact: true })).toBeVisible();
    await expect(page.getByLabel("OpenAI account")).toContainText("synthetic-account");
    await expect(page.getByLabel("Research name", { exact: true })).toHaveValue("Unsaved auth recovery draft");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("native-auth-recovered.png") });

    const operations = readFileSync(join(directory, "operations.txt"), "utf8").trim().split("\n");
    expect(operations.filter((operation) => operation === "account.refresh")).toHaveLength(1);
    expect(operations).toContain("account.login.cancel");
    expect(operations).toContain("credential.session.persisted");

    await electron.close();
    electron = undefined;
    await backend.close();
    backend = await startFixtureServer(directory, () => undefined, "auth-recovery");
    electron = await launch();
    page = await electron.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText("synthetic-account", { exact: true })).toBeVisible();
    await expect(page.getByLabel("OpenAI account")).toContainText("synthetic-account");
    await expect(page.getByLabel("OpenAI account").getByText(/OpenAI .*session.*Sign in again\./)).toHaveCount(0);
  } finally {
    await electron?.close();
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native v2 research survives the installed selection, risk evaluation, and reopen interaction", async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-native-ui-"));
  const managedPrompt = "Custom instructions from a retired workflow.\n";
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
    await expect(page.getByRole("tabpanel", { name: "Research setup" })).toBeVisible();
    {
      await page.evaluate(async () => {
        const api = (window as unknown as { scraply: ScraplyApi }).scraply;
        const state = await api.getWorkspace();
        await api.saveRunConfig({
          threadId: state.activeThreadId!,
          config: {
            ...state.runConfig!,
            model: { providerId: "legacy-codex-cli", modelId: "gpt-old" },
          },
        });
      });
      await page.reload();
      await expect(page.getByText("This project used the removed CLI integration. Choose an OpenAI model to start a new run.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry connections", exact: true })).toHaveCount(0);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("legacy-model-choice.png") });
      const modelSelect = page.getByRole("combobox", { name: /Model/ });
      await page.getByRole("button", { name: "Choose model", exact: true }).click();
      await expect(modelSelect).toBeFocused();
      await modelSelect.selectOption("openai-subscription:gpt-fixture");
      await expect(page.getByText("This project used the removed CLI integration.", { exact: false })).toHaveCount(0);
    }
    await expect(page.getByRole("combobox", { name: /Research workflow/ })).toHaveCount(0);
    await page.getByLabel("Ideas to generate", { exact: false }).fill("5");
    await page.getByLabel("What should we evaluate risk against?", { exact: false }).fill("Avoid losing a week of repair capacity");
    await expect(page.getByLabel("OpenAI account")).toContainText("synthetic-account");
    await page.getByLabel("Research name", { exact: true }).fill("Native protocol UI fixture");
    await page.getByLabel("What do you want to explore?", { exact: false }).fill("Parts delivery uncertainty for repair shops");
    await page.getByLabel("Research depth", { exact: false }).selectOption("quick");
    await page.getByRole("button", { name: "Discover problems", exact: true }).click();
    await expect(page.getByText("Choose problems to develop", { exact: true })).toBeVisible();
    await expect(page.getByText("overstated", { exact: true })).not.toBeVisible();
    await page.locator(".problem-disclosure > summary").first().click();
    await expect(page.getByText("overstated", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Develop this problem" }).check();
    await page.getByRole("button", { name: "Commit selection", exact: true }).click();
    await expect(page.getByText("Supplier reliability ledger", { exact: true })).toBeVisible();
    {
      await page.getByRole("button", { name: "Supplier reliability ledger", exact: true }).click();
      await page.getByRole("button", { name: "Choose and analyze", exact: true }).first().click();
      await page.getByRole("button", { name: "Supplier reliability ledger", exact: true }).click();
      await expect(page.getByText("Your selected option", { exact: false })).toBeVisible();
      await expect(page.getByText("Next experiment", { exact: true })).toBeVisible();
      await page.getByLabel("Question", { exact: true }).fill("Which suppliers publish arrival histories?");
      await page.getByRole("button", { name: "Check evidence", exact: true }).click();
      const followUp = page.getByRole("region", { name: "Evidence follow-up result" });
      await expect(followUp.getByText("This option has used its one evidence follow-up.", { exact: true })).toBeVisible();
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("native-follow-up.png") });
      await expect(followUp.locator("blockquote").filter({ hasText: "Parts delivery windows are uncertain." })).toHaveCount(2);
      await expect(followUp.getByRole("link", { name: "Synthetic delivery report 0" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Check evidence", exact: true })).toHaveCount(0);
      await page.getByLabel("Your decision", { exact: true }).fill("Pilot with one supplier");
      await page.getByLabel("Observed test result", { exact: true }).fill("Nine of ten estimates matched arrivals");
      // Filtering changes visibility without unmounting an open idea or discarding its draft.
      await page.getByRole("textbox", { name: "Search ideas" }).fill("no matching idea");
      await expect(page.getByLabel("Your decision", { exact: true })).not.toBeVisible();
      await page.getByRole("button", { name: "Clear filter" }).click();
      await expect(page.getByLabel("Your decision", { exact: true })).toHaveValue("Pilot with one supplier");
      await expect(page.getByLabel("Observed test result", { exact: true })).toHaveValue("Nine of ten estimates matched arrivals");
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
    }
    await expect(page.getByText("Observed order volume stays too sparse", { exact: true }).first()).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("native-solutions.png") });
    await events;
    expect(eventErrors).toEqual([]);
    await electron.close();
    electron = undefined;
    await backend.close();
    backend = await startFixtureServer(directory, () => undefined);
    electron = await launch();
    page = await electron.firstWindow();
    await expect(page.getByText("Supplier reliability ledger", { exact: true })).toBeVisible();
    {
      const savedModel = await page.evaluate(async () => (await (window as unknown as { scraply: ScraplyApi }).scraply.getWorkspace()).runConfig?.model);
      expect(savedModel).toEqual({ providerId: "openai-subscription", modelId: "gpt-fixture" });
    }
    {
      await page.getByRole("button", { name: "Supplier reliability ledger", exact: true }).click();
      await expect(page.getByLabel("Observed test result", { exact: true })).toHaveValue("Nine of ten estimates matched arrivals");
      const reopenedFollowUp = page.getByRole("region", { name: "Evidence follow-up result" });
      await expect(reopenedFollowUp).toContainText("Which suppliers publish arrival histories?");
      await expect(reopenedFollowUp.getByRole("link", { name: "Synthetic delivery report 1" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Check evidence", exact: true })).toHaveCount(0);
    }
    await page.getByRole("tab", { name: /Research/ }).click();
    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await page.locator(".problem-disclosure > summary").first().click();
    await page.getByText("2 cited factors", { exact: true }).click();
    await expect(page.getByText("Parts delivery windows are uncertain.", { exact: true }).first()).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("native-reopened-evidence.png") });
    expect(readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n")).toHaveLength(9);
    expect(existsSync(join(directory, "prompts", "solutions.md"))).toBe(false);
    expect(readFileSync(join(directory, "prompts", "retired-prompt-backups", managedHash, "solutions.md"), "utf8")).toBe(managedPrompt);
  } finally {
    await events;
    await electron?.close();
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function startFixtureServer(directory: string, onEvent: (event: ResearchEvent) => void, scenario?: "auth-recovery") {
  const child = spawn("bun", [join(process.cwd(), "test/fixtures/native-workflow-server.ts"), directory, ...(scenario ? [scenario] : [])], {
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
