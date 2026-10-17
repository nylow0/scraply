import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppErrorPayloadSchema, IPC_CHANNELS, ResearchEventSchema, SaveSearchKeySchema, WorkspaceStateSchema, type ResearchEvent, type WorkspaceState } from "../shared/ipc";
import { canonicalJson } from "../shared/content-identity";
import type { ModelRef, Thread } from "../shared/schemas";
import { ModelRefSchema, ReasoningEffortSchema } from "../shared/schemas";
import type { WorkflowLaunchDraft } from "../shared/workflow-contracts";
import type { CommandArguments } from "./args";
import { booleanFlag, stringFlag } from "./args";
import { CliError, createStreamWriter } from "./output";
import {
  APP_CHANNELS, appControlRegistry, operationRegistry, OperationProposalSchema, ExecuteOperationResultSchema,
  GetProjectResultSchema, ResolveEntityResultSchema, isBillableOperation, isBoxedOperation,
  SearchKeyCredentialReferenceSchema,
  type EntityKind,
} from "../shared/cli-contracts";

export type { EntityKind } from "../shared/cli-contracts";

export interface ProjectContext {
  thread: Thread;
  workspace: WorkspaceState;
  launchSettings: unknown;
  draft: WorkflowLaunchDraft | null;
}

export interface ResolvedEntity {
  kind: EntityKind;
  id: string;
  threadId?: string;
  candidates: unknown[];
}

export interface EventSubscription {
  close(): void;
  done: Promise<void>;
}

export interface CommandContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly stream: { start(): void; write(value: unknown): void; readonly started: boolean };
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  previewAndExecute(channel: string, payload: unknown, args: CommandArguments): Promise<unknown>;
  workspace(): Promise<WorkspaceState>;
  project(selector?: string): Promise<ProjectContext>;
  resolve(kind: EntityKind, reference: string, threadId?: string): Promise<ResolvedEntity>;
  model(args: CommandArguments, workspace?: WorkspaceState): Promise<{ model: ModelRef; reasoningEffort: string }>;
  readJson(args: CommandArguments): Promise<unknown>;
  readStdin(): Promise<string>;
  openExternal(url: string): Promise<void>;
  subscribe(listener: (event: ResearchEvent) => void): Promise<EventSubscription>;
  sleep(milliseconds: number): Promise<void>;
  system(action: "paths" | "host-status" | "host-stop" | "setup", args: CommandArguments): Promise<unknown>;
}

export interface ContextDependencies {
  commandPath?: readonly string[];
  signal: AbortSignal;
  deadline: number;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  subscribe(listener: (event: ResearchEvent) => void, signal: AbortSignal): Promise<EventSubscription>;
  readStdin(): Promise<string>;
  write(text: string): void;
  openExternal(url: string): Promise<void>;
  system: CommandContext["system"];
}

const boxedResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorPayloadSchema }).strict(),
]);

/** Only the detached owner touches the database. Context validates every request and service result. */
export function createCommandContext(dependencies: ContextDependencies): CommandContext {
  const definitions = { ...operationRegistry, ...appControlRegistry };
  const stream = createStreamWriter(dependencies.write);
  let stdin: Promise<string> | undefined;

  async function request(channel: string, payload?: unknown): Promise<unknown> {
    dependencies.signal.throwIfAborted();
    const definition = definitions[channel as keyof typeof definitions];
    if (!definition) throw new CliError("USAGE", "Unknown app operation.", 2);
    const normalized = definition.request.parse(payload);
    let result = await abortable(dependencies.invoke(channel, normalized), dependencies.signal);
    if (isBoxedOperation(channel)) {
      const parsed = boxedResult.safeParse(result);
      if (!parsed.success) throw new CliError("INVALID_RESPONSE", "The owner returned an invalid response envelope.");
      if (!parsed.data.ok) {
        const error = parsed.data.error;
        throw new CliError(error.code, error.message, 1, error.recovery, error.reference);
      }
      result = parsed.data.data;
    }
    const parsed = definition.result.safeParse(result);
    if (!parsed.success) throw new CliError("INVALID_RESPONSE", `The owner returned invalid data for ${channel}.`);
    return parsed.data;
  }

  const context: CommandContext = {
    signal: dependencies.signal, deadline: dependencies.deadline, stream,
    async invoke(channel, payload) {
      if (channel !== APP_CHANNELS.PREVIEW_OPERATION && channel !== APP_CHANNELS.EXECUTE_OPERATION && isBillableOperation(channel, payload)) {
        throw new CliError("NEEDS_CONFIRMATION", "This operation requires an owner preview and explicit --yes.", 3);
      }
      return request(channel, payload);
    },
    async previewAndExecute(channel, payload, args) {
      if (!isBillableOperation(channel, payload)) return request(channel, payload);
      const file = stringFlag(args, "preview-file");
      const secret = operationRegistry[channel]!.secretInput;
      if (secret && file) throw new CliError("USAGE", "Saved key proposals cannot be matched to stdin here. Next command: scraply key set <provider> --stdin --yes", 2);
      const proposal = file
        ? OperationProposalSchema.parse(await parseJsonFile(file))
        : OperationProposalSchema.parse(await request(APP_CHANNELS.PREVIEW_OPERATION, { channel, payload }));
      if (proposal.operation.channel !== channel) throw new CliError("USAGE", "The preview file belongs to another command.", 2);
      if (secret) {
        const requested = SaveSearchKeySchema.parse(payload);
        const bound = SearchKeyCredentialReferenceSchema.parse(proposal.operation.payload);
        if (bound.provider !== requested.provider) throw new CliError("INVALID_RESPONSE", "The owner returned a key proposal for another provider.");
      } else {
        const normalized = operationRegistry[channel]!.request.parse(payload);
        if (canonicalJson(normalized) !== canonicalJson(proposal.operation.payload)) throw new CliError("USAGE", "The preview payload differs from this command. Use the exact original arguments or request a fresh preview.", 2);
      }
      if (!booleanFlag(args, "yes")) throw new CliError("NEEDS_CONFIRMATION", "Review this proposal, then repeat this command with --yes to approve its current operation.", 3, { preview: proposal });
      const executed = ExecuteOperationResultSchema.parse(await request(APP_CHANNELS.EXECUTE_OPERATION, { proposal }));
      if (executed.channel !== channel) throw new CliError("INVALID_RESPONSE", "The owner returned another operation's result.");
      const parsed = operationRegistry[channel]!.result.safeParse(executed.result);
      if (!parsed.success) throw new CliError("INVALID_RESPONSE", `The owner returned invalid data for ${channel}.`);
      return parsed.data;
    },
    async workspace() { return WorkspaceStateSchema.parse(await request(IPC_CHANNELS.GET_WORKSPACE)); },
    async project(selector) {
      let reference = selector;
      if (!reference) {
        const workspace = await context.workspace();
        reference = workspace.activeThreadId ?? undefined;
      }
      if (!reference) throw new CliError("USAGE", "No project is selected. Next command: scraply project create --title \"Example project\"", 2);
      return GetProjectResultSchema.parse(await request(APP_CHANNELS.GET_PROJECT, { threadId: reference }));
    },
    async resolve(kind, reference, threadId) {
      return ResolveEntityResultSchema.parse(await request(APP_CHANNELS.RESOLVE_ENTITY, { kind, reference, ...(threadId ? { threadId } : {}) }));
    },
    async model(args, workspace) {
      const state = workspace ?? (await context.project(stringFlag(args, "project"))).workspace;
      const reference = stringFlag(args, "model");
      const split = reference?.indexOf(":") ?? -1;
      const model = reference ? ModelRefSchema.parse({ providerId: reference.slice(0, split), modelId: split < 0 ? "" : reference.slice(split + 1) }) : state.runConfig?.model;
      const reasoningEffort = stringFlag(args, "effort") ?? state.runConfig?.reasoningEffort;
      if (!model || !reasoningEffort) throw new CliError("USAGE", "A saved model and effort are required. Next command: scraply config set --model openai-subscription:gpt-6.1-sol --effort high", 2);
      return { model, reasoningEffort: ReasoningEffortSchema.parse(reasoningEffort) };
    },
    async readJson(args) {
      const file = stringFlag(args, "file");
      const fromStdin = booleanFlag(args, "stdin");
      if (Boolean(file) === fromStdin) {
        const command = ["scraply", ...(dependencies.commandPath ?? ["brief", "set"])].join(" ");
        throw new CliError("USAGE", `Choose exactly one JSON input. Next command: ${command} --stdin or ${command} --file <path>`, 2);
      }
      return file ? parseJsonFile(file) : parseJson(await context.readStdin());
    },
    readStdin() { stdin ??= abortable(dependencies.readStdin(), dependencies.signal); return stdin; },
    async openExternal(url) {
      const parsed = z.string().url().refine(value => new URL(value).protocol === "https:", "Only HTTPS authorization URLs can be opened.").parse(url);
      await abortable(dependencies.openExternal(parsed), dependencies.signal);
    },
    async subscribe(listener) {
      return abortable(dependencies.subscribe(event => listener(ResearchEventSchema.parse(event)), dependencies.signal), dependencies.signal);
    },
    async sleep(milliseconds) { await delay(milliseconds, undefined, { signal: dependencies.signal }); },
    system: dependencies.system,
  };
  return context;
}

async function parseJsonFile(file: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new CliError("USAGE", "Cannot read the JSON input file. Check --file or --preview-file.", 2); }
  return parseJson(text);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown; }
  catch { throw new CliError("USAGE", "Input must be one complete JSON document.", 2); }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => { reject(signal.reason as unknown); };
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (listener) signal.removeEventListener("abort", listener); }
}
