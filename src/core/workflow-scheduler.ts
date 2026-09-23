interface ScheduledCall {
  projectId: string;
  controller: AbortController;
  run: () => Promise<void>;
  rejectQueued: () => void;
}

/**
 * Serializes provider calls and gives each project one call before returning to a project
 * that still has queued work. An active call keeps the slot until it settles, even after abort.
 */
export class WorkflowModelScheduler {
  private readonly pending = new Map<string, ScheduledCall[]>();
  private readonly readyProjects: string[] = [];
  private active: ScheduledCall | null = null;
  private pumpQueued = false;

  get activeProjectId(): string | null {
    return this.active?.projectId ?? null;
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
            finish({ error: callSignal.aborted ? abortError(callSignal) : error });
          }
        },
        rejectQueued: () => finish({ error: abortError(callSignal) }),
      };
      const onAbort = () => {
        if (this.active === call) return;
        this.removeQueued(call);
        call.rejectQueued();
      };
      callSignal.addEventListener("abort", onAbort, { once: true });
      const queue = this.pending.get(projectId) ?? [];
      queue.push(call);
      this.pending.set(projectId, queue);
      if (queue.length === 1 && this.active?.projectId !== projectId) this.readyProjects.push(projectId);
      this.requestPump();
    });
  }

  cancelProject(projectId: string, reason?: Error): void {
    for (const call of [...(this.pending.get(projectId) ?? [])]) call.controller.abort(reason);
    if (this.active?.projectId === projectId) this.active.controller.abort(reason);
  }

  cancelAll(reason?: Error): void {
    for (const projectId of [...this.pending.keys()]) this.cancelProject(projectId, reason);
    if (this.active) this.active.controller.abort(reason);
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
    if (this.active) return;
    while (this.readyProjects.length > 0) {
      const projectId = this.readyProjects.shift()!;
      const queue = this.pending.get(projectId);
      if (!queue?.length) continue;
      const call = queue.shift()!;
      if (queue.length === 0) this.pending.delete(projectId);
      this.active = call;
      void call.run().finally(() => {
        this.active = null;
        if (this.pending.has(projectId)) this.readyProjects.push(projectId);
        this.requestPump();
      });
      return;
    }
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(typeof signal.reason === "string" ? signal.reason : "Model call cancelled", "AbortError");
}
