import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";

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
const problem = { id: "problem-1", statement: "Small repair shops cannot reliably predict parts arrival times.", whyItPersists: "Supplier data remains fragmented.", affected: "Independent repair shops", scaleEstimate: "Thousands of shops", verdict: "confirmed", verdictReason: "Multiple sources describe recurring delays.", selected: false, factors: [factor], singleHarvestModeWarning: true };
const rejectedProblem = { id: "rejected-1", statement: "Repair shops cannot compare every supplier on one marketplace.", reason: "The candidate cited factors from only one source hostname." };
const solution = { id: "solution-1", problemId: "problem-1", problemStatement: problem.statement, problemVerdict: "confirmed", factors: [factor], mechanism: "Supplier reliability ledger", description: "Pool observed delivery windows by supplier and part category.", respectsOffLimits: true, respectsOffLimitsWhy: "Does not hold inventory.", outcomes: [{ id: "outcome-1", description: "Shops quote narrower delivery windows.", direction: "positive", affects: "Scheduling", addressesCore: true }, { id: "outcome-2", description: "Sparse suppliers remain hard to estimate.", direction: "negative", affects: "Coverage", addressesCore: false }], risks: [{ id: "risk-2", description: "The only data supplier can leave the market.", likelihood: "likely", impact: "project ends", sortKey: 9, mitigations: [] }, { id: "risk-1", description: "Suppliers change behavior faster than the ledger updates.", likelihood: "possible", impact: "~2 weeks", sortKey: 4, mitigations: [{ id: "mitigation-1", approach: "Decay old observations", cost: "One maintenance rule", failsIf: "Volume is too sparse", riskIds: ["risk-1"] }] }], confirmedCoreOutcomes: 1, unaddressedCatastrophicRisks: 1 };

export async function startMockBackend(): Promise<MockBackend> {
  const token = "e2e-token";
  const requests: MockBackend["requests"] = [];
  const threads: Array<Record<string, unknown>> = [];
  let activeThreadId: string | null = null;
  let scope: Record<string, unknown> | null = null;
  let runConfig = DEFAULT_RUN_CONFIG;
  let status = "configuring";
  const workspace = () => ({
    validation, threads: threads.map((thread) => ({ ...thread, status })), activeThreadId, messages: [], scope,
    runConfig: activeThreadId ? runConfig : null, models: [DEFAULT_RUN_CONFIG.model], modelOptions: [{ ...DEFAULT_RUN_CONFIG.model, displayName: "GPT-5.6-Luna", defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "medium", description: "Balanced reasoning" }] }], modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] }, presets: [],
    problemCandidates: status !== "configuring" ? [problem] : [], rejectedProblemCandidates: status !== "configuring" ? [rejectedProblem] : [], solutions: status === "solutions-ready" ? [solution] : [],
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
    if (url.pathname === "/threads") { activeThreadId = "thread-1"; threads.push({ id: activeThreadId, title: "New research", createdAt: now, updatedAt: now }); return ok(res, { thread: { ...threads[0], status }, workspace: workspace() }); }
    if (url.pathname === "/threads/select") return ok(res, workspace());
    if (url.pathname === "/threads/delete") { threads.length = 0; activeThreadId = null; return ok(res, workspace()); }
    if (url.pathname === "/scope") { scope = (body as { scope: Record<string, unknown> }).scope; threads[0]!.title = String(scope.title); return ok(res, workspace()); }
    if (url.pathname === "/run-config") { runConfig = (body as { config: typeof DEFAULT_RUN_CONFIG }).config; return ok(res, workspace()); }
    if (url.pathname === "/models/favorite") return ok(res, workspace());
    if (url.pathname === "/research/start") { status = "problems-ready"; return ok(res, { runId: "run-1", workspace: workspace() }); }
    if (url.pathname === "/research/select-problems") { status = "solutions-ready"; return ok(res, workspace()); }
    if (url.pathname === "/research/export") return ok(res, { filename: "repair-delays-research.json", content: JSON.stringify({ schemaVersion: 1, problems: [problem] }) });
    if (url.pathname === "/ideas/export") return ok(res, { files: [{ filename: "repair-delays.md", content: "# Repair delays" }] });
    return reply(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Mock backend failed to bind");
  return { url: `http://127.0.0.1:${address.port}`, token, requests, close: async () => { server.close(); await once(server, "close"); } };
}
function ok(res: import("node:http").ServerResponse, data: unknown) { reply(res, 200, { ok: true, data }); }
function reply(res: import("node:http").ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
