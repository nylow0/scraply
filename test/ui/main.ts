import "@fontsource-variable/plus-jakarta-sans";
import "../../src/renderer/app.css";
import { mount } from "svelte";
import App from "../../src/renderer/App.svelte";
import { createScraplyApi } from "../../src/shared/scraply-api";
import { AppSettingsSchema } from "../../src/shared/app-settings";
import { DEFAULT_RUN_CONFIG, type Thread } from "../../src/shared/schemas";
import { ExportIdeasRequestSchema, ExportResearchRequestSchema, GetIdeaDetailRequestSchema, IPC_CHANNELS, RemoveSearchKeySchema, SaveScopeSchema, SaveRunConfigSchema, SaveSearchKeySchema, SolutionViewSchema, type SolutionView, type WorkspaceState } from "../../src/shared/ipc";
import { CommandWorkflowRequestSchema, PreviewWorkflowRequestSchema, StartWorkflowRequestSchema, type WorkflowDetail, type WorkflowAction, type WorkflowLaunchContract } from "../../src/shared/workflow-contracts";
import { ResearchFrameSchema } from "../../src/shared/research-frame";
import { framedDiscoveryProjection } from "../../src/shared/discovery-projection";
import { candidateAssessmentProjection } from "../../src/shared/evidence-investigators";

// This standalone renderer has no Electron bridge or network provider. URL parameters
// select deterministic UI scenarios without touching the user's projects or credentials.
const params = new URLSearchParams(location.search);
const fixtureHistory = { actions: [] as WorkflowAction[], launches: [] as WorkflowLaunchContract[], detailReads: [] as string[],
  exports: [] as Array<{ kind: "ideas" | "research"; threadId: string; format: "markdown" | "json"; files: Array<{ filename: string; content: string }> }> };
const count = Math.min(200, Math.max(0, Number(params.get("history") ?? 18)));
const active = Math.min(count - 1, Math.max(0, Number(params.get("active") ?? 0)));
const now = "2026-09-23T12:00:00.000Z";
const names = ["New research", "Repair shop approvals", "Independent educator tools", "Small-team developer tools", "Warranty handoffs", "Parts sourcing"];
const threads: Thread[] = Array.from({ length: count }, (_, i) => ({
  id: `fixture-${i}`, title: i === 2 && params.has("long") ? "Understanding how independent repair businesses coordinate warranty approvals, supplier follow-ups, parts availability, and customer expectations across multiple locations" : names[i] ?? `Research project ${i + 1}`,
  status: i === active ? "configuring" : i === count - 1 ? "failed" : i === count - 2 ? "discovery-running" : i % 2 ? "problems-ready" : "solutions-ready",
  createdAt: now, updatedAt: new Date(Date.parse(now) - i * 60_000).toISOString(),
}));
const noSearch = params.get("search") === "none";
const connectedNative: WorkspaceState["validation"]["native"] = {
  available: true, connected: true, accounts: [{ providerId: "openai-subscription", email: "dany@example.test", plan: "pro" }],
};
// Listed out of display order, like an account catalog: the picker sorts latest models first and puts the rest under Legacy.
const fixtureModels = ["gpt-6-sol", "gpt-6-luna", DEFAULT_RUN_CONFIG.model.modelId, "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"]
  .map((modelId) => ({ providerId: "openai-subscription", modelId }));
let state: WorkspaceState = {
  validation: {
    exa: noSearch ? { valid: false, error: "Exa key missing" }
      : { valid: params.get("connection") !== "offline", maskedKey: "••••3f9a", ...(params.get("connection") === "offline" ? { error: "Search provider is disconnected" } : {}) },
    perplexity: noSearch ? { valid: false, error: "Perplexity key missing" } : { valid: true, maskedKey: "••••77c1" },
    native: params.get("account") === "signed-out" ? { available: true, connected: false, accounts: [] } : connectedNative,
    setupComplete: !noSearch && params.get("account") !== "signed-out",
  },
  threads, activeThreadId: threads[active]?.id ?? null, messages: [], scope: null, runConfig: null,
  models: fixtureModels,
  modelOptions: fixtureModels.map((model) => ({
    ...model, displayName: model.modelId, defaultReasoningEffort: "medium",
    reasoningEfforts: [{ id: "low", description: "Less reasoning" }, { id: "medium", description: "Balanced reasoning" }, { id: "high", description: "More reasoning" }],
  })),
  modelCatalog: { models: [DEFAULT_RUN_CONFIG.model], favorites: [] }, presets: [], problemCandidates: [], rejectedProblemCandidates: [],
  researchRequests: [], researchFindings: [], solutions: [], latestResearchRun: null, pendingRuns: [],
};

if (params.has("unassessed") && state.activeThreadId) {
  const extras = Math.min(20, Math.max(1, Number(params.get("unassessed") || 5)));
  state.runConfig = DEFAULT_RUN_CONFIG;
  state.scope = { title: "Candidate limit fixture", audience: "Operators", domain: "Filing", observations: "", offLimits: [] };
  state.threads = state.threads.map((thread) => thread.id === state.activeThreadId ? { ...thread, status: "solutions-ready" } : thread);
  state.rejectedProblemCandidates = Array.from({ length: extras }, (_, index) => ({
    id: `unassessed-${index}`, statement: `Operators repeat filing step ${index + 1}`,
    reason: "Not assessed: this standard-depth run assesses up to 4 problem candidates.", disposition: "not-assessed",
    candidate: {
      statement: `Operators repeat filing step ${index + 1}`, whyItPersists: "Their systems do not share state.",
      affected: "Operators", scaleEstimate: "Frequency has not been measured", scaleBasisFactorId: null,
      factorIds: [`fixture-factor-${index}`], alternativeExplanations: ["An existing export may suffice"],
      unknowns: ["Workflow frequency"], intendedBuyerEvidenceFactorIds: [], evidenceGap: "Needs evidence assessment",
    },
  }));
}

const ideasScenario = params.get("ideas");
if (ideasScenario && state.activeThreadId) {
  state.runConfig = { ...DEFAULT_RUN_CONFIG, workflowVersion: 2, ideaCount: 5 };
  state.scope = { title: "Saved idea counts", audience: "Shop owners", domain: "Parts purchasing", observations: "", offLimits: [] };
  state.threads = state.threads.map((thread) => thread.id === state.activeThreadId ? { ...thread,
    title: "Saved idea counts", status: ideasScenario === "zero" ? "problems-ready" : "solutions-ready" } : thread);
  const groups = ideasScenario === "zero"
    ? [{ problemId: "empty", statement: "Shops repeat purchase approvals", requested: 3, returned: 0 }]
    : [{ problemId: "complete", statement: "Suppliers hide delivery changes", requested: 3, returned: 3 },
      ...(ideasScenario === "complete" ? [] : [
        { problemId: "short", statement: "Shops repeat purchase approvals", requested: 3, returned: 2 },
        { problemId: "empty", statement: "Owners cannot compare warranty delays", requested: 3, returned: 0 },
      ])];
  state.ideaGroups = groups.map((group) => ({ runId: `idea-run-${group.problemId}`, problemId: group.problemId,
    problemStatement: group.statement, requestedIdeaCount: group.requested, returnedIdeaCount: group.returned }));
  state.solutions = groups.flatMap((group) => Array.from({ length: group.returned }, (_, index) => ({
    id: `${group.problemId}-idea-${index + 1}`, problemId: group.problemId, problemStatement: group.statement,
    problemVerdict: "confirmed" as const, runId: `idea-run-${group.problemId}`, workflowVersion: 2 as const,
    detailsLoaded: true, rank: index + 1, rankReason: "The saved ranker's order.", weakFitReason: null,
    mechanism: "Compare saved approval records.", description: `${group.problemId === "complete" ? "Delivery" : "Approval"} idea ${index + 1}: compare saved records and flag changes.`,
    factors: [], outcomes: [], risks: [], respectsOffLimits: true, respectsOffLimitsWhy: "Within the project boundaries.",
    confirmedCoreOutcomes: 0, unaddressedCatastrophicRisks: 0,
  })));
}

const guidedProgress: WorkflowDetail | null = params.get("progress") === "guided" && state.activeThreadId ? {
  summary: {
    sessionId: "fixture-guided", threadId: state.activeThreadId, purpose: "discovery", mode: "vibe", targetKind: "per-problem",
    state: "running", outcome: null, revision: 1, activeSnapshotId: null, selectedProblemIds: [],
    ideaTargetReady: false,
    counts: { requested: 0, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 0, existing: 0, addedBySession: 0, total: 0 },
    limits: { enforced: false, maxMinutes: 90, maxModelCalls: 72, maxSearches: 38 },
    budget: { modelCalls: { limit: 72, spent: 1, reserved: 50, uncertain: 0 }, searches: { limit: 38, spent: 0, reserved: 24, uncertain: 0 }, remainingMs: 89 * 60_000 },
    currentStage: "discovery", stopReason: null, startedAt: now, finishedAt: null,
  },
  tasks: [{ id: "fixture-discovery", parentItemId: null, kind: "discovery", scopeKey: "initial-research", state: "running", createdAt: now, finishedAt: null }],
  activity: [
    { id: "1", message: "Model call completed", stage: "searching", createdAt: now },
    { id: "2", message: "Searching Perplexity: repair shop warranty approval delays", stage: "searching", createdAt: now },
    { id: "3", message: "Found 8 sources for: repair shop warranty approval delays", stage: "searching", createdAt: now },
    { id: "4", message: "Model request accepted", stage: "extracting", createdAt: now },
  ],
  nextCursor: null,
} : null;
if (guidedProgress) {
  if (params.get("phase") === "ideas") {
    guidedProgress.summary.ideaTargetReady = true;
    guidedProgress.summary.selectedProblemIds = ["problem-1", "problem-2"];
    guidedProgress.summary.counts.requested = 6;
    guidedProgress.summary.counts.missing = 6;
    guidedProgress.summary.currentStage = "generate-ideas";
  }
  if (params.get("phase") === "failed") {
    guidedProgress.summary.state = "finished";
    guidedProgress.summary.outcome = "failed";
    guidedProgress.summary.stopReason = "Search provider is unavailable.";
    guidedProgress.summary.finishedAt = now;
    guidedProgress.tasks[0]!.state = "failed";
  }
  if (params.get("phase") === "audience-recovery") {
    guidedProgress.summary.state = "finished";
    guidedProgress.summary.outcome = "no-qualifying-ideas";
    guidedProgress.summary.finishedAt = now;
    guidedProgress.tasks[0]!.state = "succeeded";
    guidedProgress.tasks[0]!.canReassessProblems = true;
  }
  if (["completed-handoff", "acknowledged-restart"].includes(params.get("phase") ?? "")) {
    guidedProgress.summary.state = "paused";
    guidedProgress.summary.canResume = true;
    guidedProgress.summary.budget.modelCalls.uncertain = 50;
    guidedProgress.summary.budget.searches.uncertain = 24;
  }
  if (params.get("activity") === "long") {
    guidedProgress.activity = Array.from({ length: 16 }, (_, index) => ({ id: `long-activity-${index}`,
      message: `Reading source packet ${index + 1}: checking firsthand accounts of repair shops coordinating warranty approvals, supplier follow-ups, uncertain parts delivery windows, and customer expectations across locations.`,
      stage: "extracting", createdAt: new Date(Date.parse(now) + index * 60_000).toISOString() }));
  }
  state.activeWorkflow = guidedProgress.summary;
  state.threads = state.threads.map(thread => thread.id === state.activeThreadId ? { ...thread, status: params.get("phase") === "failed" ? "failed" : "discovery-running" } : thread);
}

const knownProblemFrame = params.get("known") === "1";
const frameScenario = params.get("frame");
const duplicateInvestigator = params.get("duplicate") === "1";
const frameDraft = ResearchFrameSchema.parse({
  version: 1,
  goal: knownProblemFrame ? "Reduce missed deposits in one independent bakery." : "Find a useful workflow for freelance bookkeepers.",
  goalKind: params.get("goal") === "community" ? "community-or-personal" : params.get("goal") === "research" ? "research-question" : "market-opportunity",
  contextFacts: knownProblemFrame && noSearch ? [] : [{ fact: "Accounting platforms include bank-feed matching rules.", sourceIds: ["frame-source-1"] }],
  successCriteria: [{ id: "criterion-observed", name: "Observed firsthand pain", weight: "must", howJudged: "At least two independent accounts from affected people.", basis: "brief" },
    { id: "criterion-build", name: "Smallest useful workflow", weight: "high", howJudged: "Can be built and tested by one person within a month.", basis: "brief" }],
  constraints: [{ text: "One person, one month", kind: "team", basis: "brief" }],
  languages: params.get("goal") === "community" ? ["en", "uk"] : ["en"],
  areas: knownProblemFrame ? [] : [
    { id: "bank", name: "Bank-feed matching", whyRelevant: "Matching mistakes create repeated manual work.", affectedPeople: "Freelance bookkeepers", venues: [{ name: "Bookkeeping communities", domain: "reddit.com", kind: "community" }], exampleProblems: ["A matching rule stops recognizing changed bank descriptions."], included: true, priority: 1 },
    { id: "documents", name: "Client document chasing", whyRelevant: "Missing documents delay a client's close.", affectedPeople: "Solo bookkeepers with recurring clients", venues: [{ name: "Accounting software issues", domain: "github.com", kind: "issue-tracker" }], exampleProblems: [], included: true, priority: 2 },
    { id: "payroll", name: "Payroll reconciliation", whyRelevant: "Payments can be hard to match.", affectedPeople: "Small accounting firms", venues: [{ name: "Accounting forums", kind: "community" }], exampleProblems: [], included: false, priority: 3 },
  ],
  exclusions: ["Full accounting suites"],
  openQuestions: [{ id: "question-audience", question: "Solo freelancers or small firms?", whyItMatters: "Changes the areas and communities to explore.", options: ["Solo freelancers", "Small firms"] }],
});
const frameWorkflow: WorkflowDetail | null = frameScenario && state.activeThreadId ? {
  summary: {
    sessionId: "fixture-frame", threadId: state.activeThreadId, purpose: knownProblemFrame ? "known-problem" : "discovery", mode: frameScenario === "investigators" ? "vibe" : "babysit", targetKind: "per-problem",
    state: frameScenario === "approved" ? "finished" : frameScenario === "investigators" ? "running" : "waiting-for-review",
    outcome: frameScenario === "approved" ? "partial" : null, revision: 1, activeSnapshotId: frameScenario === "approved" ? "fixture-frame-snapshot" : null, selectedProblemIds: [], ideaTargetReady: false,
    ...(frameScenario === "review" ? { reviewKind: "frame" as const } : {}),
    counts: { requested: 0, attempted: 0, validated: 0, accepted: 0, duplicate: 0, unresolved: 0, failed: 0, missing: 0, existing: 0, addedBySession: 0, total: 0 },
    limits: { enforced: params.get("allowance") === "empty", maxMinutes: 90, maxModelCalls: params.get("allowance") === "empty" ? 2 : 200, maxSearches: knownProblemFrame ? 0 : 200 },
    budget: { modelCalls: { limit: params.get("allowance") === "empty" ? 2 : 200, spent: knownProblemFrame ? 1 : 2, reserved: 0, uncertain: 0 }, searches: { limit: knownProblemFrame ? 0 : 200, spent: knownProblemFrame ? 0 : 4, reserved: 0, uncertain: 0 }, remainingMs: 90 * 60_000 },
    currentStage: frameScenario === "investigators" ? "investigate-area" : "frame", stopReason: frameScenario === "approved" ? "Saved fixture research is ready to inspect." : null,
    startedAt: now, finishedAt: frameScenario === "approved" ? now : null,
  },
  researchFrame: { id: "frame-v1", version: 1, knownProblem: knownProblemFrame, draft: frameDraft, approved: frameScenario === "review" ? null : structuredClone(frameDraft),
    sources: knownProblemFrame && noSearch ? [] : [{ id: "frame-source-1", title: "Bank-feed matching documentation", url: "https://example.org/matching", text: "Matching rules compare incoming bank descriptions." }], createdAt: now, approvedAt: frameScenario === "review" ? null : now },
  tasks: frameScenario === "investigators" ? [
    { id: "investigator-bank", parentItemId: null, kind: "investigate-area", scopeKey: "investigate-area:bank", state: "running", createdAt: now, finishedAt: null, investigator: { areaId: "bank", areaName: "Bank-feed matching", currentStep: "Checking a second independent account", confirmedCount: 1, insufficientCount: 2, droppedCount: 0 } },
    { id: duplicateInvestigator ? "investigator-bank-followup" : "investigator-documents", parentItemId: null, kind: "investigate-area", scopeKey: duplicateInvestigator ? "investigate-area:bank:followup" : "investigate-area:documents", state: "ready", createdAt: now, finishedAt: null, investigator: { areaId: duplicateInvestigator ? "bank" : "documents", areaName: duplicateInvestigator ? "Bank-feed matching" : "Client document chasing", currentStep: null, confirmedCount: null, insufficientCount: null, droppedCount: null } },
  ] : [{ id: "fixture-prepare-frame", parentItemId: null, kind: "prepare-frame", scopeKey: "frame", state: "succeeded", createdAt: now, finishedAt: now }],
  nextCursor: null,
} : null;
if (frameWorkflow) {
  if (frameWorkflow.researchFrame?.approved) frameWorkflow.latestResearchFrame = structuredClone(frameWorkflow.researchFrame);
  state.activeWorkflow = frameWorkflow.summary;
  state.runConfig = { ...DEFAULT_RUN_CONFIG, researchMode: knownProblemFrame ? "known-problem" : "explore-market", knownProblem: knownProblemFrame ? "Bakeries miss deposits on custom orders." : "" };
  state.scope = { title: knownProblemFrame ? "Bakery deposits" : "Bookkeeping workflows", domain: knownProblemFrame ? "Bakery custom orders" : "Freelance bookkeeping", audience: "", observations: "", offLimits: ["Full accounting suites"] };
  state.threads = state.threads.map(thread => thread.id === state.activeThreadId ? { ...thread, title: state.scope!.title, status: frameScenario === "approved" ? "problems-ready" : "discovery-running" } : thread);
}

let progressReads = 0;
let advancedSettings = AppSettingsSchema.parse({});
const fixtureApi = createScraplyApi({
  async invoke<T>(channel: string, payload?: unknown): Promise<T> {
    let result: unknown;
    switch (channel) {
      case IPC_CHANNELS.GET_WORKSPACE: result = state; break;
      case IPC_CHANNELS.GET_IDEA_DETAIL: {
        const { ideaId } = GetIdeaDetailRequestSchema.parse(payload);
        const idea = state.solutions.find((saved) => saved.id === ideaId);
        if (!idea) throw new Error("Idea not found in the offline fixture.");
        fixtureHistory.detailReads.push(ideaId);
        result = SolutionViewSchema.parse({ ...idea, detailsLoaded: true });
        break;
      }
      case IPC_CHANNELS.EXPORT_IDEAS: {
        const { threadId, format } = ExportIdeasRequestSchema.parse(payload);
        if (threadId !== state.activeThreadId) throw new Error("Select the fixture project before exporting.");
        const groups = new Map<string, SolutionView[]>();
        for (const idea of state.solutions) groups.set(idea.problemId, [...(groups.get(idea.problemId) ?? []), idea]);
        for (const group of state.ideaGroups ?? []) if (group.returnedIdeaCount === 0 && !groups.has(group.problemId)) groups.set(group.problemId, []);
        const files = [...groups].map(([problemId, ideas]) => {
          const saved = state.ideaGroups?.find((group) => group.problemId === problemId);
          const ordered = [...ideas].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
          const statement = ordered[0]?.problemStatement ?? saved?.problemStatement ?? problemId;
          const content = format === "json" ? JSON.stringify(ordered.length ? ordered : {
            kind: "no-options", status: "completed", workflowVersion: 2, runId: saved?.runId, problemId, problemStatement: statement, options: [],
          }, null, 2) : `# ${statement}\n\n${ordered.length ? ordered.map((idea) => `## ${idea.description}\n\n${idea.mechanism}`).join("\n\n") : "No ideas were returned."}\n`;
          return { filename: `${problemId}.${format === "json" ? "json" : "md"}`, content };
        });
        fixtureHistory.exports.push({ kind: "ideas", threadId, format, files });
        result = { cancelled: false, directory: "offline-fixture-exports", files: files.map((file) => file.filename) };
        break;
      }
      case IPC_CHANNELS.EXPORT_RESEARCH: {
        const { threadId } = ExportResearchRequestSchema.parse(payload);
        if (threadId !== state.activeThreadId) throw new Error("Select the fixture project before exporting.");
        const filename = "fixture-research.json";
        const content = JSON.stringify({ problems: state.problemCandidates, rejectedCandidates: state.rejectedProblemCandidates,
          researchFindings: state.researchFindings }, null, 2);
        fixtureHistory.exports.push({ kind: "research", threadId, format: "json", files: [{ filename, content }] });
        result = { cancelled: false, file: `offline-fixture-exports/${filename}` };
        break;
      }
      case IPC_CHANNELS.GET_ADVANCED_SETTINGS: result = advancedSettings; break;
      case IPC_CHANNELS.SAVE_ADVANCED_SETTINGS: advancedSettings = AppSettingsSchema.parse(payload); result = advancedSettings; break;
      case IPC_CHANNELS.COMMAND_WORKFLOW: {
        const request = CommandWorkflowRequestSchema.parse(payload);
        fixtureHistory.actions.push(request.action);
        if (frameWorkflow) {
          const saved = frameWorkflow.researchFrame!;
          if (request.action.type === "approve-frame") {
            saved.approved = ResearchFrameSchema.parse(request.action.frame);
            saved.approvedAt = now;
            frameWorkflow.latestResearchFrame = structuredClone(saved);
            frameWorkflow.summary.state = "running";
            delete frameWorkflow.summary.reviewKind;
            frameWorkflow.summary.currentStage = knownProblemFrame ? "generate-ideas" : "scan-areas";
          } else if (request.action.type === "regenerate-frame") {
            saved.draft = ResearchFrameSchema.parse({ ...request.action.frame, goal: `${request.action.frame.goal} Refine the most useful workflow.` });
            saved.id = `frame-v${saved.version + 1}`;
            saved.version += 1;
            frameWorkflow.summary.budget.modelCalls.spent += 1;
          } else if (request.action.type === "edit-approved-frame") {
            const latest = frameWorkflow.latestResearchFrame;
            if (!latest?.approved) throw new Error("Approve the frame before editing a new version.");
            latest.approved = ResearchFrameSchema.parse(request.action.frame);
            latest.draft = latest.approved;
            latest.id = `frame-v${latest.version + 1}`;
            latest.version += 1;
          } else if (request.action.type === "stop") {
            frameWorkflow.summary.state = "finished";
            frameWorkflow.summary.outcome = "cancelled";
            frameWorkflow.summary.finishedAt = now;
            frameWorkflow.summary.stopReason = request.action.reason ?? "Stopped by you.";
          } else if (request.action.type === "pause") {
            frameWorkflow.summary.state = "paused";
            if (duplicateInvestigator) frameWorkflow.tasks.reverse();
          } else if (request.action.type === "resume") {
            frameWorkflow.summary.state = "running";
            if (duplicateInvestigator) frameWorkflow.tasks.reverse();
          }
          else if (request.action.type === "assess-not-assessed") {
            frameWorkflow.summary.state = "running";
            frameWorkflow.summary.currentStage = "candidate-assessment";
            frameWorkflow.summary.outcome = null;
            frameWorkflow.summary.finishedAt = null;
          }
          else throw new Error("This frame fixture supports only review, editing, and run controls.");
          frameWorkflow.summary.revision += 1;
          state.activeWorkflow = frameWorkflow.summary;
          result = { ok: true, data: { sessionId: frameWorkflow.summary.sessionId, revision: frameWorkflow.summary.revision, summary: frameWorkflow.summary } };
          break;
        }
        const supported = request.action.type === "reassess-problems" && params.get("phase") === "audience-recovery"
          || request.action.type === "resume" && ["completed-handoff", "acknowledged-restart"].includes(params.get("phase") ?? "");
        if (!guidedProgress || !supported) {
          throw new Error("This fixture only simulates saved discovery recovery.");
        }
        guidedProgress.summary.state = "running";
        guidedProgress.summary.outcome = null;
        guidedProgress.summary.finishedAt = null;
        guidedProgress.summary.revision += 1;
        guidedProgress.tasks[0]!.state = "running";
        guidedProgress.tasks[0]!.canReassessProblems = false;
        result = { ok: true, data: { sessionId: guidedProgress.summary.sessionId,
          revision: guidedProgress.summary.revision, summary: guidedProgress.summary } };
        break;
      }
      case IPC_CHANNELS.GET_WORKFLOW:
        if (frameWorkflow && frameWorkflow.summary.state === "running" && params.has("live") && ++progressReads >= 2) {
          const first = frameWorkflow.tasks.find((task) => task.id === "investigator-bank");
          if (first?.investigator) {
            first.state = "succeeded";
            first.finishedAt = now;
            first.investigator.currentStep = "Evidence checks finished";
            first.investigator.confirmedCount = 2;
            first.investigator.insufficientCount = 0;
            first.investigator.droppedCount = 1;
          }
          const next = frameWorkflow.tasks.find((task) => task.id === (duplicateInvestigator ? "investigator-bank-followup" : "investigator-documents"));
          if (next?.investigator) { next.state = "running"; next.investigator.currentStep = "Reading firsthand sources"; next.investigator.confirmedCount = 0; next.investigator.insufficientCount = 1; next.investigator.droppedCount = 0; }
        }
        if (guidedProgress && params.has("live") && ++progressReads === 2) {
          guidedProgress.activity?.push({ id: "5", message: "12 observations from 8 sources", stage: "extracting", createdAt: now });
        }
        result = { ok: true, data: frameWorkflow ?? guidedProgress }; break;
      case IPC_CHANNELS.GET_VALIDATION: result = state.validation; break;
      case IPC_CHANNELS.START_WORKFLOW: {
        if (!frameWorkflow) throw new Error("Only the frame fixture can simulate a replacement launch.");
        const request = StartWorkflowRequestSchema.parse(payload);
        fixtureHistory.launches.push(request.contract);
        frameWorkflow.summary = { ...frameWorkflow.summary, sessionId: "fixture-restarted", revision: 1,
          purpose: request.contract.purpose, mode: request.contract.mode, state: request.contract.mode === "babysit" ? "waiting-for-review" : "running",
          outcome: null, stopReason: null, finishedAt: null, currentStage: "frame",
          ...(request.contract.mode === "babysit" ? { reviewKind: "frame" as const } : {}) };
        const draft = ResearchFrameSchema.parse({ ...frameDraft, goal: request.contract.brief });
        frameWorkflow.researchFrame = { ...frameWorkflow.researchFrame!, id: "frame-restarted", version: 1, draft,
          approved: request.contract.mode === "babysit" ? null : structuredClone(draft) };
        state.activeWorkflow = frameWorkflow.summary;
        result = { ok: true, data: { sessionId: frameWorkflow.summary.sessionId, revision: 1, summary: frameWorkflow.summary } };
        break;
      }
      case IPC_CHANNELS.SELECT_THREAD: {
        const { threadId } = payload as { threadId: string };
        state = { ...state, activeThreadId: threadId, scope: null, runConfig: null };
        result = state; break;
      }
      case IPC_CHANNELS.CREATE_THREAD: {
        const thread = { id: `fixture-new-${state.threads.length}`, title: "New research", status: "configuring" as const, createdAt: now, updatedAt: now };
        state = { ...state, threads: [thread, ...state.threads], activeThreadId: thread.id, scope: null, runConfig: null };
        result = { workspace: state }; break;
      }
      case IPC_CHANNELS.ARCHIVE_THREAD: {
        const { threadId, archived } = payload as { threadId: string; archived: boolean };
        state = { ...state, threads: state.threads.map((thread) => thread.id === threadId ? { ...thread, archivedAt: archived ? now : null } : thread) };
        if (archived && state.activeThreadId === threadId) state.activeThreadId = state.threads.find((thread) => !thread.archivedAt)?.id ?? null;
        result = state; break;
      }
      case IPC_CHANNELS.SAVE_SCOPE: state = { ...state, scope: SaveScopeSchema.parse(payload).scope }; result = state; break;
      case IPC_CHANNELS.SAVE_RUN_CONFIG: state = { ...state, runConfig: SaveRunConfigSchema.parse(payload).config }; result = state; break;
      case IPC_CHANNELS.PREVIEW_WORKFLOW: {
        const request = PreviewWorkflowRequestSchema.parse(payload);
        if (request.type === "candidate-assessment") {
          if (!frameWorkflow || !state.rejectedProblemCandidates.some(candidate => candidate.id === request.candidateId)) {
            throw new Error("Select a saved candidate from the offline fixture.");
          }
          const depth = state.runConfig?.discoveryDepth ?? "standard";
          const projection = candidateAssessmentProjection(depth);
          result = { ok: true, data: { type: "candidate-assessment", proposal: { candidateId: request.candidateId, sourceRunId: "fixture-candidate-run", depth, ...projection },
            previewHash: `fixture-assess-${request.candidateId}`, capabilityFingerprint: "fixture", minimumWork: projection,
            upperLimits: frameWorkflow.summary.limits, fieldErrors: [], expiresAt: "2099-01-01T00:00:00.000Z" } };
          break;
        }
        if (request.type !== "launch") throw new Error("Only launch previews are available in the UI fixture.");
        const { draft } = request;
        const projection = framedDiscoveryProjection(draft.runConfig.discoveryDepth);
        const minimum = draft.purpose === "known-problem" ? { modelCalls: 4, searches: 0 } : { modelCalls: projection.modelCalls * 2 + (draft.mode === "vibe" ? 12 : 0), searches: projection.searches };
        result = { ok: true, data: {
          type: "launch", proposal: { ...draft, resolvedInstructions: { research: "Fixture research", ideas: "Fixture ideas", review: "Fixture review" }, instructionHashes: { research: "r", ideas: "i", review: "v" } },
          previewHash: JSON.stringify(draft), capabilityFingerprint: "fixture", minimumWork: minimum, upperLimits: draft.limits,
          fieldErrors: [
            ...(draft.limits.enforced !== false && draft.limits.maxModelCalls < minimum.modelCalls ? [{ path: ["limits", "maxModelCalls"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimum.modelCalls} model calls.` }] : []),
            ...(draft.limits.enforced !== false && draft.limits.maxSearches < minimum.searches ? [{ path: ["limits", "maxSearches"], code: "BUDGET_TOO_SMALL", message: `Allow at least ${minimum.searches} searches.` }] : []),
          ], expiresAt: "2099-01-01T00:00:00.000Z",
        } }; break;
      }
      case IPC_CHANNELS.RETRY_CONNECTION: result = undefined; break;
      // Sign-in succeeds at once; nothing leaves the page.
      case IPC_CHANNELS.NATIVE_LOGIN_START: result = { loginId: "fixture-login", providerId: "openai-subscription", method: "browser" }; break;
      case IPC_CHANNELS.NATIVE_LOGIN_COMPLETE:
        state = { ...state, validation: { ...state.validation, native: connectedNative } };
        result = { pending: false, workspace: state }; break;
      case IPC_CHANNELS.OPEN_EXTERNAL_URL: result = undefined; break;
      // Keys containing "invalid" are rejected the way a provider would; others save after a short check.
      case IPC_CHANNELS.SAVE_SEARCH_KEY: {
        const { provider, apiKey } = SaveSearchKeySchema.parse(payload);
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (apiKey.includes("invalid")) {
          result = { ok: false, error: { code: "validation_error", message: `${provider === "exa" ? "Exa" : "Perplexity"} API key was rejected` } };
          break;
        }
        state = { ...state, validation: { ...state.validation, [provider]: { valid: true, maskedKey: `••••${apiKey.slice(-4)}` } } };
        result = { ok: true, data: state }; break;
      }
      case IPC_CHANNELS.REMOVE_SEARCH_KEY: {
        const { provider } = RemoveSearchKeySchema.parse(payload);
        state = { ...state, validation: { ...state.validation, [provider]: { valid: false, error: `${provider === "exa" ? "Exa" : "Perplexity"} key missing` } } };
        result = { ok: true, data: state }; break;
      }
      default: throw new Error(`UI fixture does not execute ${channel}. No research was launched.`);
    }
    return structuredClone(result) as T;
  },
  onAppCommand: () => () => {},
  onBackendEvent: () => () => {},
});
Object.assign(window, { scraply: fixtureApi, scraplyFixture: fixtureHistory });
const target = document.getElementById("app");
if (target) mount(App, { target });
