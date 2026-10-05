import { ProviderFailure } from "../providers/structured";

interface ScheduledCall {
  projectId: string;
  controller: AbortController;
  run: () => Promise<void>;
  rejectQueued: () => void;
}

/**
 * Bounds provider calls and gives each project one call before returning to a project
 * that still has queued work. An active call keeps the slot until it settles, even after abort.
 */
export class WorkflowModelScheduler {
  private readonly pending = new Map<string, ScheduledCall[]>();
  private readonly readyProjects: string[] = [];
  private readonly active = new Set<ScheduledCall>();
  private pumpQueued = false;
  private capacity: number;

  constructor(maxActive = 1) {
    this.capacity = validateCapacity(maxActive);
  }

  get maxActive(): number {
    return this.capacity;
  }

  setMaxActive(maxActive: number): void {
    this.capacity = validateCapacity(maxActive);
    // Lowering capacity leaves admitted calls running until they settle.
    this.requestPump();
  }

  get activeProjectId(): string | null {
    return this.active.values().next().value?.projectId ?? null;
  }

  get activeCallCount(): number {
    return this.active.size;
  }

  get activeProjectIds(): string[] {
    return [...new Set([...this.active].map((call) => call.projectId))];
  }

  get pendingCallCount(): number {
    return [...this.pending.values()].reduce((count, calls) => count + calls.length, 0);
  }

  schedule<T>(projectId: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!projectId.trim()) throw new Error("A scheduled model call needs a project ID");
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const controller = new AbortController();
    const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (result: { value: T } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        callSignal.removeEventListener("abort", onAbort);
        if ("error" in result) reject(result.error);
        else resolve(result.value);
      };
      const call: ScheduledCall = {
        projectId,
        controller,
        run: async () => {
          try {
            const value = await operation(callSignal);
            finish(callSignal.aborted ? { error: abortError(callSignal) } : { value });
          } catch (error) {
            // An active provider's terminal receipt owns usage and completion safety.
            // Replacing it with the abort reason would discard confirmed cancellation or lost-process metadata.
            if (error instanceof ProviderFailure) {
              const reason = callSignal.reason;
              const deadlineCancellation = callSignal.aborted && reason instanceof ProviderFailure
                && reason.code === "timeout" && error.code === "cancelled";
              finish({ error: deadlineCancellation ? new ProviderFailure("timeout", reason.message, reason.retryable, {
                cause: error,
                ...(error.attempts ? { attempts: error.attempts } : {}),
                ...(error.runtimeCode ? { runtimeCode: error.runtimeCode } : {}),
              }) : error });
            } else finish({ error: callSignal.aborted ? abortError(callSignal) : error });
          }
        },
        rejectQueued: () => finish({ error: abortError(callSignal) }),
      };
      const onAbort = () => {
        if (this.active.has(call)) return;
        this.removeQueued(call);
        call.rejectQueued();
      };
      callSignal.addEventListener("abort", onAbort, { once: true });
      const queue = this.pending.get(projectId) ?? [];
      queue.push(call);
      this.pending.set(projectId, queue);
      if (queue.length === 1) {
        // A new project gets its first turn before more work from active projects.
        const activeReadyIndex = this.readyProjects.findIndex((readyId) =>
          [...this.active].some((activeCall) => activeCall.projectId === readyId));
        if (![...this.active].some((activeCall) => activeCall.projectId === projectId) && activeReadyIndex >= 0) {
          this.readyProjects.splice(activeReadyIndex, 0, projectId);
        } else this.readyProjects.push(projectId);
      }
      this.requestPump();
    });
  }

  cancelProject(projectId: string, reason?: Error): void {
    for (const call of [...(this.pending.get(projectId) ?? [])]) call.controller.abort(reason);
    for (const call of this.active) {
      if (call.projectId === projectId) call.controller.abort(reason);
    }
  }

  cancelAll(reason?: Error): void {
    for (const projectId of [...this.pending.keys()]) this.cancelProject(projectId, reason);
    for (const call of this.active) call.controller.abort(reason);
  }

  private removeQueued(call: ScheduledCall): void {
    const queue = this.pending.get(call.projectId);
    if (!queue) return;
    const index = queue.indexOf(call);
    if (index < 0) return;
    queue.splice(index, 1);
    if (queue.length > 0) return;
    this.pending.delete(call.projectId);
    const readyIndex = this.readyProjects.indexOf(call.projectId);
    if (readyIndex >= 0) this.readyProjects.splice(readyIndex, 1);
  }

  private requestPump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.active.size < this.capacity && this.readyProjects.length > 0) {
      const projectId = this.readyProjects.shift()!;
      const queue = this.pending.get(projectId);
      if (!queue?.length) continue;
      const call = queue.shift()!;
      if (queue.length === 0) this.pending.delete(projectId);
      else this.readyProjects.push(projectId);
      this.active.add(call);
      void call.run().finally(() => {
        this.active.delete(call);
        this.requestPump();
      });
    }
  }
}

function validateCapacity(maxActive: number): number {
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 8) {
    throw new Error("Concurrent model calls must be an integer from 1 to 8");
  }
  return maxActive;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(typeof signal.reason === "string" ? signal.reason : "Model call cancelled", "AbortError");
}
