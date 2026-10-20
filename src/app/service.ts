import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  ReviewSavedOpportunitiesSchema, EditOpportunityMembershipSchema, RequestFocusedExperimentSchema,
  OpportunityExplorationActionSchema, PreviewOpportunityExtensionSchema, ApplyOpportunityExtensionSchema,
  CancelResearchSchema, DiscardIdeaRequestSchema, ArchiveThreadRequestSchema, GenerateTitleRequestSchema,
  GenerateTitleResultSchema, CreateThreadRequestSchema, DeleteThreadRequestSchema,
  EvidenceFollowUpRequestSchema, EvidenceReassessmentRequestSchema, ExportIdeasRequestSchema,
  ExportResearchRequestSchema, GetIdeaDetailRequestSchema, GetSourceDetailRequestSchema, IPC_CHANNELS,
  NativeLoginCancelSchema, NativeLoginCompleteSchema, NativeLoginLaunchSchema, NativeLoginStartSchema,
  NativeProviderSchema, RemoveSearchKeySchema, ResumeResearchSchema, SaveFavoriteModelSchema,
  SaveRunConfigSchema, SaveScopeSchema, SaveSearchKeySchema, SearchKeyPreflightResultSchema,
  SelectProblemsSchema, SelectOptionSchema, SaveDecisionSchema, SelectThreadRequestSchema,
  StartResearchSchema, type ValidationState, type WorkspaceState, type ResearchEvent,
} from "../shared/ipc";
import {
  PreviewWorkflowRequestSchema, PreviewWorkflowResultSchema, StartWorkflowRequestSchema,
  WorkflowAdmissionReceiptSchema, GetWorkflowRequestSchema, WorkflowDetailSchema,
  CommandWorkflowRequestSchema, GetIdeaConversationRequestSchema, SelectIdeaVersionRequestSchema,
  IdeaConversationSchema, SubmitIdeaTurnRequestSchema, SubmitIdeaTurnResultSchema,
} from "../shared/workflow-contracts";
import { GetRunTraceRequestSchema, GetRunTraceStepRequestSchema, RunTraceSchema, RunTraceStepDetailSchema } from "../shared/run-trace";
import { configuredProviderSecretsAreValid, type BackendSecrets } from "../shared/backend-process";
import { AppError, toErrorPayload } from "../shared/errors";
import { bundleBrowserIdeaExport } from "../shared/browser-export";
import { AppSettingsSchema } from "../shared/app-settings";
import {
  APP_CHANNELS, ActivitySchema, ExecuteOperationRequestSchema, PreviewOperationRequestSchema,
  ProviderStatusResultSchema, isBillableOperation,
} from "../shared/cli-contracts";
import { createAppOperationHandlers } from "./operations";
import { writeUniqueExportFile } from "./export-file";
import { createServiceBilling, isServiceBillingChannel } from "./service-billing";
import { revokeNativeAccount } from "../main/native-account";
import { parseExternalHttpsUrl } from "../main/security";
import type { SearchProvider } from "../providers/search";
import {
  AppInvocationOptionsSchema, type AppInvocationOptions, type AppRequestHandler, type AppServiceOptions,
  type AppServiceStartOptions,
} from "./service-contracts";

const SEARCH_KEYS = {
  exa: { field: "exaApiKey", name: "Exa", variable: "EXA_API_KEY" },
  perplexity: { field: "perplexityApiKey", name: "Perplexity", variable: "PERPLEXITY_API_KEY" },
} as const satisfies Record<SearchProvider, { field: keyof BackendSecrets; name: string; variable: string }>;

const ExportFileSchema = z.object({ filename: z.string(), content: z.string() });
const IdeaExportSchema = z.object({ filename: z.string(), files: z.array(ExportFileSchema) });
type Invocation = z.output<typeof AppInvocationOptionsSchema>;
const ACCOUNT_MUTATION_CHANNELS = new Set<string>([
  IPC_CHANNELS.NATIVE_LOGIN_START, IPC_CHANNELS.NATIVE_LOGIN_COMPLETE,
  IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, IPC_CHANNELS.NATIVE_LOGOUT,
]);

/** Portable application handlers. Local UI effects require explicit invocation options. */
export function createAppService(options: AppServiceOptions) {
  const { backend, credentialStore, paths } = options;
  let secrets: BackendSecrets = { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} };
  let initialized = false;
  let closing = false;
  let credentialLoadFailure: string | null = null;
  let automaticSecrets: Partial<BackendSecrets> = {};
  let searchKeyChangeInProgress = false;
  let credentialActionsInProgress = 0;
  let completingNativeLoginId: string | null = null;
  // Completion can still be in flight after the backend has signed in. Retain
  // only the latest identity so an obsolete cancel cannot erase its replacement.
  const currentNativeLogins = new Map<string, string>();
  let credentialWriteTail = Promise.resolve();
  let validateAutomaticSecretsOnStart = true;
  let credentialRevision = 0;
  const blockedProviderCredentialWrites = new Set<string>();
  const operations = new Map<string, (body: unknown, invocation: Invocation) => unknown>();

  function readAutomaticSecrets(): Partial<BackendSecrets> {
    const candidate: Partial<BackendSecrets> = {};
    const environment = options.automaticSecrets?.environment ?? process.env;
    const environmentKey = environment.EXA_API_KEY?.trim();
    if (environmentKey) candidate.exaApiKey = environmentKey;
    const perplexityEnvironmentKey = environment.PERPLEXITY_API_KEY?.trim();
    if (perplexityEnvironmentKey) candidate.perplexityApiKey = perplexityEnvironmentKey;
    const envPath = options.automaticSecrets?.envFile;
    if (!envPath || !existsSync(envPath)) return candidate;
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key === "EXA_API_KEY" && value) candidate.exaApiKey = value;
      if (key === "PERPLEXITY_API_KEY" && value) candidate.perplexityApiKey = value;
    }
    return candidate;
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;
    try { secrets = credentialStore.load(); }
    catch (error) {
      credentialLoadFailure = error instanceof Error ? error.message : "Saved credentials could not be read.";
    }
    automaticSecrets = readAutomaticSecrets();
    secrets = { ...secrets, ...automaticSecrets };
  }

  function publishEvent(event: ResearchEvent): void {
    options.publishEvent?.(event);
  }

  function enqueueCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = credentialWriteTail.then(operation);
    credentialWriteTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  // Calculate patches only after earlier writes finish. Provider callbacks may acknowledge
  // rotations during a key probe; the later key commit must retain those accepted values.
  function saveCredentialChange(
    update: (current: BackendSecrets) => BackendSecrets,
    hooks: {
      beforeSave?: (candidate: BackendSecrets) => Promise<void>;
      beforeWrite?: () => void;
      retainOnFailure?: boolean;
    } = {},
  ): Promise<BackendSecrets> {
    return enqueueCredentialOperation(async () => {
      const candidate = update(structuredClone(secrets));
      const expectedRevision = credentialRevision;
      hooks.beforeWrite?.();
      await hooks.beforeSave?.(candidate);
      try {
        const persisted = await credentialStore.save(candidate, () => {
          hooks.beforeWrite?.();
          if (credentialRevision !== expectedRevision) {
            throw new AppError("conflict", "Credentials changed before this update could be saved. Try again.");
          }
        });
        secrets = persisted;
        credentialRevision += 1;
        return persisted;
      } catch (error) {
        // A failed disk removal still revokes the in-memory account and late callbacks.
        if (hooks.retainOnFailure) { secrets = update(structuredClone(secrets)); credentialRevision += 1; }
        throw error;
      }
    });
  }

  async function withCredentialAction<T>(operation: () => Promise<T>, cancelLoginId?: string): Promise<T> {
    const cancelsActiveLogin = cancelLoginId !== undefined && cancelLoginId === completingNativeLoginId
      && credentialActionsInProgress === 1;
    if (searchKeyChangeInProgress || (credentialActionsInProgress > 0 && !cancelsActiveLogin)) {
      throw new AppError("conflict", "Credentials are being updated. Try again in a moment.");
    }
    // A single matching cancel can interrupt completion. Both retain key exclusion until
    // they settle, and claiming the interruption prevents a second overlapping cancel.
    if (cancelsActiveLogin) completingNativeLoginId = null;
    credentialActionsInProgress += 1;
    try { return await operation(); }
    finally { credentialActionsInProgress -= 1; }
  }

  async function persistProviderCredential(providerId: string, credential: string): Promise<void> {
    initialize();
    const assertAllowed = () => {
      if (blockedProviderCredentialWrites.has(providerId)) {
        throw new Error("The account was signed out before this credential could be saved");
      }
    };
    assertAllowed();
    try {
      await saveCredentialChange(current => ({
        ...current, providerCredentials: { ...current.providerCredentials, [providerId]: credential },
      }), { beforeWrite: assertAllowed });
    } catch (error) {
      blockedProviderCredentialWrites.add(providerId);
      throw error;
    }
  }

  async function ensureBackend(): Promise<void> {
    if (closing) throw new AppError("backend_unavailable", "Scraply is closing.");
    initialize();
    if (credentialLoadFailure) throw new AppError("backend_unavailable", credentialLoadFailure);
    await backend.start({ paths, appVersion: options.appVersion, secrets,
      validateAutomaticSecrets: validateAutomaticSecretsOnStart, persistProviderCredential, publishEvent });
    if (closing) throw new AppError("backend_unavailable", "Scraply is closing.");
  }

  async function backendRequest<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    try { await ensureBackend(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("backend_unavailable", error instanceof Error ? error.message : "The local backend is unavailable.");
    }
    return await backend.request(path, init) as T;
  }

  const post = <T>(path: string, body: T) => backendRequest(path, { method: "POST", body: JSON.stringify(body) });
  // Preserve Electron/preload compatibility. Only these workflow and key handlers box errors;
  // the other handlers return plain values and throw, for the transport to serialize once.
  const workflow = async <T>(operation: () => Promise<T>) => {
    try { return { ok: true as const, data: await operation() }; }
    catch (error) { return { ok: false as const, error: toErrorPayload(error).error }; }
  };

  async function validateAndPersistSecrets(keys: Pick<BackendSecrets, "exaApiKey" | "perplexityApiKey">): Promise<ValidationState> {
    await enqueueCredentialOperation(() => backend.updateSecrets({ ...secrets, ...keys }));
    try {
      const validation = await backendRequest<ValidationState>("/validation");
      if (!validation.setupComplete || !configuredProviderSecretsAreValid(keys, validation)) {
        await enqueueCredentialOperation(() => backend.updateSecrets(secrets));
        return validation;
      }
      await saveCredentialChange(current => ({ ...current, ...keys }), { beforeSave: candidate => backend.updateSecrets(candidate) });
      return validation;
    } catch (error) {
      await enqueueCredentialOperation(() => backend.updateSecrets(secrets)).catch(() => undefined);
      throw error;
    }
  }

  async function retryAutomaticConnection(): Promise<void> {
    return withCredentialAction(async () => {
      initialize();
      if (credentialLoadFailure) {
        await enqueueCredentialOperation(async () => {
          secrets = credentialStore.load();
          credentialRevision += 1;
          credentialLoadFailure = null;
        });
      }
      const automatic = readAutomaticSecrets();
      const keys = {
        exaApiKey: automatic.exaApiKey ?? secrets.exaApiKey,
        perplexityApiKey: automatic.perplexityApiKey ?? secrets.perplexityApiKey,
      };
      if (!backend.isReady()) {
        await backend.stop();
        await enqueueCredentialOperation(async () => { secrets = { ...secrets, ...keys }; credentialRevision += 1; });
        await ensureBackend();
      }
      await validateAndPersistSecrets(keys);
      await post("/native/retry", {});
    });
  }

  // The backend reserves an idle moment through the encrypted write. A rejected key never
  // reaches disk; environment and development .env keys cannot be changed by a caller.
  async function changeSearchKey(provider: SearchProvider, apiKey: string | null, confirmedProbe = false): Promise<WorkspaceState> {
    if (searchKeyChangeInProgress) throw new AppError("conflict", "A search key is being updated. Try again in a moment.");
    if (credentialActionsInProgress > 0) throw new AppError("conflict", "Credentials are being updated. Try again in a moment.");
    searchKeyChangeInProgress = true;
    try {
      const { field, name, variable } = SEARCH_KEYS[provider];
      if (readAutomaticSecrets()[field]) {
        throw new AppError("conflict", `This ${name} key comes from ${variable} in the environment or .env file. Change it there, then retry connections.`);
      }
      if (confirmedProbe && apiKey) {
        await ensureBackend();
        let reserved = false;
        let persisted = false;
        try {
          // Hold the idle reservation through the paid check and write. No run can
          // start after the check and make its cost an unwanted, rejected key update.
          await enqueueCredentialOperation(() => backend.updateSecrets(secrets, true));
          reserved = true;
          const check = SearchKeyPreflightResultSchema.parse(await post("/search-keys/validate-reserved", { provider, apiKey }));
          if (!check.valid) throw new AppError("validation_error", check.error ?? `${name} did not accept this key.`);
          await saveCredentialChange(current => ({ ...current, [field]: apiKey }), { beforeSave: candidate => backend.updateSecrets(candidate) });
          persisted = true;
          await enqueueCredentialOperation(() => backend.finishSearchKeyUpdate());
          reserved = false;
        } catch (error) {
          if (reserved) await enqueueCredentialOperation(() => backend.finishSearchKeyUpdate(persisted ? undefined : secrets));
          throw error;
        }
        // Applying the key invalidates cached provider checks. Return pending status;
        // do not spend on another search for this key or for unrelated providers.
        return backendRequest<WorkspaceState>("/workspace");
      }
      const check = SearchKeyPreflightResultSchema.parse(await post("/search-keys/preflight", { provider, apiKey }));
      if (!check.valid) throw new AppError("validation_error", check.error ?? `${name} did not accept this key.`);
      let reserved = false;
      let persisted = false;
      try {
        await saveCredentialChange(current => ({ ...current, [field]: apiKey }), { beforeSave: async candidate => {
          await backend.updateSecrets(candidate, true);
          reserved = true;
        } });
        persisted = true;
        await enqueueCredentialOperation(() => backend.finishSearchKeyUpdate());
        reserved = false;
      } catch (cause) {
        if (reserved) await enqueueCredentialOperation(() => backend.finishSearchKeyUpdate(persisted ? undefined : secrets));
        throw cause;
      }
      // Preserve GUI save validation. A removal cannot justify searching with other keys.
      if (apiKey) await backendRequest("/validation");
      return backendRequest<WorkspaceState>("/workspace");
    } finally {
      searchKeyChangeInProgress = false;
    }
  }

  const serviceBilling = createServiceBilling({
    capabilities: async () => credentialLoadFailure
      ? { appVersion: options.appVersion, credentialLoadFailure }
      : ProviderStatusResultSchema.parse(await backendRequest("/app/provider-status")),
    privateState: () => ({ paths, appVersion: options.appVersion, credentialRevision, secrets,
      automatic: readAutomaticSecrets(), blockedProviders: [...blockedProviderCredentialWrites].sort() }),
    async validate(channel, key) {
      if (credentialLoadFailure && channel !== IPC_CHANNELS.RETRY_CONNECTION) {
        throw new AppError("backend_unavailable", credentialLoadFailure);
      }
      if (!key) return;
      if (searchKeyChangeInProgress) throw new AppError("conflict", "A search key is being updated. Try again in a moment.");
      if (credentialActionsInProgress > 0) throw new AppError("conflict", "Credentials are being updated. Try again in a moment.");
      const { field, name, variable } = SEARCH_KEYS[key.provider];
      if (readAutomaticSecrets()[field]) {
        throw new AppError("conflict", `This ${name} key comes from ${variable} in the environment or .env file. Change it there, then retry connections.`);
      }
      if (ActivitySchema.parse(await backendRequest("/app/activity")).active) {
        throw new AppError("conflict", "Search keys can't change while research is running. Wait for it to finish or cancel it, then try again.");
      }
    },
    async dispatch(channel, payload) {
      if (channel === IPC_CHANNELS.GET_VALIDATION) return backendRequest("/validation");
      if (channel === IPC_CHANNELS.RETRY_CONNECTION) return retryAutomaticConnection();
      const { provider, apiKey } = SaveSearchKeySchema.parse(payload);
      return changeSearchKey(provider, apiKey, true);
    },
  });

  function handle(channel: string, operation: (body: unknown, invocation: Invocation) => unknown): void {
    operations.set(channel, operation);
  }

  handle(IPC_CHANNELS.PREVIEW_WORKFLOW, (body) => workflow(async () =>
    PreviewWorkflowResultSchema.parse(await post("/workflows/preview", PreviewWorkflowRequestSchema.parse(body)))));
  handle(IPC_CHANNELS.START_WORKFLOW, (body) => workflow(async () =>
    WorkflowAdmissionReceiptSchema.parse(await post("/workflows/start", StartWorkflowRequestSchema.parse(body)))));
  handle(IPC_CHANNELS.GET_WORKFLOW, (body) => workflow(async () => {
    const { sessionId, cursor } = GetWorkflowRequestSchema.parse(body);
    const path = `/workflows/${encodeURIComponent(sessionId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    return WorkflowDetailSchema.parse(await backendRequest(path));
  }));
  handle(IPC_CHANNELS.GET_RUN_TRACE, (body) => workflow(async () => {
    const { runId } = GetRunTraceRequestSchema.parse(body);
    return RunTraceSchema.parse(await backendRequest(`/runs/${encodeURIComponent(runId)}/trace`));
  }));
  handle(IPC_CHANNELS.GET_RUN_TRACE_STEP, (body) => workflow(async () => {
    const { runId, stepId } = GetRunTraceStepRequestSchema.parse(body);
    return RunTraceStepDetailSchema.parse(await backendRequest(`/runs/${encodeURIComponent(runId)}/trace/steps/${encodeURIComponent(stepId)}`));
  }));
  handle(IPC_CHANNELS.COMMAND_WORKFLOW, (body) => workflow(async () =>
    WorkflowAdmissionReceiptSchema.parse(await post("/workflows/command", CommandWorkflowRequestSchema.parse(body)))));
  handle(IPC_CHANNELS.GET_IDEA_CONVERSATION, (body) => workflow(async () => {
    const { ideaId, branchId, cursor } = GetIdeaConversationRequestSchema.parse(body);
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (cursor) params.set("cursor", cursor);
    const query = params.size ? `?${params}` : "";
    return IdeaConversationSchema.parse(await backendRequest(`/ideas/${encodeURIComponent(ideaId)}/conversation${query}`));
  }));
  handle(IPC_CHANNELS.SELECT_IDEA_VERSION, (body) => workflow(async () =>
    IdeaConversationSchema.parse(await post("/ideas/select-version", SelectIdeaVersionRequestSchema.parse(body)))));
  handle(IPC_CHANNELS.SUBMIT_IDEA_TURN, (body) => workflow(async () =>
    SubmitIdeaTurnResultSchema.parse(await post("/ideas/turn", SubmitIdeaTurnRequestSchema.parse(body)))));
  handle(IPC_CHANNELS.GET_VALIDATION, () => backendRequest("/validation"));
  handle(IPC_CHANNELS.RETRY_CONNECTION, retryAutomaticConnection);
  handle(IPC_CHANNELS.GET_WORKSPACE, () => backendRequest("/workspace"));
  handle(IPC_CHANNELS.GET_ADVANCED_SETTINGS, () => backendRequest("/settings/advanced"));
  handle(IPC_CHANNELS.SAVE_ADVANCED_SETTINGS, (body) => post("/settings/advanced", AppSettingsSchema.parse(body)));
  handle(IPC_CHANNELS.OPEN_DATA_FOLDER, async (_body, invocation) => {
    if (!invocation.revealPaths) return { path: paths.dataDir };
    if (!options.revealPath) throw new AppError("backend_unavailable");
    await options.revealPath(paths.dataDir);
  });
  handle(IPC_CHANNELS.OPEN_LOGS_FOLDER, async (_body, invocation) => {
    if (!invocation.revealPaths) return { path: paths.logsDir };
    if (!options.revealPath) throw new AppError("backend_unavailable");
    await options.revealPath(paths.logsDir);
  });
  handle(IPC_CHANNELS.CREATE_THREAD, (body) => post("/threads", CreateThreadRequestSchema.parse(body ?? {})));
  handle(IPC_CHANNELS.SELECT_THREAD, (body) => post("/threads/select", SelectThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.DISCARD_IDEA, (body) => post("/ideas/discard", DiscardIdeaRequestSchema.parse(body)));
  handle(IPC_CHANNELS.ARCHIVE_THREAD, (body) => post("/threads/archive", ArchiveThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.GENERATE_TITLE, async (body) => GenerateTitleResultSchema.parse(await post("/threads/title", GenerateTitleRequestSchema.parse(body))));
  handle(IPC_CHANNELS.DELETE_THREAD, (body) => post("/threads/delete", DeleteThreadRequestSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_SCOPE, (body) => post("/scope", SaveScopeSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_RUN_CONFIG, (body) => post("/run-config", SaveRunConfigSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_FAVORITE_MODEL, (body) => post("/models/favorite", SaveFavoriteModelSchema.parse(body)));
  handle(IPC_CHANNELS.NATIVE_LOGIN_START, async (body, invocation) => {
    const input = NativeLoginStartSchema.parse(body);
    blockedProviderCredentialWrites.delete(input.providerId);
    const launch = NativeLoginLaunchSchema.parse(await post("/native/login/start", input));
    currentNativeLogins.set(input.providerId, launch.loginId);
    const authorizationUrl = launch.method === "device" ? launch.verificationUrl : launch.authorizationUrl;
    const url = parseExternalHttpsUrl({ url: authorizationUrl });
    if (!invocation.openBrowser) return launch;
    if (!options.openExternal) throw new AppError("backend_unavailable");
    await options.openExternal(url);
    return {
      loginId: launch.loginId, providerId: launch.providerId, method: launch.method,
      ...(launch.method === "device" ? { verificationUrl: launch.verificationUrl, userCode: launch.userCode } : {}),
    };
  });
  handle(IPC_CHANNELS.NATIVE_LOGIN_COMPLETE, async (body) => {
    const input = NativeLoginCompleteSchema.parse(body);
    if (![...currentNativeLogins.values()].includes(input.loginId)) {
      throw new AppError("conflict", "This native sign-in is no longer active");
    }
    completingNativeLoginId = input.loginId;
    try { return await post("/native/login/complete", input); }
    finally { completingNativeLoginId = null; }
  });
  handle(IPC_CHANNELS.NATIVE_LOGIN_CANCEL, async (body) => {
    const input = NativeLoginCancelSchema.parse(body);
    return withCredentialAction(async () => {
      if (currentNativeLogins.get(input.providerId) !== input.loginId) {
        return backendRequest<WorkspaceState>("/workspace");
      }
      blockedProviderCredentialWrites.add(input.providerId);
      const workspace = await revokeNativeAccount(() => saveCredentialChange(current => {
        delete current.providerCredentials[input.providerId];
        return current;
      }, { retainOnFailure: true }).then(() => undefined), () => post("/native/login/cancel", input));
      // A failed removal must remain retryable. The action count excludes duplicate
      // concurrent cancels, and a replacement login supersedes this retained identity.
      currentNativeLogins.delete(input.providerId);
      return workspace;
    }, input.loginId);
  });
  handle(IPC_CHANNELS.NATIVE_ACCOUNT_REFRESH, (body) => post("/native/account/refresh", NativeProviderSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_SEARCH_KEY, (body) => workflow(async () => {
    const { provider, apiKey } = SaveSearchKeySchema.parse(body);
    return changeSearchKey(provider, apiKey);
  }));
  handle(IPC_CHANNELS.REMOVE_SEARCH_KEY, (body) => workflow(() => changeSearchKey(RemoveSearchKeySchema.parse(body).provider, null)));
  handle(IPC_CHANNELS.NATIVE_LOGOUT, async (body) => {
    const input = NativeProviderSchema.parse(body);
    currentNativeLogins.delete(input.providerId);
    blockedProviderCredentialWrites.add(input.providerId);
    return revokeNativeAccount(() => saveCredentialChange(current => {
      delete current.providerCredentials[input.providerId];
      return current;
    }, { retainOnFailure: true }).then(() => undefined), () => post("/native/logout", input));
  });
  handle(IPC_CHANNELS.START_RESEARCH, (body) => post("/research/start", StartResearchSchema.parse(body)));
  handle(IPC_CHANNELS.CANCEL_RESEARCH, (body) => post("/research/cancel", CancelResearchSchema.parse(body)));
  handle(IPC_CHANNELS.RESUME_RESEARCH, (body) => post("/research/resume", ResumeResearchSchema.parse(body)));
  handle(IPC_CHANNELS.SELECT_PROBLEMS, (body) => post("/research/select-problems", SelectProblemsSchema.parse(body)));
  handle(IPC_CHANNELS.SELECT_OPTION, (body) => post("/research/select-option", SelectOptionSchema.parse(body)));
  handle(IPC_CHANNELS.SAVE_DECISION, (body) => post("/research/decision", SaveDecisionSchema.parse(body)));
  handle(IPC_CHANNELS.REVIEW_OPPORTUNITIES, (body) => post("/opportunities/review", ReviewSavedOpportunitiesSchema.parse(body)));
  handle(IPC_CHANNELS.EDIT_OPPORTUNITY_MEMBERSHIP, (body) => post("/opportunities/membership", EditOpportunityMembershipSchema.parse(body)));
  handle(IPC_CHANNELS.REQUEST_FOCUSED_EXPERIMENT, (body) => post("/experiments/plan", RequestFocusedExperimentSchema.parse(body)));
  handle(IPC_CHANNELS.PAUSE_OPPORTUNITY_EXPLORATION, (body) => post("/opportunities/pause", OpportunityExplorationActionSchema.parse(body)));
  handle(IPC_CHANNELS.START_OPPORTUNITY_EXPLORATION, (body) => post("/opportunities/start", ReviewSavedOpportunitiesSchema.parse(body)));
  handle(IPC_CHANNELS.RESUME_OPPORTUNITY_EXPLORATION, (body) => post("/opportunities/resume", ReviewSavedOpportunitiesSchema.parse(body)));
  handle(IPC_CHANNELS.PREVIEW_OPPORTUNITY_EXTENSION, (body) => post("/opportunities/extension-preview", PreviewOpportunityExtensionSchema.parse(body)));
  handle(IPC_CHANNELS.APPLY_OPPORTUNITY_EXTENSION, (body) => post("/opportunities/extension", ApplyOpportunityExtensionSchema.parse(body)));
  handle(IPC_CHANNELS.EVIDENCE_FOLLOW_UP, (body) => post("/research/evidence-follow-up", EvidenceFollowUpRequestSchema.parse(body)));
  handle(IPC_CHANNELS.EVIDENCE_REASSESSMENT, (body) => post("/research/evidence-reassessment", EvidenceReassessmentRequestSchema.parse(body)));
  handle(IPC_CHANNELS.EXPORT_RESEARCH, async (body, invocation) => {
    const bundle = ExportFileSchema.parse(await post("/research/export", ExportResearchRequestSchema.parse(body)));
    if (invocation.exportTarget === "files") return { files: [bundle] };
    if (invocation.exportTarget === "download") return { downloads: [bundle] };
    if (!options.chooseExportTarget) throw new AppError("backend_unavailable");
    const file = await options.chooseExportTarget({ kind: "research", filename: bundle.filename.replace(/[^a-zA-Z0-9._-]/g, "-") });
    if (!file) return { cancelled: true };
    writeFileSync(file, bundle.content, "utf8");
    return { cancelled: false, file };
  });
  handle(IPC_CHANNELS.EXPORT_IDEAS, async (body, invocation) => {
    const payload = ExportIdeasRequestSchema.parse(body);
    const bundle = IdeaExportSchema.parse(await post("/ideas/export", payload));
    if (invocation.exportTarget === "files") return { filename: bundle.filename, files: bundle.files };
    if (invocation.exportTarget === "download") return { downloads: [bundleBrowserIdeaExport(bundle, payload.format)] };
    if (!options.chooseExportTarget) throw new AppError("backend_unavailable");
    const directory = await options.chooseExportTarget({ kind: "ideas" });
    if (!directory) return { cancelled: true, files: [] };
    const files = bundle.files.map((file) => writeUniqueExportFile(directory, file.filename.replace(/[^a-zA-Z0-9._-]/g, "-"), file.content));
    return { cancelled: false, directory, files };
  });
  handle(IPC_CHANNELS.GET_SOURCE_DETAIL, (body) => {
    const { sourceId } = GetSourceDetailRequestSchema.parse(body);
    return backendRequest(`/sources/${encodeURIComponent(sourceId)}`);
  });
  handle(IPC_CHANNELS.GET_IDEA_DETAIL, (body) => {
    const { ideaId } = GetIdeaDetailRequestSchema.parse(body);
    return backendRequest(`/ideas/${encodeURIComponent(ideaId)}`);
  });
  handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (body, invocation) => {
    const url = parseExternalHttpsUrl(body);
    if (!invocation.openBrowser) return { url };
    if (!options.openExternal) throw new AppError("backend_unavailable");
    await options.openExternal(url);
  });

  for (const [channel, handler] of createAppOperationHandlers({ request: backendRequest })) {
    handle(channel, body => handler(body));
  }
  const previewBackendOperation = operations.get(APP_CHANNELS.PREVIEW_OPERATION)!;
  const executeBackendOperation = operations.get(APP_CHANNELS.EXECUTE_OPERATION)!;
  handle(APP_CHANNELS.PREVIEW_OPERATION, (body, invocation) => {
    const operation = PreviewOperationRequestSchema.parse(body);
    return isServiceBillingChannel(operation.channel) ? serviceBilling.preview(operation) : previewBackendOperation(body, invocation);
  });
  handle(APP_CHANNELS.EXECUTE_OPERATION, (body, invocation) => {
    const input = ExecuteOperationRequestSchema.parse(body);
    return isServiceBillingChannel(input.proposal.operation.channel) ? serviceBilling.execute(input) : executeBackendOperation(body, invocation);
  });

  async function invoke(channel: string, args: unknown[] = [], invocation: AppInvocationOptions = {}): Promise<unknown> {
    if (closing) throw new AppError("backend_unavailable", "Scraply is closing.");
    const operation = operations.get(channel);
    if (!operation) throw new AppError("not_found", "Unknown app request.");
    if (args.length > 1) throw new AppError("validation_error", "App requests accept at most one argument.");
    initialize();
    const parsedInvocation = AppInvocationOptionsSchema.parse(invocation);
    return ACCOUNT_MUTATION_CHANNELS.has(channel)
      ? withCredentialAction(async () => operation(args[0], parsedInvocation))
      : operation(args[0], parsedInvocation);
  }

  function createHandlers(invocation: AppInvocationOptions = {}): ReadonlyMap<string, AppRequestHandler> {
    const parsedInvocation = AppInvocationOptionsSchema.parse(invocation);
    return new Map([...operations.keys()].map(channel => [channel, (...args: unknown[]) => invoke(channel, args, parsedInvocation)]));
  }

  return {
    handlers: createHandlers(), createHandlers, invoke, initialize, persistProviderCredential, publishEvent,
    async invokeRemote(channel: string, payload?: unknown): Promise<unknown> {
      if (channel !== APP_CHANNELS.PREVIEW_OPERATION && channel !== APP_CHANNELS.EXECUTE_OPERATION
        && isBillableOperation(channel, payload)) {
        throw new AppError("conflict", "This operation needs a billing preview and confirmation before it can run.", 409,
          undefined, { action: "preview", channel });
      }
      if (!backend.isReady()) validateAutomaticSecretsOnStart = false;
      return invoke(channel, payload === undefined ? [] : [payload]);
    },
    getSecrets(): BackendSecrets { initialize(); return structuredClone(secrets); },
    secretValues(): string[] {
      return [secrets.exaApiKey, secrets.perplexityApiKey, ...Object.values(secrets.providerCredentials)]
        .filter((value): value is string => Boolean(value));
    },
    async start({ validateAutomaticSecrets = true }: AppServiceStartOptions = {}): Promise<void> {
      validateAutomaticSecretsOnStart = validateAutomaticSecrets;
      await ensureBackend();
      if (!validateAutomaticSecrets) return;
      if (!automaticSecrets.exaApiKey && !automaticSecrets.perplexityApiKey) return;
      await withCredentialAction(async () => {
        const validation = await backendRequest<ValidationState>("/validation");
        if (validation.setupComplete && configuredProviderSecretsAreValid(secrets, validation)) {
          await saveCredentialChange(current => current);
        }
      });
    },
    async stop() {
      closing = true;
      serviceBilling.clear();
      await backend.stop();
    },
  };
}
