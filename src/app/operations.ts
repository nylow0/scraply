import { APP_CHANNELS, appControlRegistry, operationRegistry } from "../shared/cli-contracts";
import { AppError } from "../shared/errors";

export interface AppOperationBackend {
  request(path: string, init?: RequestInit): Promise<unknown>;
}

/** Merge these handlers into createAppService after wrapping request with its normal backend-start path. */
export function createAppOperationHandlers(backend: AppOperationBackend) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const channel of Object.values(APP_CHANNELS)) {
    const definition = operationRegistry[channel] ?? appControlRegistry[channel as keyof typeof appControlRegistry];
    if (definition.owner === "service") continue;
    handlers.set(channel, async (...args) => {
      if (args.length > 1) throw new AppError("validation_error", "App requests accept at most one argument.");
      const payload = definition.request.parse(args[0]);
      const result = await backend.request(definition.route(payload), definition.method === "POST"
        ? { method: "POST", body: JSON.stringify(payload) } : undefined);
      return definition.result.parse(result);
    });
  }
  return handlers;
}
