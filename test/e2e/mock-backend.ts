import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { PreviewWorkflowRequestSchema, StartWorkflowRequestSchema, type WorkflowSummary } from "../../src/shared/workflow-contracts";

export interface MockBackend {
  url: string; token: string; requests: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}

const now = "2026-08-10T12:00:00.000Z";
const validation = {
  exa: { valid: true }, perplexity: { valid: false, error: "Perplexity key missing" },
  native: { available: true, connected: true, version: "0.2.0-e2e", accounts: [{ providerId: "openai-subscription" }] },
  setupComplete: true,
};
const factor = { id: "factor-1", subject: "Small repair shops", behavior: "wait for backordered parts", quote: "Backorders add days to routine repairs.", sourceId: "source-1", sourceTitle: "Repair trade survey", sourceUrl: "https://example.com/repair", harvestMode: "domain", modelConfidence: 0.8 };
const problem = { id: "problem-1", statement: "Small repair shops cannot reliably predict parts arrival times.", whyItPersists: "Supplier data remains fragmented.", affected: "Independent repair shops", scaleEstimate: "Thousands of shops", verdict: "confirmed", verdictReason: "Multiple sources describe recurring delays.", selected: false, factors: [factor], singleHarvestModeWarning: true, developmentCompleted: false };
const rejectedProblem = { id: "rejected-1", statement: "Repair shops cannot compare every supplier on one marketplace.", reason: "The candidate cited factors from only one source hostname." };
const solution = { id: "solution-1", problemId: "problem-1", problemStatement: problem.statement, problemVerdict: "confirmed", factors: [factor], mechanism: "Supplier reliability ledger", description: "Pool observed delivery windows by supplier and part category.", respectsOffLimits: true, respectsOffLimitsWhy: "Does not hold inventory.", outcomes: [{ id: "outcome-1", description: "Shops quote narrower delivery windows.", direction: "positive", affects: "Scheduling", addressesCore: true }, { id: "outcome-2", description: "Sparse suppliers remain hard to estimate.", direction: "negative", affects: "Coverage", addressesCore: false }], risks: [{ id: "risk-2", description: "The only data supplier can leave the market.", likelihood: "likely", impact: "project ends", sortKey: 9, mitigations: [] }, { id: "risk-1", description: "Suppliers change behavior faster than the ledger updates.", likelihood: "possible", impact: "~2 weeks", sortKey: 4, mitigations: [{ id: "mitigation-1", approach: "Decay old observations", cost: "One maintenance rule", failsIf: "Volume is too sparse", riskIds: ["risk-1"] }] }], confirmedCoreOutcomes: 1, unaddressedCatastrophicRisks: 1 };

export async function startMockBackend(options: { longIdeaTitle?: boolean } = {}): Promise<MockBackend> {
  const token = "e2e-token";
  const requests: MockBackend["requests"] = [];
  const threads: Array<Record<string, unknown>> = [];
  let activeThreadId: string | null = null;
  let scope: Record<string, unknown> | null = null;
  let runConfig = DEFAULT_RUN_CONFIG;
  let status = "configuring";
  let discarded = false;
  let workflowSummary: WorkflowSummary | null = null;
  const workspace = () => ({
    validation, threads: threads.map((thread) => ({ ...thread, status })), activeThreadId, messages: [], scope,
    runConfig: activeThreadId ? runConfig : null, models: [DEFAULT_RUN_CONFIG.model, { providerId: "openai-subscription", modelId: "gpt-6-astra" }, { providerId: "openai-subscription", modelId: "gpt-6-luna" }], modelOptions: [{ ...DEFAULT_RUN_CONFIG.model, displayName: "GPT-6 Sol", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }] }, { providerId: "openai-subscription", modelId: "gpt-6-astra", displayName: "Astra", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }] }, { providerId: "openai-subscription", modelId: "gpt-6-luna", displayName: "Luna", defaultReasoningEffort: "low", reasoningEfforts: [{ id: "low", description: "Fast" }] }], modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] }, presets: [],
    problemCandidates: status !== "configuring" ? [problem] : [], rejectedProblemCandidates: status !== "configuring" ? [rejectedProblem] : [], researchRequests: [], researchFindings: [], solutions: status === "solutions-ready" ? [{ ...solution, discarded, mechanism: options.longIdeaTitle ? "Recruit people who recently encountered the problem and reconstruct the last occurrence, current workflow, consequences, frequency, workarounds, and the value of a shared supplier reliability ledger for independent repair shops." : solution.mechanism }] : [],
    latestResearchRun: status === "configuring" ? null : { runId: "run-1", status: "completed", problemId: status === "solutions-ready" ? "problem-1" : null, codexCalls: 8, searches: 10, projectedCodexCalls: 20, projectedSearches: 20, lastActivity: "Problem verification completed" }, pendingRuns: [],
  });
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { ok: false, error: { code: "unauthorized", message: "Unauthorized" } });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown = {};
    if (req.method === "POST") { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
    requests.push({ method: req.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/validation") return ok(res, validation);
    if (url.pathname === "/workspace") return ok(res, workspace());
    if (url.pathname === "/threads") { activeThreadId = "thread-1"; if (!threads.some((thread) => thread.id === activeThreadId)) threads.push({ id: activeThreadId, title: "New research", createdAt: now, updatedAt: now }); return ok(res, { thread: { ...threads[0], status }, workspace: workspace() }); }
    if (url.pathname === "/threads/select") { activeThreadId = (body as { threadId: string }).threadId; return ok(res, workspace()); }
    if (url.pathname === "/threads/title") return ok(res, { title: "Reducing repair shop delays" });
    if (url.pathname === "/threads/archive") {
      const input = body as { threadId: string; archived: boolean };
      const thread = threads.find((item) => item.id === input.threadId)!;
      thread.archivedAt = input.archived ? now : null;
      if (input.archived) activeThreadId = null;
      return ok(res, workspace());
    }
    if (url.pathname === "/threads/delete") { threads.length = 0; activeThreadId = null; return ok(res, workspace()); }
    if (url.pathname === "/scope") { scope = (body as { scope: Record<string, unknown> }).scope; threads[0]!.title = String(scope.title); return ok(res, workspace()); }
    if (url.pathname === "/run-config") { runConfig = (body as { config: typeof DEFAULT_RUN_CONFIG }).config; return ok(res, workspace()); }
    if (url.pathname === "/workflows/preview") {
      const input = PreviewWorkflowRequestSchema.parse(body);
      if (input.type !== "launch") return reply(res, 422, { ok: false, error: { code: "validation_error", message: "Expected a launch preview." } });
      const proposal = {
        ...input.draft,
        resolvedInstructions: { research: "Fixture research", ideas: "Fixture ideas", review: "Fixture review" },
        instructionHashes: { research: "fixture-research", ideas: "fixture-ideas", review: "fixture-review" },
      };
      return ok(res, { type: "launch", proposal, previewHash: "fixture-preview", capabilityFingerprint: "fixture-capabilities",
        minimumWork: { modelCalls: 1, searches: 1 }, upperLimits: proposal.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    if (url.pathname === "/workflows/start") {
      const input = StartWorkflowRequestSchema.parse(body);
      status = "problems-ready";
      workflowSummary = {
        sessionId: "fixture-session", threadId: input.threadId, purpose: input.contract.purpose, mode: input.contract.mode,
        targetKind: input.contract.targets.kind, state: "waiting-for-review", outcome: null, revision: 1,
        activeSnapshotId: "fixture-snapshot", selectedProblemIds: [],
        counts: { requested: input.contract.targets.ideaCount, attempted: 0, validated: 0, accepted: 0,
          duplicate: 0, unresolved: 0, failed: 0, missing: input.contract.targets.ideaCount,
          existing: 0, addedBySession: 0, total: 0 },
        limits: input.contract.limits,
        budget: { modelCalls: { limit: input.contract.limits.maxModelCalls, spent: 1, reserved: 0, uncertain: 0 },
          searches: { limit: input.contract.limits.maxSearches, spent: 1, reserved: 0, uncertain: 0 },
          remainingMs: input.contract.limits.maxMinutes * 60_000 },
        currentStage: null, stopReason: null, startedAt: now, finishedAt: null,
      };
      return ok(res, { sessionId: workflowSummary.sessionId, revision: workflowSummary.revision, summary: workflowSummary });
    }
    if (url.pathname === "/workflows/fixture-session" && workflowSummary) return ok(res, { summary: workflowSummary, tasks: [], nextCursor: null });
    if (url.pathname === "/models/favorite") return ok(res, workspace());
    if (url.pathname === "/research/start") { status = "problems-ready"; return ok(res, { runId: "run-1", workspace: workspace() }); }
    if (url.pathname === "/research/select-problems") { status = "solutions-ready"; return ok(res, workspace()); }
    if (url.pathname === "/research/export") return ok(res, { filename: "repair-delays-research.json", content: JSON.stringify({ schemaVersion: 1, problems: [problem] }) });
    if (url.pathname === "/ideas/discard") { discarded = (body as { discarded: boolean }).discarded; return ok(res, workspace()); }
    if (url.pathname === "/ideas/export") return ok(res, { files: [{ filename: "repair-delays.md", content: "# Repair delays" }] });
    return reply(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Mock backend failed to bind");
  return { url: `http://127.0.0.1:${address.port}`, token, requests, close: async () => { server.close(); await once(server, "close"); } };
}
function ok(res: import("node:http").ServerResponse, data: unknown) { reply(res, 200, { ok: true, data }); }
function reply(res: import("node:http").ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
