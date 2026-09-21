import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInstalledApp } from "./installed-app";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import type { WorkspaceState } from "../../src/shared/ipc";

// The installed renderer, preload, and main process use their real request bridge. The API
// persistence contract is covered separately by opportunity-api.test.ts with a real database.
test("installed business review passes through the desktop bridge and renders the accepted family", async ({}, testInfo) => {
  const now = new Date().toISOString();
  let reviewed = false;
  const requests: string[] = [];
  const model = { ...DEFAULT_RUN_CONFIG.model, displayName: "GPT-5.6 Sol", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Balanced" }] };
  const state = (): WorkspaceState => ({
    validation: { exa: { valid: true }, perplexity: { valid: false }, native: { available: true, connected: true, accounts: [{ providerId: "openai-subscription" }] }, setupComplete: true },
    threads: [{ id: "desktop-project", title: "Desktop family review", status: "solutions-ready", createdAt: now, updatedAt: now }],
    activeThreadId: "desktop-project", messages: [], scope: null, runConfig: DEFAULT_RUN_CONFIG,
    models: [DEFAULT_RUN_CONFIG.model], modelOptions: [model], modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] }, presets: [],
    problemCandidates: [], rejectedProblemCandidates: [], latestResearchRun: null, pendingRuns: [],
    solutions: [{ id: "option-1", problemId: "problem-1", problemStatement: "Repair approvals are delayed", problemVerdict: "insufficient-evidence", factors: [], mechanism: "Repair approval workflow", description: "Record the approval of a revised quote.", respectsOffLimits: true, respectsOffLimitsWhy: "Within scope", outcomes: [], risks: [], confirmedCoreOutcomes: 0, unaddressedCatastrophicRisks: 0 }],
    opportunityFamilies: {
      rawOptionCount: 1, reviewedOptionCount: reviewed ? 1 : 0, acceptedFamilyCount: reviewed ? 1 : 0,
      families: reviewed ? [{ id: "family-1", title: "Quote approvals", summary: "One distinct purchase", representativeOptionId: "option-1", active: true, createdAt: now, counted: true, members: [{ decisionId: "decision-1", optionId: "option-1", familyId: "family-1", relationship: "separate-business", state: "accepted", reason: "Separate purchase for quote approval", decidedBy: "model", decidedAt: now, mechanism: "Repair approval workflow", description: "Record approval", eligibleStartup: true, discarded: false }] }] : [],
      unresolved: [], unreviewedOptionIds: reviewed ? [] : ["option-1"], lastReviewedAt: reviewed ? now : null, reviewStatus: reviewed ? "completed" : "not-reviewed", reviewError: null,
    },
  });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(path);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (path === "/opportunities/review") {
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
      expect(payload).toMatchObject({ threadId: "desktop-project", model: DEFAULT_RUN_CONFIG.model, reasoningEffort: "medium", allowAmbiguousRetry: false });
      reviewed = true;
    }
    const data = path === "/validation" ? state().validation : state();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Desktop fixture has no listening port.");
  const app = createInstalledApp({ directoryPrefix: "scraply-opportunity-desktop-" });
  try {
    const electron = await app.launch({ ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: `http://127.0.0.1:${address.port}`, SCRAPLY_E2E_BACKEND_TOKEN: "opportunity-desktop-fixture" });
    const page = await electron.firstWindow();
    await page.getByRole("button", { name: "Review 1 saved idea", exact: true }).click();
    await expect(page.getByText("Quote approvals", { exact: true })).toBeVisible();
    expect(requests).toContain("/opportunities/review");
    await page.screenshot({ path: testInfo.outputPath("opportunity-desktop-review.png"), animations: "disabled" });
  } finally {
    await app.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
