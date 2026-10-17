import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { APP_CHANNELS, ListRunsResultSchema, OperationProposalSchema, isBillableOperation, type RunIndexEntry } from "../../shared/cli-contracts";
import { IPC_CHANNELS, ResearchEventSchema, type ResearchEvent } from "../../shared/ipc";
import { ResearchFrameSchema } from "../../shared/research-frame";
import { RunTraceSchema, RunTraceStepDetailSchema } from "../../shared/run-trace";
import {
  CommandWorkflowRequestSchema, PreviewWorkflowResultSchema, StartWorkflowRequestSchema,
  WorkflowDetailSchema, WorkflowLaunchContractSchema, type WorkflowAction, type WorkflowDetail,
} from "../../shared/workflow-contracts";
import { booleanFlag, numberFlag, requirePositional, stringFlag, type CommandArguments, type FlagDefinition } from "../args";
import type { CommandContext, ProjectContext } from "../context";
import { CliError } from "../output";
import type { CommandDefinition } from "../registry";

export const projectFlag: FlagDefinition = { name: "project", type: "string", description: "Project ID, unique prefix, or exact title; defaults to the selected project." };
export const approvalFlags: FlagDefinition[] = [
  { name: "yes", type: "boolean", description: "Approve this invocation's fresh owner-issued proposal." },
  { name: "preview-file", type: "string", description: "Execute a saved owner-issued proposal after its state and expiry checks." },
];
export const modelFlags: FlagDefinition[] = [
  { name: "model", type: "string", description: "Exact provider:model override; otherwise preserve the saved model." },
  { name: "effort", type: "string", description: "Exact reasoning effort; otherwise preserve the saved effort." },
];
export const sessionFlags: FlagDefinition[] = [
  projectFlag,
  { name: "run", type: "string", description: "Workflow session ID or unique prefix; defaults to this project's saved workflow." },
  { name: "revision", type: "number", description: "Require this saved workflow revision." },
  { name: "client-command-id", type: "string", description: "Stable command ID; generated once when omitted. Never replay an uncertain admission." },
];
const legacyFlag: FlagDefinition = { name: "legacy", type: "boolean", description: "Use the older research-run contract and legacy research channels." };
const runPosition = [{ name: "id", description: "Workflow session or research run ID, including a unique prefix.", required: true }];
const inputFlags: FlagDefinition[] = [
  { name: "file", type: "string", description: "Read the complete research frame JSON from this file." },
  { name: "stdin", type: "boolean", description: "Read the complete research frame JSON from stdin." },
];

/** Explicit session reads never select a project or replace its immutable launch contract. */
export async function workflowTarget(context: CommandContext, args: CommandArguments, reference = stringFlag(args, "run")) {
  const selector = stringFlag(args, "project");
  const addressedProject = selector ? await context.project(selector) : undefined;
  if (reference) {
    const resolved = await context.resolve("workflow", reference, addressedProject?.thread.id);
    const detail = WorkflowDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId: resolved.id }));
    const project = addressedProject ?? await context.project(detail.summary.threadId);
    return { project, detail };
  }
  const project = addressedProject ?? await context.project();
  const summary = project.workspace.activeWorkflow;
  if (!summary) throw new CliError("INVALID_REFERENCE", "This project has no workflow session. Next command: scraply run start --project <project>");
  const detail = WorkflowDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId: summary.sessionId }));
  return { project, detail };
}

export async function workflowAction(context: CommandContext, args: CommandArguments, target: { project: ProjectContext; detail: WorkflowDetail }, action: WorkflowAction) {
  const savedInput = await savedOperation(args, IPC_CHANNELS.COMMAND_WORKFLOW);
  const saved = savedInput ? CommandWorkflowRequestSchema.parse(savedInput) : undefined;
  // Native proofs and generated command IDs belong to the original proposal, including its expiry.
  if (saved?.action.type === action.type && (action.type === "extend-budget" || action.type === "assess-not-assessed")) {
    const proof = saved.action;
    if (proof.type === "extend-budget" || proof.type === "assess-not-assessed") action = { ...action, previewHash: proof.previewHash, capabilityFingerprint: proof.capabilityFingerprint, previewExpiresAt: proof.previewExpiresAt };
  }
  const payload = CommandWorkflowRequestSchema.parse({
    threadId: target.project.thread.id, sessionId: target.detail.summary.sessionId,
    clientCommandId: stringFlag(args, "client-command-id") ?? saved?.clientCommandId ?? randomUUID(),
    expectedRevision: numberFlag(args, "revision") ?? saved?.expectedRevision ?? target.detail.summary.revision, action,
  });
  return isBillableOperation(IPC_CHANNELS.COMMAND_WORKFLOW, payload)
    ? context.previewAndExecute(IPC_CHANNELS.COMMAND_WORKFLOW, payload, args)
    : context.invoke(IPC_CHANNELS.COMMAND_WORKFLOW, payload);
}

/** A saved preview supplies generated identity and proof fields, never a local admission decision. */
export async function savedOperation(args: CommandArguments, channel: string): Promise<unknown> {
  const file = stringFlag(args, "preview-file");
  if (!file) return undefined;
  let input: unknown;
  try { input = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as unknown; }
  catch { throw new CliError("USAGE", "Cannot read the saved preview. Use its complete owner-issued proposal JSON.", 2); }
  const proposal = OperationProposalSchema.parse(input);
  if (proposal.operation.channel !== channel) throw new CliError("USAGE", "The preview belongs to a different command.", 2);
  return proposal.operation.payload;
}

export async function workflowPages(context: CommandContext, detail: WorkflowDetail) {
  const tasks = [...detail.tasks];
  const seen = new Set<string>();
  let cursor = detail.nextCursor;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new CliError("internal_error", "The owner repeated a task cursor.");
    seen.add(cursor);
    const page = WorkflowDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId: detail.summary.sessionId, cursor }));
    tasks.push(...page.tasks);
    cursor = page.nextCursor;
  }
  return { ...detail, tasks, nextCursor: null };
}

export function checkNativePreview(preview: ReturnType<typeof PreviewWorkflowResultSchema.parse>) {
  if (preview.fieldErrors.length) {
    throw new CliError("validation_error", preview.fieldErrors.map(error => `${error.path.join(".")}: ${error.message}`).join("; "), 1, { fieldErrors: preview.fieldErrors });
  }
}

async function launch(context: CommandContext, args: CommandArguments, previewOnly: boolean) {
  const project = await context.project(stringFlag(args, "project"));
  if (booleanFlag(args, "legacy")) {
    const payload = { threadId: project.thread.id };
    if (previewOnly) return context.invoke(APP_CHANNELS.PREVIEW_OPERATION, { channel: IPC_CHANNELS.START_RESEARCH, payload });
    return context.previewAndExecute(IPC_CHANNELS.START_RESEARCH, payload, args);
  }
  if (!project.draft) throw new CliError("USAGE", "Save a brief and configuration first. Next command: scraply brief set --file <brief.json>", 2);
  const saved = !previewOnly ? await savedOperation(args, IPC_CHANNELS.START_WORKFLOW) : undefined;
  if (saved) {
    const payload = StartWorkflowRequestSchema.parse(saved);
    if (payload.threadId !== project.thread.id || (stringFlag(args, "client-command-id") && stringFlag(args, "client-command-id") !== payload.clientCommandId)) throw new CliError("USAGE", "The saved preview belongs to another project or launch command.", 2);
    // The owner rechecks the saved project, models, prompts, hash, and expiry on execution.
    return context.previewAndExecute(IPC_CHANNELS.START_WORKFLOW, payload, args);
  }
  const preview = PreviewWorkflowResultSchema.parse(await context.invoke(IPC_CHANNELS.PREVIEW_WORKFLOW, { type: "launch", threadId: project.thread.id, draft: project.draft }));
  if (previewOnly) return preview;
  checkNativePreview(preview);
  const payload = StartWorkflowRequestSchema.parse({
    threadId: project.thread.id, clientCommandId: stringFlag(args, "client-command-id") ?? randomUUID(),
    contract: WorkflowLaunchContractSchema.parse(preview.proposal), previewHash: preview.previewHash,
    capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt,
  });
  return context.previewAndExecute(IPC_CHANNELS.START_WORKFLOW, payload, args);
}

export const workflows: CommandDefinition[] = [
  { path: ["run", "preview"], description: "Preview a saved launch without admitting research or model work.", flags: [projectFlag, legacyFlag], channels: [IPC_CHANNELS.PREVIEW_WORKFLOW, APP_CHANNELS.PREVIEW_OPERATION], billing: "free", execute: (context, args) => launch(context, args, true) },
  { path: ["run", "start"], description: "Start Vibe or Controlled research after owner-issued preview consent.", flags: [projectFlag, legacyFlag, ...approvalFlags, { name: "client-command-id", type: "string", description: "Stable launch command ID; generated once when omitted." }], channels: [IPC_CHANNELS.PREVIEW_WORKFLOW, IPC_CHANNELS.START_WORKFLOW, IPC_CHANNELS.START_RESEARCH], billing: "paid", execute: (context, args) => launch(context, args, false) },
  ...(["approve", "regenerate", "edit"] as const).map((verb): CommandDefinition => ({
    path: ["run", "frame", verb], description: verb === "edit" ? "Save a new approved frame version for future research." : `${verb === "approve" ? "Approve" : "Regenerate"} the saved research frame through a paid proposal.`,
    positionals: runPosition, flags: [...sessionFlags, ...inputFlags, ...(verb === "edit" ? [] : approvalFlags)], channels: [IPC_CHANNELS.GET_WORKFLOW, IPC_CHANNELS.COMMAND_WORKFLOW],
    workflowActions: [verb === "approve" ? "approve-frame" : verb === "regenerate" ? "regenerate-frame" : "edit-approved-frame"], billing: verb === "edit" ? "free" : "paid",
    async execute(context, args) {
      const target = await workflowTarget(context, args, requirePositional(args, 0, `scraply run frame ${verb} <session>`));
      const saved = verb === "edit" ? target.detail.latestResearchFrame : target.detail.researchFrame;
      if (!saved) throw new CliError("INVALID_REFERENCE", "This workflow has no matching research frame.");
      const hasInput = booleanFlag(args, "stdin") || stringFlag(args, "file") !== undefined;
      if (verb === "edit" && !hasInput) throw new CliError("USAGE", "Supply edited frame JSON. Next command: scraply run frame edit <session> --file <frame.json>", 2);
      const frame = ResearchFrameSchema.parse(hasInput ? await context.readJson(args) : saved.draft);
      return workflowAction(context, args, target, { type: verb === "approve" ? "approve-frame" : verb === "regenerate" ? "regenerate-frame" : "edit-approved-frame", frameId: saved.id, frame });
    },
  })),
  { path: ["run", "extend"], description: "Preview and approve a larger allowance without rewriting the saved launch.", positionals: runPosition,
    flags: [...sessionFlags, ...approvalFlags, { name: "calls", type: "number", description: "Additional model calls." }, { name: "searches", type: "number", description: "Additional searches." }, { name: "minutes", type: "number", description: "Additional minutes." }],
    channels: [IPC_CHANNELS.PREVIEW_WORKFLOW, IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["extend-budget"], billing: "paid",
    async execute(context, args) {
      const target = await workflowTarget(context, args, requirePositional(args, 0, "scraply run extend <session> --calls <number>"));
      const extension = { additionalModelCalls: numberFlag(args, "calls") ?? 0, additionalSearches: numberFlag(args, "searches") ?? 0, additionalMinutes: numberFlag(args, "minutes") ?? 0 };
      const preview = PreviewWorkflowResultSchema.parse(await context.invoke(IPC_CHANNELS.PREVIEW_WORKFLOW, { type: "budget-extension", threadId: target.project.thread.id, sessionId: target.detail.summary.sessionId, expectedRevision: numberFlag(args, "revision") ?? target.detail.summary.revision, extension }));
      checkNativePreview(preview);
      return workflowAction(context, args, target, { type: "extend-budget", extension, previewHash: preview.previewHash, capabilityFingerprint: preview.capabilityFingerprint, previewExpiresAt: preview.expiresAt });
    },
  },
  { path: ["run", "retry"], description: "Retry one terminal task; unknown completion requires separate acknowledgment.", positionals: runPosition,
    flags: [...sessionFlags, ...approvalFlags, { name: "task", type: "string", required: true, description: "Failed or unknown task ID or unique prefix." }, { name: "terminal-attempt", type: "string", required: true, description: "Expected terminal attempt ID or unique prefix." }, { name: "acknowledge-unknown-completion", type: "boolean", description: "Explicitly acknowledge that the earlier provider completion is unknown." }],
    channels: [IPC_CHANNELS.GET_WORKFLOW, IPC_CHANNELS.COMMAND_WORKFLOW], workflowActions: ["retry-task"], billing: "paid",
    async execute(context, args) {
      const target = await workflowTarget(context, args, requirePositional(args, 0, "scraply run retry <session> --task <task> --terminal-attempt <attempt>"));
      const task = await context.resolve("task", requiredFlag(args, "task", "scraply run retry <session> --task <task> --terminal-attempt <attempt>"), target.project.thread.id);
      const attempt = await context.resolve("attempt", requiredFlag(args, "terminal-attempt", "scraply run retry <session> --task <task> --terminal-attempt <attempt>"), target.project.thread.id);
      return workflowAction(context, args, target, { type: "retry-task", taskId: task.id, expectedTerminalAttemptId: attempt.id, ...(booleanFlag(args, "acknowledge-unknown-completion") ? { acknowledgeUnknownCompletion: true } : {}) });
    },
  },
];

export function requiredFlag(args: CommandArguments, name: string, nextCommand: string) {
  const value = stringFlag(args, name);
  if (!value) throw new CliError("USAGE", `Missing --${name}. Next command: ${nextCommand}`, 2);
  return value;
}

/** This catalog contains both ID kinds. Never pass a session ID to a research trace or legacy cancel. */
async function runTarget(context: CommandContext, args: CommandArguments) {
  const reference = requirePositional(args, 0, "scraply run show <session-or-research-run>");
  const selector = stringFlag(args, "project");
  const project = selector ? await context.project(selector) : undefined;
  const catalog = ListRunsResultSchema.parse(await context.invoke(APP_CHANNELS.LIST_RUNS, project ? { threadId: project.thread.id } : {}));
  const eligible = catalog.runs.filter(run => !booleanFlag(args, "legacy") || run.kind === "research");
  const exact = eligible.filter(run => run.id === reference);
  const matches = exact.length ? exact : eligible.filter(run => run.id.startsWith(reference));
  if (matches.length !== 1) throw new CliError("INVALID_REFERENCE", matches.length ? "Run reference is ambiguous. Use a full session or research run ID." : "No saved run matches this reference.", 1, { candidates: matches.map(run => ({ id: run.id, kind: run.kind, threadId: run.threadId })) });
  const entry = matches[0]!;
  await context.resolve(entry.kind === "workflow" ? "workflow" : "run", entry.id, entry.threadId);
  return entry;
}

async function readRunState(context: CommandContext, entry: RunIndexEntry) {
  const catalog = ListRunsResultSchema.parse(await context.invoke(APP_CHANNELS.LIST_RUNS, { threadId: entry.threadId }));
  const current = catalog.runs.find(run => run.kind === entry.kind && run.id === entry.id);
  if (!current) throw new CliError("not_found", "The watched run no longer exists.");
  const sessionId = entry.sessionId;
  // A research ID stays scoped to that run. A workflow watches all of its associated research IDs.
  const runIds = new Set(entry.kind === "workflow"
    ? catalog.runs.filter(run => run.kind === "research" && run.sessionId === sessionId).map(run => run.id)
    : [entry.id]);
  if (current.kind === "workflow") {
    const detail = WorkflowDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId: current.sessionId }));
    for (const id of current.researchRunIds) runIds.add(id);
    return { state: detail.summary.state, outcome: detail.summary.outcome, runIds, end: ["finished", "paused", "waiting-for-review"].includes(detail.summary.state) };
  }
  const terminal = ["completed", "failed", "cancelled"].includes(current.status) || current.interrupted;
  // Legacy completion does not imply that the requested idea target was reached.
  return { state: current.interrupted ? "interrupted" : current.status, outcome: null, runIds, end: terminal };
}

async function watch(context: CommandContext, args: CommandArguments) {
  const entry = await runTarget(context, args);
  const sessionId = entry.kind === "workflow" ? entry.sessionId : null;
  let state = "unknown";
  let outcome: string | null = null;
  let ended = false;
  let reconnects = 0;
  context.stream.start();
  try {
    while (!ended) {
      context.signal.throwIfAborted();
      let runIds = new Set(entry.kind === "workflow" ? entry.researchRunIds : [entry.id]);
      const queued: ResearchEvent[] = [];
      let wake: (() => void) | undefined;
      const subscription = await context.subscribe(event => { queued.push(event); wake?.(); });
      let disconnected = false;
      let disconnectError: unknown;
      // Install this rejection handler immediately, including when initial reconciliation fails.
      void subscription.done.then(() => { disconnected = true; wake?.(); }, error => { disconnected = true; disconnectError = error; wake?.(); });
      try {
        const reconcile = async () => {
          const current = await readRunState(context, entry);
          state = current.state;
          outcome = current.outcome;
          runIds = current.runIds;
          ended = current.end;
        };
        // Subscription precedes every status reconciliation, including after a reconnect.
        await reconcile();
        while (!ended || queued.length) {
          while (queued.length) {
            const event = ResearchEventSchema.parse(queued.shift());
            if (event.threadId !== entry.threadId) continue;
            if ("sessionId" in event) {
              if (event.sessionId !== sessionId) continue;
              context.stream.write(event);
              await reconcile();
            } else if ("runId" in event) {
              if (!runIds.has(event.runId)) await reconcile();
              if (!runIds.has(event.runId)) continue;
              context.stream.write(event);
              if (["run-started", "run-resumed", "run-completed", "run-cancelled", "run-failed"].includes(event.type)) await reconcile();
            }
          }
          if (ended) break;
          if (disconnected) {
            context.signal.throwIfAborted();
            // A fast finish can be discovered even when the final event was lost.
            await reconcile();
            if (!ended && ++reconnects > 3) throw disconnectError ?? new CliError("backend_unavailable", "The watch stream disconnected repeatedly. The run continues; attach again with run watch.");
            break;
          }
          await new Promise<void>((resolve, reject) => {
            const abort = () => { cleanup(); reject(context.signal.reason as unknown); };
            const cleanup = () => { wake = undefined; context.signal.removeEventListener("abort", abort); };
            wake = () => { cleanup(); resolve(); };
            context.signal.addEventListener("abort", abort, { once: true });
            if (context.signal.aborted) abort();
            else if (queued.length || disconnected) wake();
          });
        }
      } finally {
        subscription.close();
      }
      if (!ended) await context.sleep(100);
    }
  } finally {
    context.stream.write({ type: "watch-end", state, outcome });
  }
  return null;
}

workflows.push(
  { path: ["run", "list"], description: "List workflow sessions and their distinct associated research run IDs.", flags: [projectFlag], channels: [APP_CHANNELS.LIST_RUNS], billing: "free",
    async execute(context, args) {
      const selector = stringFlag(args, "project");
      const project = selector ? await context.project(selector) : undefined;
      return ListRunsResultSchema.parse(await context.invoke(APP_CHANNELS.LIST_RUNS, project ? { threadId: project.thread.id } : {}));
    },
  },
  { path: ["run", "show"], description: "Read a saved session or research run; --all reads every workflow task page.", positionals: runPosition, flags: [projectFlag, legacyFlag, { name: "all", type: "boolean", description: "Read all task pages." }, { name: "cursor", type: "string", description: "Opaque task page cursor." }], channels: [APP_CHANNELS.LIST_RUNS, IPC_CHANNELS.GET_WORKFLOW, IPC_CHANNELS.GET_RUN_TRACE], billing: "free",
    async execute(context, args) {
      const entry = await runTarget(context, args);
      if (entry.kind === "research") {
        const project = await context.project(entry.threadId);
        return { run: entry, progress: project.workspace.latestResearchRun?.runId === entry.runId ? project.workspace.latestResearchRun : null, trace: RunTraceSchema.parse(await context.invoke(IPC_CHANNELS.GET_RUN_TRACE, { runId: entry.runId })) };
      }
      const cursor = stringFlag(args, "cursor");
      const detail = WorkflowDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId: entry.sessionId, ...(cursor ? { cursor } : {}) }));
      return booleanFlag(args, "all") ? workflowPages(context, detail) : detail;
    },
  },
  { path: ["run", "watch"], description: "Stream this session's ResearchEvents until finish, pause, or review. Ctrl+C and timeout detach only.", positionals: runPosition, flags: [projectFlag, legacyFlag], channels: [APP_CHANNELS.LIST_RUNS, IPC_CHANNELS.GET_WORKFLOW, IPC_CHANNELS.BACKEND_EVENT], billing: "free", execute: watch },
  ...(["pause", "resume", "stop", "cancel"] as const).map((verb): CommandDefinition => ({
    path: ["run", verb], description: verb === "resume" ? "Resume a saved run through paid preview consent without replaying unknown completions." : `${verb === "pause" ? "Pause" : "Stop"} the run through its normal saved-state path.`,
    positionals: runPosition, flags: [...sessionFlags, legacyFlag, { name: "reason", type: "string", description: "Optional reason saved with a workflow command." }, ...(verb === "resume" ? approvalFlags : [])],
    channels: [IPC_CHANNELS.COMMAND_WORKFLOW, ...(verb === "resume" ? [IPC_CHANNELS.RESUME_RESEARCH] : verb === "cancel" || verb === "stop" ? [IPC_CHANNELS.CANCEL_RESEARCH] : [])], workflowActions: [verb === "cancel" ? "stop" : verb], billing: verb === "resume" ? "paid" : "free",
    async execute(context, args) {
      const entry = await runTarget(context, args);
      const sessionId = booleanFlag(args, "legacy") ? null : entry.sessionId;
      if (!sessionId) {
        if (entry.kind !== "research") throw new CliError("INVALID_REFERENCE", "Choose a legacy research run ID.");
        if (verb === "pause") throw new CliError("USAGE", "Legacy research cannot pause. Use scraply run cancel <research-run> --legacy.", 2);
        return verb === "resume" ? context.previewAndExecute(IPC_CHANNELS.RESUME_RESEARCH, { runId: entry.runId }, args) : context.invoke(IPC_CHANNELS.CANCEL_RESEARCH, { runId: entry.runId });
      }
      const target = await workflowTarget(context, args, sessionId);
      const reason = stringFlag(args, "reason");
      return workflowAction(context, args, target, { type: verb === "cancel" ? "stop" : verb, ...(reason ? { reason } : {}) });
    },
  })),
  { path: ["run", "trace"], description: "Read research traces. A session expands to its actual associated research runs.", positionals: runPosition,
    flags: [projectFlag, legacyFlag, { name: "research-run", type: "string", description: "Choose one associated research run when addressing a session." }, { name: "step", type: "string", description: "Trace step ID or unique prefix; requires a single research run." }, { name: "all", type: "boolean", description: "Load every trace step's saved inputs and output." }, { name: "tasks", type: "boolean", description: "Include all workflow task pages for a session trace." }],
    channels: [APP_CHANNELS.LIST_RUNS, IPC_CHANNELS.GET_RUN_TRACE, IPC_CHANNELS.GET_RUN_TRACE_STEP, IPC_CHANNELS.GET_WORKFLOW], billing: "free",
    async execute(context, args) {
      const entry = await runTarget(context, args);
      const selected = stringFlag(args, "research-run");
      const ids = entry.kind === "workflow" ? entry.researchRunIds : [entry.runId];
      const requestedId = selected ? (await context.resolve("run", selected, entry.threadId)).id : undefined;
      if (requestedId && !ids.includes(requestedId)) throw new CliError("INVALID_REFERENCE", "This research run does not belong to the addressed session.");
      const runIds = requestedId ? [requestedId] : ids;
      const stepReference = stringFlag(args, "step");
      if (stepReference && runIds.length !== 1) throw new CliError("USAGE", "Choose a research run for the step. Next command: scraply run trace <session> --research-run <research-run> --step <step>", 2);
      const traces = [];
      for (const runId of runIds) {
        const trace = RunTraceSchema.parse(await context.invoke(IPC_CHANNELS.GET_RUN_TRACE, { runId }));
        if (stepReference) {
          const exact = trace.steps.filter(step => step.id === stepReference);
          const matches = exact.length ? exact : trace.steps.filter(step => step.id.startsWith(stepReference));
          if (matches.length !== 1) throw new CliError("INVALID_REFERENCE", "The trace step reference is missing or ambiguous.", 1, { candidates: matches.map(step => step.id) });
          return RunTraceStepDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_RUN_TRACE_STEP, { runId, stepId: matches[0]!.id }));
        }
        if (booleanFlag(args, "all")) {
          const details = [];
          for (const step of trace.steps) details.push(RunTraceStepDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_RUN_TRACE_STEP, { runId, stepId: step.id })));
          traces.push({ ...trace, stepDetails: details });
        } else traces.push(trace);
      }
      if (entry.kind === "research") return traces[0];
      const tasks = booleanFlag(args, "tasks") ? await workflowPages(context, WorkflowDetailSchema.parse(await context.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId: entry.sessionId }))) : undefined;
      return { sessionId: entry.sessionId, traces, ...(tasks ? { workflow: tasks } : {}) };
    },
  },
);
