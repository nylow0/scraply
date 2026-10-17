import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  APP_CHANNELS, ExecuteOperationResultSchema, OperationProposalSchema, SearchKeyCredentialReferenceSchema, appControlRegistry,
  isBillableOperation, isBoxedOperation, operationRegistry, parseBackendOperationResult,
  parseOperation, parseOperationResult,
} from "../shared/cli-contracts";
import { ApiErrorResponseSchema, ApiResponseSchema, ExportIdeasRequestSchema, IPC_CHANNELS, NativeLoginLaunchSchema, SaveSearchKeySchema } from "../shared/ipc";
import { AppError, toErrorPayload } from "../shared/errors";
import { OwnerTransportError } from "../shared/owner-contracts";
import { bundleBrowserIdeaExport } from "../shared/browser-export";
import type { AppRequestHandler, ExportTargetRequest } from "../app/service-contracts";
import { parseExternalHttpsUrl } from "./security";

const FilesSchema = z.object({ filename: z.string().optional(), files: z.array(z.object({ filename: z.string(), content: z.string() }).strict()) }).strict();
const PathSchema = z.object({ path: z.string().min(1) }).strict();

/** Convert portable responses to renderer results, applying all GUI effects in this process. */
export function createRemoteApp(options: {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  browserDev?: boolean;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  chooseExportTarget(request: ExportTargetRequest): Promise<string | null>;
}) {
  async function dispatch(channel: string, payload: unknown): Promise<unknown> {
    const operation = parseOperation(channel, payload);
    if (isBillableOperation(channel, operation.payload)) {
      // The GUI already collected its normal approval. Bind that exact action to
      // the owner's current capability/state proof before its single admission.
      const privateKeyChange = channel === IPC_CHANNELS.SAVE_SEARCH_KEY;
      const proposal = OperationProposalSchema.parse(await options.invoke(APP_CHANNELS.PREVIEW_OPERATION, operation));
      if (privateKeyChange) {
        // The candidate stays in the owner's memory. Only its opaque ID enters
        // the returned proposal or subsequent execute request.
        const candidate = SearchKeyCredentialReferenceSchema.parse(proposal.operation.payload);
        if (proposal.operation.channel !== channel || candidate.provider !== SaveSearchKeySchema.parse(operation.payload).provider) {
          throw new AppError("validation_error", "The owner preview changed the requested search provider.");
        }
      } else if (JSON.stringify(proposal.operation) !== JSON.stringify(operation)) {
        throw new AppError("validation_error", "The owner preview changed the requested operation.");
      }
      const execution = ExecuteOperationResultSchema.parse(await options.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal }));
      if (execution.channel !== channel) throw new AppError("validation_error", "The owner returned a different operation.");
      const result = parseBackendOperationResult(channel, execution.result);
      return isBoxedOperation(channel) ? { ok: true, data: result } : result;
    }
    const result = await options.invoke(channel, operation.payload);
    if (isBoxedOperation(channel)) {
      const envelope = ApiResponseSchema(z.unknown()).parse(result);
      if (!envelope.ok) return envelope;
      return { ok: true, data: parseOperationResult(channel, envelope.data) };
    }
    return parseOperationResult(channel, result);
  }

  async function invoke(channel: string, args: unknown[] = []): Promise<unknown> {
    try {
      if (args.length > 1) throw new AppError("validation_error", "App requests accept at most one argument.");
      if (channel === IPC_CHANNELS.OPEN_EXTERNAL_URL) {
        await options.openExternal(parseExternalHttpsUrl(args[0]));
        return;
      }
      const result = await dispatch(channel, args[0]);
      if (channel === IPC_CHANNELS.NATIVE_LOGIN_START) {
        const launch = NativeLoginLaunchSchema.parse(result);
        const url = launch.method === "device" ? launch.verificationUrl : launch.authorizationUrl;
        await options.openExternal(parseExternalHttpsUrl({ url }));
        return {
          loginId: launch.loginId, providerId: launch.providerId, method: launch.method,
          ...(launch.method === "device" ? { verificationUrl: launch.verificationUrl, userCode: launch.userCode } : {}),
        };
      }
      if (channel === IPC_CHANNELS.OPEN_DATA_FOLDER || channel === IPC_CHANNELS.OPEN_LOGS_FOLDER) {
        await options.revealPath(PathSchema.parse(result).path);
        return;
      }
      if (channel === IPC_CHANNELS.EXPORT_RESEARCH) {
        const { files } = FilesSchema.parse(result);
        if (files.length !== 1) throw new AppError("validation_error", "The owner returned an invalid research export.");
        const file = files[0]!;
        if (options.browserDev) return { downloads: [file] };
        const target = await options.chooseExportTarget({ kind: "research", filename: safeFilename(file.filename) });
        if (!target) return { cancelled: true };
        writeFileSync(target, file.content, "utf8");
        return { cancelled: false, file: target };
      }
      if (channel === IPC_CHANNELS.EXPORT_IDEAS) {
        const bundle = FilesSchema.parse(result);
        const { files } = bundle;
        const { threadId, format } = ExportIdeasRequestSchema.parse(args[0]);
        if (options.browserDev) return { downloads: [bundleBrowserIdeaExport({
          filename: bundle.filename ?? `scraply-ideas-${threadId}.${format === "json" ? "json" : "md"}`, files,
        }, format)] };
        const directory = await options.chooseExportTarget({ kind: "ideas" });
        if (!directory) return { cancelled: true, files: [] };
        const saved = files.map(file => writeUniqueExport(directory, safeFilename(file.filename), file.content));
        return { cancelled: false, directory, files: saved };
      }
      return result;
    } catch (error) {
      // Known renderer channels keep their legacy envelope even if transport fails.
      const ownerError = error instanceof OwnerTransportError ? ApiErrorResponseSchema.safeParse({
        ok: false, error: { code: error.code, message: error.message,
          ...(error.reference ? { reference: error.reference } : {}), ...(error.recovery ? { recovery: error.recovery } : {}) },
      }) : undefined;
      const normalized = ownerError?.success
        ? new AppError(ownerError.data.error.code, ownerError.data.error.message, error instanceof OwnerTransportError ? error.status : 500,
          ownerError.data.error.reference, ownerError.data.error.recovery)
        : error instanceof OwnerTransportError ? new AppError("backend_unavailable", error.message) : error;
      if (isBoxedOperation(channel)) return { ok: false, error: toErrorPayload(normalized).error };
      throw normalized;
    }
  }

  const handlers: ReadonlyMap<string, AppRequestHandler> = new Map(Object.keys(operationRegistry).map(channel => [
    channel, (...args: unknown[]) => invoke(channel, args),
  ]));
  // APP control requests are useful to the desktop service seam, but never become
  // nested automatic GUI proposals.
  const controls = new Map(Object.entries(appControlRegistry).map(([channel, definition]) => [channel,
    async (...args: unknown[]) => {
      if (args.length > 1) throw new AppError("validation_error");
      return definition.result.parse(await options.invoke(channel, definition.request.parse(args[0])));
    },
  ]));
  return { invoke, handlers: new Map([...handlers, ...controls]) };
}

function safeFilename(filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  return !safe || /^\.+$/.test(safe) ? "scraply-export" : safe;
}

function writeUniqueExport(directory: string, filename: string, content: string) {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix ? `${stem}-${suffix + 1}${extension}` : filename;
    try {
      writeFileSync(join(directory, candidate), content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
}
