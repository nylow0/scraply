import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  CredentialResultSchema, GenerationMetadataSchema, InitializeResultSchema, ModelMetadataSchema,
  PromptIdentitySchema, ProviderAccountSchema, RUNTIME_PROTOCOL_VERSION, RUNTIME_REQUIRED_CAPABILITIES,
  ServerEnvelopeSchema, type CredentialResult, type InitializeResult, type ModelMetadata,
  type RuntimeFailure, type RuntimeOperation, type ServerEnvelope,
} from "../shared/runtime-protocol";
import { ProviderFailure, type GenerationAttemptMetadata, type StructuredModelClient, type StructuredStageRequest } from "./structured";

const execFileAsync = promisify(execFile);
const MAX_ENVELOPE_BYTES = 16_777_216;
const REQUEST_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 2_000;
const TERMINAL_GRACE_MS = 2_000;

export interface RuntimeArtifactIdentity { version: string; sourceCommit: string; sha256: string }
export interface RuntimeClientOptions {
  executablePath: string;
  /** Prepended to runtime and identity arguments for explicit host launchers. */
  argumentPrefix?: readonly string[];
  artifact: RuntimeArtifactIdentity;
  appVersion: string;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  controlTimeoutMs?: number;
  terminalGraceMs?: number;
}

interface PendingRequest {
  operation: RuntimeOperation;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface PendingGeneration {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: { output: unknown; metadata: z.infer<typeof GenerationMetadataSchema> }) => void;
  reject: (error: Error) => void;
}
interface RequestOptions { id?: string; timeoutMs?: number; onDispatched?: () => void }
interface GenerationWaiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

export class RuntimeClient implements StructuredModelClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initializePromise: Promise<InitializeResult> | null = null;
  private initialized: InitializeResult | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private writeTail: Promise<void> = Promise.resolve();
  private generationActive = false;
  private readonly generationWaiters: GenerationWaiter[] = [];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingGenerations = new Map<string, PendingGeneration>();

  constructor(private readonly options: RuntimeClientOptions) {}

  preparedIdentity() {
    if (!this.initialized) throw new ProviderFailure("unavailable", "Native runtime is not ready", true);
    return {
      protocolVersion: this.initialized.selectedProtocolVersion,
      runtimeVersion: this.initialized.runtime.version,
      runtimeSourceSha: this.options.artifact.sourceCommit,
      runtimeExecutableSha256: this.options.artifact.sha256,
      compilerPrompt: this.initialized.prompt,
    };
  }

  async prepareIdentity() {
    await this.start();
    return this.preparedIdentity();
  }

  async start(): Promise<InitializeResult> {
    if (this.initialized) return this.initialized;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.startProcess();
    try { this.initialized = await this.initializePromise; return this.initialized; }
    finally { this.initializePromise = null; }
  }

  async listAccounts() {
    await this.start();
    return z.object({ accounts: z.array(ProviderAccountSchema) }).strict()
      .parse(await this.request("account.list", {})).accounts;
  }

  async restoreCredential(providerId: string, credential: string): Promise<void> {
    await this.start();
    await this.request("credential.session.set", { providerId, credential });
  }

  async refreshAccount(providerId: string, persist: (providerId: string, credential: string) => Promise<void>): Promise<CredentialResult> {
    await this.start();
    const result = CredentialResultSchema.parse(await this.request("account.refresh", { providerId }));
    await this.persistCredential(result, persist);
    return result;
  }

  async startLogin(providerId: string, method: "browser" | "device" | "pkce", callbackUrl?: string) {
    await this.start();
    return z.discriminatedUnion("method", [
      z.object({ loginId: z.string(), providerId: z.string(), method: z.literal("browser"), authorizationUrl: z.string().url(), callbackPort: z.number().int().positive() }).strict(),
      z.object({ loginId: z.string(), providerId: z.string(), method: z.literal("device"), verificationUrl: z.string().url(), userCode: z.string().min(1) }).strict(),
      z.object({ loginId: z.string(), providerId: z.string(), method: z.literal("pkce"), authorizationUrl: z.string().url() }).strict(),
    ]).parse(await this.request("account.login.start", { providerId, method, ...(callbackUrl ? { callbackUrl } : {}) }));
  }

  async completeLogin(loginId: string, persist: (providerId: string, credential: string) => Promise<void>): Promise<CredentialResult | null> {
    await this.start();
    try {
      const result = CredentialResultSchema.parse(await this.request("account.login.complete", { loginId }));
      await this.persistCredential(result, persist);
      return result;
    } catch (error) {
      if (error instanceof ProviderFailure && error.runtimeCode === "operation_unavailable") return null;
      throw error;
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.start();
    await this.request("account.login.cancel", { loginId }, { timeoutMs: this.controlTimeoutMs });
  }
  async logout(providerId: string): Promise<void> { await this.start(); await this.request("account.logout", { providerId }); }
  async listModels(providerId: string): Promise<ModelMetadata[]> {
    await this.start();
    return z.object({ models: z.array(ModelMetadataSchema) }).strict()
      .parse(await this.request("model.list", { providerId })).models;
  }

  async structuredCompletion<T>(request: StructuredStageRequest<T>) {
    const release = await this.acquireGeneration(request.signal);
    try { return await this.runStructuredCompletion(request); }
    finally { release(); }
  }

  private async runStructuredCompletion<T>(request: StructuredStageRequest<T>) {
    const initialized = await this.start();
    if (request.signal?.aborted) throw new ProviderFailure("cancelled", "Generation was cancelled before dispatch", false);
    if (jsonByteLength({ workOrder: request.workOrder, evidence: request.evidence }) > initialized.limits.maxInputBytes) {
      throw new ProviderFailure("failed", "Native runtime input exceeds the protocol limit", false);
    }
    if (jsonByteLength(request.jsonSchema) > initialized.limits.maxSchemaBytes) {
      throw new ProviderFailure("failed", "Native runtime output schema exceeds the protocol limit", false);
    }
    const requestId = randomUUID();
    const terminal = new Promise<{ output: unknown; metadata: z.infer<typeof GenerationMetadataSchema> }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const generation = this.pendingGenerations.get(request.generationId);
        if (generation?.requestId === requestId) void this.cancelGeneration(request.generationId, "Native runtime did not emit a terminal generation event");
      }, request.deadlineMs + this.terminalGraceMs);
      this.pendingGenerations.set(request.generationId, { requestId, timer, resolve, reject });
    });
    const terminalOutcome = terminal.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let cancelSent = false;
    const cancel = () => {
      if (cancelSent) return;
      cancelSent = true;
      void this.cancelGeneration(request.generationId, "Generation cancellation was not acknowledged");
    };
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      let accepted: { generationId: string; prompt: z.infer<typeof PromptIdentitySchema> };
      try {
        accepted = z.object({ generationId: z.literal(request.generationId), prompt: PromptIdentitySchema }).strict().parse(
          await this.request("generation.start", {
          generationId: request.generationId,
          deadlineMs: request.deadlineMs,
          model: request.model,
          promptRevision: initialized.prompt.id,
          workOrder: request.workOrder,
          evidence: request.evidence,
          outputSchema: request.jsonSchema,
          reasoningEffort: request.reasoningEffort,
          ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
          repairPolicy: request.repairPolicy,
          }, { id: requestId, ...(request.onDispatched ? { onDispatched: request.onDispatched } : {}) }),
        );
        if (accepted.prompt.sha256 !== initialized.prompt.sha256) {
          throw new ProviderFailure("interrupted", "Runtime prompt identity changed after dispatch", false);
        }
      } catch (error) {
        await this.cancelGeneration(request.generationId, "Generation acceptance failed and cancellation was not acknowledged");
        const outcome = await terminalOutcome;
        const attempts = outcome.status === "fulfilled" ? outcome.value.metadata.attempts : undefined;
        if (error instanceof ProviderFailure) {
          throw new ProviderFailure(error.code, error.message, error.retryable, {
            cause: error,
            ...(attempts ? { attempts } : {}),
            ...(error.runtimeCode ? { runtimeCode: error.runtimeCode } : {}),
          });
        }
        throw new ProviderFailure("interrupted", "Native runtime returned an invalid generation acceptance", false, {
          cause: error,
          ...(attempts ? { attempts } : {}),
        });
      }
      request.onAccepted?.(this.preparedIdentity());
      const outcome = await terminalOutcome;
      if (outcome.status === "rejected") throw outcome.reason;
      const completed = outcome.value;
      if (jsonByteLength(completed.output) > initialized.limits.maxOutputBytes) {
        throw new ProviderFailure("failed", "Native runtime output exceeds the protocol limit", false, { attempts: completed.metadata.attempts });
      }
      try { return { output: request.schema.parse(completed.output), metadata: completed.metadata }; }
      catch (error) {
        throw new ProviderFailure("schema", "Native runtime output did not match the requested schema", false, {
          cause: error,
          attempts: completed.metadata.attempts,
        });
      }
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      this.removeGeneration(request.generationId, requestId);
    }
  }

  private acquireGeneration(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ProviderFailure("cancelled", "Generation was cancelled before dispatch", false));
    if (!this.generationActive) {
      this.generationActive = true;
      return Promise.resolve(() => this.releaseGeneration());
    }
    return new Promise((resolve, reject) => {
      const waiter: GenerationWaiter = { ...(signal ? { signal } : {}), resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.generationWaiters.indexOf(waiter);
          if (index >= 0) this.generationWaiters.splice(index, 1);
          reject(new ProviderFailure("cancelled", "Generation was cancelled before dispatch", false));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.generationWaiters.push(waiter);
    });
  }

  private releaseGeneration(): void {
    for (;;) {
      const waiter = this.generationWaiters.shift();
      if (!waiter) { this.generationActive = false; return; }
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      waiter.resolve(() => this.releaseGeneration());
      return;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request("runtime.shutdown", {}, { timeoutMs: this.controlTimeoutMs });
      await waitForClose(child, this.controlTimeoutMs);
    } catch {
      this.failProcess(new ProviderFailure("interrupted", "Native runtime did not shut down cleanly", true), child);
    }
  }

  private get requestTimeoutMs() { return this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS; }
  private get controlTimeoutMs() { return this.options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS; }
  private get terminalGraceMs() { return this.options.terminalGraceMs ?? TERMINAL_GRACE_MS; }

  private async startProcess(): Promise<InitializeResult> {
    await verifyRuntimeArtifact(this.options);
    const child = spawn(this.options.executablePath, [...(this.options.argumentPrefix ?? []), "runtime"], {
      windowsHide: true, shell: false, env: this.options.environment ?? process.env,
    });
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(child, chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.failProcess(new ProviderFailure("unavailable", "Native runtime could not be started", true, { cause: error }), child));
    child.on("close", () => this.failProcess(new ProviderFailure("interrupted", "Native runtime stopped before completing its work", true), child));
    try {
      const initialized = InitializeResultSchema.parse(await this.request("runtime.initialize", {
        supportedProtocolVersions: [RUNTIME_PROTOCOL_VERSION],
        requiredCapabilities: [...RUNTIME_REQUIRED_CAPABILITIES],
        client: { name: "scraply", version: this.options.appVersion },
      }));
      for (const capability of RUNTIME_REQUIRED_CAPABILITIES) {
        if (!initialized.capabilities.includes(capability)) throw new Error(`Native runtime lacks required capability: ${capability}`);
      }
      if (initialized.runtime.version !== this.options.artifact.version) throw new Error("Native runtime version does not match the packaged lock");
      return initialized;
    } catch (error) {
      this.failProcess(error instanceof Error ? error : new Error("Native runtime handshake failed"), child);
      throw error;
    }
  }

  private request(operation: RuntimeOperation, payload: object, options: RequestOptions = {}): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new ProviderFailure("unavailable", "Native runtime is unavailable", true));
    const id = options.id ?? randomUUID();
    let line: Buffer;
    try { line = encodeRuntimeEnvelope(id, operation, payload); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { operation, timer: null, resolve, reject };
      this.pendingRequests.set(id, pending);
      this.writeTail = this.writeTail.catch(() => undefined).then(async () => {
        if (this.child !== child || this.pendingRequests.get(id) !== pending) return;
        try { options.onDispatched?.(); }
        catch (error) {
          this.pendingRequests.delete(id);
          pending.reject(error instanceof Error ? error : new Error("Native runtime dispatch was rejected"));
          return;
        }
        pending.timer = setTimeout(() => {
          if (this.pendingRequests.get(id) === pending) {
            this.failProcess(new ProviderFailure("interrupted", `Native runtime did not answer ${operation}`, true), child);
          }
        }, options.timeoutMs ?? this.requestTimeoutMs);
        try { await writeWithBackpressure(child, line); }
        catch (error) {
          if (this.pendingRequests.get(id) === pending) {
            this.failProcess(new ProviderFailure("interrupted", "Native runtime request could not be written", true, { cause: error }), child);
          }
        }
      });
    });
  }

  private consumeStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(10);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length > MAX_ENVELOPE_BYTES) {
        this.failProcess(new ProviderFailure("failed", "Native runtime returned an oversized response", false), child);
        return;
      }
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
        this.handleEnvelope(child, ServerEnvelopeSchema.parse(JSON.parse(decoded)));
      } catch (error) {
        this.failProcess(new ProviderFailure("failed", "Native runtime returned an invalid protocol message", false, { cause: error }), child);
        return;
      }
    }
    if (this.stdoutBuffer.length > MAX_ENVELOPE_BYTES) {
      this.failProcess(new ProviderFailure("failed", "Native runtime returned an oversized response", false), child);
    }
  }

  private handleEnvelope(child: ChildProcessWithoutNullStreams, envelope: ServerEnvelope): void {
    if (this.child !== child) return;
    if (envelope.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
      this.failProcess(new ProviderFailure("failed", "Native runtime response used the wrong protocol version", false), child);
      return;
    }
    if ("event" in envelope) {
      const event = envelope.event;
      const generation = this.pendingGenerations.get(event.generationId);
      if (!generation || String(envelope.requestId) !== generation.requestId) return;
      if (event.kind === "generation.started" || event.kind === "generation.delta") return;
      this.removeGeneration(event.generationId, generation.requestId);
      if (event.kind === "generation.completed") generation.resolve(event.result as { output: unknown; metadata: z.infer<typeof GenerationMetadataSchema> });
      else if (event.kind === "generation.cancelled") generation.reject(new ProviderFailure("cancelled", "Generation was cancelled", false, event.attempts ? { attempts: event.attempts } : undefined));
      else generation.reject(providerFailure(event.error, event.attempts));
      return;
    }
    if (!("id" in envelope) || envelope.id === undefined) return;
    const id = String(envelope.id);
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    if (envelope.operation !== pending.operation) {
      this.failProcess(new ProviderFailure("failed", "Native runtime response operation did not match its request", false), child);
      return;
    }
    this.pendingRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in envelope) pending.reject(providerFailure(envelope.error));
    else pending.resolve(envelope.result);
  }

  private async persistCredential(result: CredentialResult, persist: (providerId: string, credential: string) => Promise<void>): Promise<void> {
    await persist(result.persistence.providerId, result.credential);
    const acknowledgment = z.object({ providerId: z.string(), sessionId: z.string(), rotationId: z.string(), ready: z.literal(true) }).strict()
      .parse(await this.request("credential.session.persisted", result.persistence));
    if (acknowledgment.providerId !== result.persistence.providerId
      || acknowledgment.sessionId !== result.persistence.sessionId
      || acknowledgment.rotationId !== result.persistence.rotationId) {
      throw new Error("Runtime acknowledged a different credential rotation");
    }
  }

  private async cancelGeneration(generationId: string, failureMessage: string): Promise<void> {
    const generation = this.pendingGenerations.get(generationId);
    if (!generation) return;
    try { await this.request("generation.cancel", { generationId }, { timeoutMs: this.controlTimeoutMs }); }
    catch {
      if (this.pendingGenerations.get(generationId) === generation) {
        this.failProcess(new ProviderFailure("interrupted", failureMessage, true), this.child);
      }
      return;
    }
    setTimeout(() => {
      if (this.pendingGenerations.get(generationId) === generation) {
        this.failProcess(new ProviderFailure("interrupted", "Native runtime did not emit cancellation terminal metadata", true), this.child);
      }
    }, this.terminalGraceMs);
  }

  private removeGeneration(generationId: string, requestId: string): void {
    const generation = this.pendingGenerations.get(generationId);
    if (!generation || generation.requestId !== requestId) return;
    clearTimeout(generation.timer);
    this.pendingGenerations.delete(generationId);
  }

  private failProcess(error: Error, child: ChildProcessWithoutNullStreams | null): void {
    if (!child || this.child !== child) return;
    this.child = null;
    this.initialized = null;
    this.stdoutBuffer = Buffer.alloc(0);
    for (const pending of this.pendingRequests.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(error); }
    for (const pending of this.pendingGenerations.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pendingRequests.clear();
    this.pendingGenerations.clear();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.stdin.destroy();
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

export function encodeRuntimeEnvelope(id: string, operation: RuntimeOperation, payload: object): Buffer {
  const envelope = Buffer.from(JSON.stringify({ protocolVersion: RUNTIME_PROTOCOL_VERSION, id, operation, payload }), "utf8");
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new ProviderFailure("failed", "Native runtime request is too large", false);
  return Buffer.concat([envelope, Buffer.from("\n")]);
}

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ProviderFailure("failed", "Native runtime payload is not JSON serializable", false);
  return Buffer.byteLength(serialized, "utf8");
}

async function verifyRuntimeArtifact(options: RuntimeClientOptions): Promise<void> {
  const bytes = await readFile(options.executablePath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== options.artifact.sha256) throw new Error("Native runtime executable hash does not match the packaged lock");
  const { stdout } = await execFileAsync(options.executablePath, [...(options.argumentPrefix ?? []), "--version"], {
    windowsHide: true, timeout: 10_000, env: options.environment ?? process.env,
  });
  if (stdout.trim() !== `scraply-agent ${options.artifact.version}`) throw new Error("Native runtime identity does not match the packaged lock");
}

function writeWithBackpressure(child: ChildProcessWithoutNullStreams, line: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      child.stdin.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => finish(error);
    child.stdin.once("error", onError);
    child.stdin.write(line, (error) => finish(error));
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off("close", onClose); reject(new Error("Runtime close timed out")); }, timeoutMs);
    const onClose = () => { clearTimeout(timer); resolve(); };
    child.once("close", onClose);
  });
}

function providerFailure(error: RuntimeFailure, attempts?: GenerationAttemptMetadata[]): ProviderFailure {
  const code = error.code === "cancelled" ? "cancelled"
    : error.code === "deadline_exceeded" ? "timeout"
      : error.code === "authentication_failed" ? "auth"
        : error.code === "rate_limited" ? "rate-limit"
          : error.code === "schema_invalid" || error.code === "output_invalid" ? "schema"
            : error.code === "provider_unavailable" || error.code === "reconnect_required" ? "unavailable"
              : "failed";
  return new ProviderFailure(code, error.detail, error.retryable, { runtimeCode: error.code, ...(attempts ? { attempts } : {}) });
}
