import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import {
  SaveRunConfigSchema,
  SaveScopeSchema,
  type WorkspaceState,
} from "../../src/shared/ipc";
import {
  CommandWorkflowRequestSchema,
  PreviewWorkflowRequestSchema,
  StartWorkflowRequestSchema,
  type WorkflowLaunchContract,
  type WorkflowSummary,
} from "../../src/shared/workflow-contracts";
import { createInstalledApp } from "./installed-app";

// The fixture keeps the backend deterministic while the installed renderer, preload, and main
// process exercise the same request and response schemas as a live workflow.
for (const mode of ["babysit", "vibe"] as const) {
test(`installed ${mode} workflow previews, runs, pauses, finishes, and reopens through the desktop bridge`, async ({}, testInfo) => {
  const threadId = `synthetic-${mode}`;
  const sessionId = `session-${mode}`;
  const now = "2026-09-23T00:00:00.000Z";
  const topic = "Independent bicycle repair shops";
  const projectTitle = "Bicycle repair approvals";
  const requests: Array<{ path: string; payload: unknown }> = [];
  let summary: WorkflowSummary | undefined;
  let savedScope: WorkspaceState["scope"] = null;
  let savedConfig: WorkspaceState["runConfig"] = DEFAULT_RUN_CONFIG;
  const model = {
    ...DEFAULT_RUN_CONFIG.model,
    displayName: "Synthetic model",
    defaultReasoningEffort: "medium" as const,
    reasoningEfforts: [{ id: "medium" as const, description: "Balanced" }],
  };
  const workspace = (): WorkspaceState => ({
    validation: {
      exa: { valid: true }, perplexity: { valid: false },
      native: { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] },
      setupComplete: true,
    },
    threads: [{ id: threadId, title: projectTitle,
      status: summary?.state === "finished" ? mode === "vibe" ? "solutions-ready" : "failed"
        : summary ? "discovery-running" : "configuring",
      createdAt: now, updatedAt: now }],
    activeThreadId: threadId,
    messages: [], scope: savedScope, runConfig: savedConfig,
    models: [DEFAULT_RUN_CONFIG.model], modelOptions: [model],
    modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] }, presets: [],
    problemCandidates: [], rejectedProblemCandidates: [], researchRequests: [], researchFindings: [],
    solutions: summary?.state === "finished" && mode === "vibe" ? [{
      id: "synthetic-idea", problemId: "synthetic-problem",
      problemStatement: "Repair shops lose track of pending customer approvals",
      problemVerdict: "confirmed", factors: [],
      workflowVersion: 2,
      mechanism: "Approval status board",
      description: "Track repair quote approvals in one shared view.",
      respectsOffLimits: true, respectsOffLimitsWhy: "Uses the existing shop workflow.",
      keyAssumption: "Technicians need a shared status more than another messaging tool.",
      whyCurrentApproachMaySuffice: "A smaller shop may manage approvals through its existing inbox.",
      unknowns: ["Whether customers respond faster when status is visible."],
      outcomes: [], risks: [], confirmedCoreOutcomes: 1, unaddressedCatastrophicRisks: 0,
    }] : [],
    latestResearchRun: null, pendingRuns: [],
    ...(summary ? { activeWorkflow: summary } : {}),
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const payload: unknown = body ? JSON.parse(body) : null;
    requests.push({ path, payload });

    let data: unknown = workspace();
    if (path === "/validation") data = workspace().validation;
    else if (path === "/scope") {
      const input = SaveScopeSchema.parse(payload);
      expect(input.threadId).toBe(threadId);
      savedScope = input.scope;
      data = workspace();
    } else if (path === "/run-config") {
      const input = SaveRunConfigSchema.parse(payload);
      expect(input.threadId).toBe(threadId);
      savedConfig = input.config;
      data = workspace();
    } else if (path === "/workflows/preview") {
      const input = PreviewWorkflowRequestSchema.parse(payload);
      expect(input.type).toBe("launch");
      if (input.type !== "launch") throw new Error("Expected a launch preview.");
      expect(input.threadId).toBe(threadId);
      expect(input.draft.mode).toBe(mode);
      expect(input.draft.brief).toBe(topic);
      const proposal: WorkflowLaunchContract = {
        ...input.draft,
        resolvedInstructions: { research: "Synthetic research instructions", ideas: "Synthetic ideas instructions", review: "Synthetic review instructions" },
        instructionHashes: { research: "research-hash", ideas: "ideas-hash", review: "review-hash" },
      };
      data = {
        type: "launch", proposal, previewHash: `preview-${mode}`,
        capabilityFingerprint: "synthetic-capabilities", minimumWork: { modelCalls: 1, searches: 1 },
        upperLimits: proposal.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z",
      };
    } else if (path === "/workflows/start") {
      const input = StartWorkflowRequestSchema.parse(payload);
      expect(input.threadId).toBe(threadId);
      expect(input.contract.mode).toBe(mode);
      expect(input.contract.brief).toBe(topic);
      expect(input.previewHash).toBe(`preview-${mode}`);
      expect(input.capabilityFingerprint).toBe("synthetic-capabilities");
      const startedSummary: WorkflowSummary = {
        sessionId, threadId, purpose: "discovery", mode, targetKind: "per-problem",
        state: "running", outcome: null, revision: 1, activeSnapshotId: null, selectedProblemIds: [],
        counts: { requested: input.contract.targets.ideaCount, attempted: 0, validated: 0, accepted: 0,
          duplicate: 0, unresolved: 0, failed: 0, missing: input.contract.targets.ideaCount,
          existing: 0, addedBySession: 0, total: 0 },
        limits: input.contract.limits,
        budget: {
          modelCalls: { limit: input.contract.limits.maxModelCalls, spent: 0, reserved: 0, uncertain: 0 },
          searches: { limit: input.contract.limits.maxSearches, spent: 0, reserved: 0, uncertain: 0 },
          remainingMs: input.contract.limits.maxMinutes * 60_000,
        },
        currentStage: "Checking buyer evidence for repair approvals", stopReason: null, startedAt: now, finishedAt: null,
      };
      summary = startedSummary;
      data = { sessionId, revision: startedSummary.revision, summary: startedSummary };
    } else if (path === `/workflows/${sessionId}`) {
      if (!summary) throw new Error("Workflow detail requested before launch.");
      const completed = summary.state === "finished";
      data = { summary, tasks: [
        { id: `task-${mode}-research`, parentItemId: null, kind: "buyer-research", scopeKey: "discovery",
          state: completed ? "succeeded" : summary.state === "paused" ? "ready" : "running",
          question: "Check repair approval bottlenecks", createdAt: now, finishedAt: completed ? now : null },
        ...(mode === "vibe" ? [{ id: "task-vibe-review", parentItemId: null, kind: "idea-review", scopeKey: "development",
          state: completed ? "succeeded" : "planned", question: "Review the approval status board",
          createdAt: now, finishedAt: completed ? now : null }] : []),
      ], nextCursor: null };
    } else if (path === "/ideas/synthetic-idea") {
      data = workspace().solutions[0];
    } else if (path === "/workflows/command") {
      const input = CommandWorkflowRequestSchema.parse(payload);
      expect(input).toMatchObject({ threadId, sessionId });
      if (!summary) throw new Error("Command requested before launch.");
      if (input.action.type === "pause") {
        expect(input.expectedRevision).toBe(1);
        summary = { ...summary, state: "paused", revision: 2, currentStage: "Paused after buyer evidence checkpoint" };
      } else if (input.action.type === "resume") {
        expect(input.expectedRevision).toBe(2);
        summary = {
          ...summary, state: "finished", revision: 3,
          outcome: mode === "vibe" ? "target-met" : "no-qualifying-ideas",
          counts: mode === "vibe" ? { ...summary.counts, attempted: 1, validated: 1, accepted: 1,
            missing: 0, total: 1, addedBySession: 1 } : summary.counts,
          budget: {
            modelCalls: { ...summary.budget.modelCalls, spent: mode === "vibe" ? 4 : 2 },
            searches: { ...summary.budget.searches, spent: 2 },
            remainingMs: Math.max(0, summary.budget.remainingMs - 6 * 60_000),
          },
          currentStage: null,
          stopReason: mode === "vibe"
            ? "The approval status board passed review and was saved."
            : "The research found no qualifying buyer problem.",
          finishedAt: now,
        };
      } else throw new Error(`Unexpected workflow command: ${input.action.type}`);
      data = { sessionId, revision: summary.revision, summary };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workflow fixture has no listening port.");
  const app = createInstalledApp({ directoryPrefix: `scraply-${mode}-workflow-bridge-` });
  try {
    const electron = await app.launch({
      ...process.env, SCRAPLY_E2E: "1",
      SCRAPLY_E2E_BACKEND_URL: `http://127.0.0.1:${address.port}`,
      SCRAPLY_E2E_BACKEND_TOKEN: "synthetic-workflow-fixture",
    });
    const page = await electron.firstWindow();
    await expect(page.getByRole("tabpanel", { name: "Research setup" })).toBeVisible();
    await page.getByText(mode === "vibe" ? "Vibe" : "Babysit", { exact: true }).click();
    await page.getByPlaceholder("Your topic or idea").fill(topic);
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(page.getByRole("button", { name: mode === "vibe" ? "Start Vibe" : "Start Babysit" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`${mode}-setup.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Research settings", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Solutions per problem" }).fill("1");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const launch = page.getByRole("button", { name: mode === "vibe" ? "Start Vibe" : "Start Babysit" });
    await expect(launch).toBeEnabled();
    await launch.click();

    const progress = page.getByLabel(mode === "vibe" ? "Vibe run progress" : "Babysit run progress");
    await expect(progress).toBeVisible();
    await expect(progress.getByText("Checking buyer evidence for repair approvals")).toBeVisible();
    await expect(progress.getByRole("button", { name: "Pause" })).toBeVisible();
    await progress.getByRole("button", { name: "Pause" }).click();
    await expect(progress.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(progress.getByText("Paused after buyer evidence checkpoint")).toBeVisible();
    await progress.getByRole("button", { name: "Resume" }).click();
    await expect(progress).toContainText(mode === "vibe" ? "Target reached" : "No qualifying ideas");
    await expect(progress).toContainText(mode === "vibe"
      ? "The approval status board passed review and was saved."
      : "The research found no qualifying buyer problem.");

    // Reopen the installed app using the same profile and saved fixture state.
    await app.close();
    const reopened = await app.launch({
      ...process.env, SCRAPLY_E2E: "1",
      SCRAPLY_E2E_BACKEND_URL: `http://127.0.0.1:${address.port}`,
      SCRAPLY_E2E_BACKEND_TOKEN: "synthetic-workflow-fixture",
    });
    const reopenedPage = await reopened.firstWindow();
    const restoredProgress = reopenedPage.getByLabel(mode === "vibe" ? "Vibe run progress" : "Babysit run progress");
    await expect(restoredProgress).toBeVisible();
    await expect(restoredProgress).toContainText(mode === "vibe" ? "Target reached" : "No qualifying ideas");
    if (mode === "vibe") {
      await expect(reopenedPage.getByRole("tabpanel", { name: "Solutions" })).toBeVisible();
      await expect(reopenedPage.getByRole("button", { name: "Track repair quote approvals in one shared view.", exact: true })).toBeVisible();
      await reopenedPage.setViewportSize({ width: 1600, height: 1200 });
      await reopenedPage.screenshot({ path: testInfo.outputPath(`${mode}-workflow-finished.png`), animations: "disabled", fullPage: true });
      const savedIdea = reopenedPage.getByRole("button", { name: "Track repair quote approvals in one shared view.", exact: true });
      await savedIdea.scrollIntoViewIfNeeded();
      await reopenedPage.screenshot({ path: testInfo.outputPath("vibe-saved-idea.png"), animations: "disabled" });
      await savedIdea.click();
      await expect(reopenedPage.getByText("Approval status board", { exact: true })).toBeVisible();
      await expect(reopenedPage.getByText("Problem and fit")).toBeVisible();
    } else await reopenedPage.screenshot({ path: testInfo.outputPath(`${mode}-workflow-finished.png`), animations: "disabled" });

    expect(requests.filter(({ path }) => path === "/workflows/preview").length).toBeGreaterThan(0);
    expect(requests.filter(({ path }) => path === "/workflows/start")).toHaveLength(1);
    expect(requests.filter(({ path }) => path === "/workflows/command")).toHaveLength(2);
    expect(requests.some(({ path }) => path === `/workflows/${sessionId}`)).toBe(true);
  } finally {
    await app.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
}
