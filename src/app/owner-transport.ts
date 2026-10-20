import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { toErrorPayload } from "../shared/errors";
import { ResearchEventSchema, type ResearchEvent } from "../shared/ipc";
import {
  OwnerErrorSchema, OwnerHealthSchema, OwnerInvocationSchema, OwnerMetadataSchema,
  OwnerResponseSchema, OwnerStopResultSchema, OwnerStopSchema, OwnerTransportError,
  ownerVersionError, type OwnerHealth, type OwnerKind, type OwnerMetadata,
} from "../shared/owner-contracts";
import type { OwnerLock } from "./owner";

const DEFAULT_MAX_BODY = 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const VERSION_HEADER = "x-scraply-version";

export interface OwnerActivity {
  inflight: number;
  streams: number;
  stopping: boolean;
  lastActivityAt: number;
}

export interface OwnerTransport {
  readonly metadata: OwnerMetadata;
  readonly activity: OwnerActivity;
  requestStop(force?: boolean): Promise<{ stopped: boolean }>;
  close(): Promise<void>;
}

export interface OwnerTransportOptions {
  lock: OwnerLock;
  kind: OwnerKind;
  version: string;
  invoke(channel: string, payload: unknown, options: { interactive: false }): Promise<unknown>;
  subscribe(listener: (event: ResearchEvent) => void): () => void;
  requestShutdown(options: { force: boolean }): boolean | Promise<boolean>;
  maxBodyBytes?: number;
}

export interface OwnerSubscription {
  close(): void;
  done: Promise<void>;
}

function transportError(code: string, message: string, status = 503) {
  return new OwnerTransportError({ code, message }, status);
}

function sameToken(header: string | undefined, token: string) {
  // Hash both sides so even malformed-length credentials reach a fixed-length
  // constant-time comparison. Credentials never appear in a URL or log.
  const actual = createHash("sha256").update(header ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(actual, expected);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw transportError("validation_error", "Send an application/json request body.", 415);
  }
  const declared = req.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw transportError("validation_error", "The request body is too large.", 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => req.destroy(), 15_000);
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw transportError("validation_error", "The request body is too large.", 413);
      chunks.push(buffer);
    }
  } finally { clearTimeout(timer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof OwnerTransportError) {
    const payload = OwnerErrorSchema.parse({
      code: error.code, message: error.message,
      ...(error.recovery ? { recovery: error.recovery } : {}),
      ...(error.reference ? { reference: error.reference } : {}),
    });
    sendJson(res, error.status, { ok: false, error: payload });
  } else {
    const normalized = toErrorPayload(error);
    sendJson(res, normalized.status, { ok: false, error: normalized.error });
  }
}

/** Serves every portable handler through one authenticated, noninteractive seam. */
export async function startOwnerTransport(options: OwnerTransportOptions): Promise<OwnerTransport> {
  const maxBody = z.number().int().positive().max(16 * DEFAULT_MAX_BODY).parse(options.maxBodyBytes ?? DEFAULT_MAX_BODY);
  let metadata: OwnerMetadata;
  let identity: OwnerHealth;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let lastActivityAt = Date.now();
  const invocations = new Set<Promise<void>>();
  const requests = new Set<Promise<void>>();
  const streams = new Set<() => void>();

  async function requestStop(force = false) {
    if (options.kind !== "cli" || stopping) return { stopped: false };
    // Reserve admission before awaiting caller work. A concurrent request can
    // neither start a handler nor attach a stream after the idle check.
    stopping = true;
    let accepted = false;
    try {
      if (!force && (invocations.size > 0 || streams.size > 0)) return { stopped: false };
      accepted = await options.requestShutdown({ force });
      return { stopped: accepted };
    } finally {
      // An accepted stop stays reserved until host cleanup closes transport.
      // The callback is the authority on active backend work and normal cancel.
      if (!accepted) stopping = Boolean(closing);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader(VERSION_HEADER, metadata.version);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${metadata.port}`
      || req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
      throw transportError("unauthorized", "Only native loopback clients may connect.", 403);
    }
    if (!sameToken(req.headers.authorization, metadata.token)) throw transportError("unauthorized", "The owner token is invalid.", 401);
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, data: identity });
      return;
    }
    const clientVersion = req.headers[VERSION_HEADER];
    const compatible = typeof clientVersion === "string" && clientVersion === metadata.version;
    if (req.url !== "/stop" && !compatible) throw ownerVersionError(metadata, typeof clientVersion === "string" ? clientVersion : "unknown");
    if (stopping) throw transportError("OWNER_STOPPING", "The owner is stopping. Wait for it to exit before starting another owner.", 409);
    lastActivityAt = Date.now();
    if (req.method === "POST" && req.url === "/stop") {
      const input = OwnerStopSchema.parse(await readJson(req, maxBody));
      if (input.force && !compatible) throw ownerVersionError(metadata, typeof clientVersion === "string" ? clientVersion : "unknown");
      sendJson(res, 200, { ok: true, data: await requestStop(input.force) });
      return;
    }
    if (req.method === "POST" && req.url === "/invoke") {
      // Count body admission too. Shutdown must not overlook a request whose
      // JSON is arriving while it decides whether the owner is idle.
      const pending = (async () => {
        const input = OwnerInvocationSchema.parse(await readJson(req, maxBody));
        if (stopping) throw transportError("OWNER_STOPPING", "The owner is stopping.", 409);
        const result = await options.invoke(input.channel, input.payload, { interactive: false });
        sendJson(res, 200, { ok: true, data: result ?? null });
      })();
      invocations.add(pending);
      try { await pending; } finally { invocations.delete(pending); lastActivityAt = Date.now(); }
      return;
    }
    if (req.method === "GET" && req.url === "/events") {
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const detach = () => {
        if (!streams.delete(detach)) return;
        clearInterval(heartbeat);
        req.socket.off("close", detach);
        try { unsubscribe?.(); } catch { /* A subscriber cleanup failure must not hold the socket open. */ }
        res.end();
        lastActivityAt = Date.now();
      };
      streams.add(detach);
      res.once("close", detach);
      req.socket.once("close", detach);
      try {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: owner\ndata: ${JSON.stringify(identity)}\n\n`);
        unsubscribe = options.subscribe(event => {
          if (!streams.has(detach)) return;
          const parsed = ResearchEventSchema.safeParse(event);
          if (!parsed.success) { res.destroy(); detach(); return; }
          const frame = `data: ${JSON.stringify(parsed.data)}\n\n`;
          if (Buffer.byteLength(frame) > MAX_EVENT_BYTES || res.writableLength > MAX_EVENT_BYTES) { res.destroy(); detach(); return; }
          res.write(frame);
        });
        if (!streams.has(detach)) unsubscribe();
        else heartbeat = setInterval(() => {
          if (res.writableLength > MAX_EVENT_BYTES) { res.destroy(); detach(); }
          else res.write(": keepalive\n\n");
        }, 15_000);
      } catch (error) { detach(); throw error; }
      return;
    }
    throw transportError("not_found", "Owner endpoint not found.", 404);
  }

  const server = createServer((req, res) => {
    const pending = handle(req, res).catch(error => sendError(res, error));
    requests.add(pending);
    void pending.then(() => requests.delete(pending), () => requests.delete(pending));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owner transport did not bind.");

  function close() {
    closing ??= (async () => {
      stopping = true;
      for (const detach of [...streams]) detach();
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      await Promise.allSettled([...requests]);
      server.closeAllConnections();
      await closed;
    })();
    return closing;
  }
  try {
    metadata = OwnerMetadataSchema.parse({ pid: process.pid, port: address.port, token: randomBytes(32).toString("hex"), kind: options.kind, version: options.version });
    identity = { pid: metadata.pid, port: metadata.port, kind: metadata.kind, version: metadata.version };
    await options.lock.publish(metadata);
  } catch (error) { await close(); throw error; }
  return {
    metadata,
    get activity() { return { inflight: invocations.size, streams: streams.size, stopping, lastActivityAt }; },
    requestStop, close,
  };
}

function assertIdentity(actual: OwnerHealth, expected: OwnerMetadata) {
  if (actual.pid !== expected.pid || actual.port !== expected.port || actual.kind !== expected.kind || actual.version !== expected.version) {
    throw transportError("OWNER_IDENTITY_MISMATCH", "The owner instance changed. Discover its descriptor again before connecting.");
  }
}

async function responseData(response: Response): Promise<unknown> {
  const parsed = OwnerResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw transportError("OWNER_PROTOCOL_ERROR", "The owner returned an invalid response.");
  if (!parsed.data.ok) throw new OwnerTransportError(parsed.data.error, response.status);
  if (!response.ok) throw transportError("OWNER_PROTOCOL_ERROR", "The owner returned an unexpected HTTP status.");
  return parsed.data.data;
}

function parseFrame(frame: string) {
  const lines = frame.split(/\r?\n/);
  const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
  return { event, data };
}

/** A descriptor grants discovery only. Each operation authenticates the owner. */
export function createOwnerClient(descriptor: OwnerMetadata, version: string, options: { timeoutMs?: number } = {}) {
  const metadata = OwnerMetadataSchema.parse(descriptor);
  const timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? 30_000);
  const base = `http://127.0.0.1:${metadata.port}`;
  const headers = { Authorization: `Bearer ${metadata.token}`, [VERSION_HEADER]: version };

  async function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, signal?: AbortSignal, requestTimeoutMs: number | null = timeoutMs) {
    let timedOut = false;
    try {
      // Bun fetch can retry a POST when the connection dies before headers.
      // A lost response has an unknown completion, so use HTTP with no replay.
      return await new Promise<Response>((resolve, reject) => {
        const connection = httpRequest(`${base}${path}`, {
          method: init.method ?? "GET", headers: { ...headers, ...init.headers }, agent: false,
        }, response => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", fail);
          response.once("aborted", () => fail(new Error("Owner response ended early.")));
          response.once("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            finish();
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: responseHeaders }));
          });
        });
        const timer = requestTimeoutMs === null ? undefined
          : setTimeout(() => { timedOut = true; fail(new Error("Owner request timed out.")); connection.destroy(); }, requestTimeoutMs);
        const abort = () => { fail(new Error("Owner request aborted.")); connection.destroy(); };
        function finish() { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener("abort", abort); }
        function fail(error: Error) { finish(); reject(error); }
        signal?.addEventListener("abort", abort, { once: true });
        connection.once("error", fail);
        if (signal?.aborted) { abort(); return; }
        connection.end(init.body);
      });
    } catch {
      if (timedOut || (signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError")) {
        throw transportError("OWNER_TIMEOUT", "The owner request timed out. No request was replayed. Inspect saved state before retrying.", 504);
      }
      throw transportError("OWNER_UNAVAILABLE", "The owner connection ended or timed out. No request was replayed. Inspect saved state before retrying.");
    }
  }
  async function health(signal?: AbortSignal): Promise<OwnerHealth> {
    const response = await request("/health", {}, signal);
    const actual = OwnerHealthSchema.parse(await responseData(response));
    assertIdentity(actual, metadata);
    if (response.headers.get(VERSION_HEADER) !== actual.version) throw transportError("OWNER_PROTOCOL_ERROR", "The owner version header is invalid.");
    return actual;
  }
  async function compatibleHealth(signal?: AbortSignal) {
    const actual = await health(signal);
    if (actual.version !== version) throw ownerVersionError(actual, version);
  }

  return {
    health,
    async invoke(channel: string, payload?: unknown, invocation: { signal?: AbortSignal; timeoutMs?: number | null } = {}): Promise<unknown> {
      const invocationTimeout = invocation.timeoutMs === undefined ? timeoutMs : z.number().int().positive().nullable().parse(invocation.timeoutMs);
      await compatibleHealth(invocation.signal);
      const body = OwnerInvocationSchema.parse({ channel, payload });
      const response = await request("/invoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, invocation.signal, invocationTimeout);
      if (response.headers.get(VERSION_HEADER) !== version) throw transportError("OWNER_PROTOCOL_ERROR", "The owner version changed during invocation.");
      return responseData(response);
    },
    async stop(input: { force?: boolean } = {}) {
      const actual = await health();
      if (input.force && actual.version !== version) throw ownerVersionError(actual, version);
      const response = await request("/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: input.force ?? false }) });
      return OwnerStopResultSchema.parse(await responseData(response));
    },
    async subscribe(listener: (event: ResearchEvent) => void, subscription: { signal?: AbortSignal; onDisconnect?: (error: Error) => void } = {}): Promise<OwnerSubscription> {
      await compatibleHealth(subscription.signal);
      const controller = new AbortController();
      let detached = false;
      let connection: ClientRequest | undefined;
      let responseStream: IncomingMessage | undefined;
      const close = () => { detached = true; controller.abort(); responseStream?.destroy(); connection?.destroy(); };
      subscription.signal?.addEventListener("abort", close, { once: true });
      if (subscription.signal?.aborted) close();
      // The timeout covers only the handshake, never the lifetime of a watch.
      let handshakeTimedOut = false;
      const timer = setTimeout(() => {
        handshakeTimedOut = true;
        controller.abort();
        const error = transportError("OWNER_TIMEOUT", "The owner event handshake timed out. No request was replayed.", 504);
        connection?.destroy(error);
        responseStream?.destroy(error);
      }, timeoutMs);
      let iterator: AsyncIterator<unknown> | undefined;
      let buffer = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      async function nextFrame(): Promise<string> {
        while (true) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (separator?.index !== undefined) {
            const frame = buffer.slice(0, separator.index);
            if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) throw transportError("OWNER_PROTOCOL_ERROR", "The owner event is too large.");
            buffer = buffer.slice(separator.index + separator[0].length);
            return frame;
          }
          if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw transportError("OWNER_PROTOCOL_ERROR", "The owner event is too large.");
          const next = await iterator!.next();
          if (next.done) throw transportError("OWNER_DISCONNECTED", "The event stream disconnected. Watching detached; work was not cancelled or replayed.");
          if (!(next.value instanceof Uint8Array)) throw transportError("OWNER_PROTOCOL_ERROR", "The owner event bytes are invalid.");
          buffer += decoder.decode(next.value, { stream: true });
        }
      }
      const cleanup = () => {
        clearTimeout(timer);
        subscription.signal?.removeEventListener("abort", close);
        controller.abort();
        responseStream?.destroy();
        connection?.destroy();
      };
      try {
        // Use a destroyable HTTP stream. Bun fetch cancellation can leave an SSE
        // socket open, which would incorrectly keep an idle owner alive.
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const abort = () => { reject(new Error("Owner event handshake aborted.")); connection?.destroy(); };
          if (controller.signal.aborted) { abort(); return; }
          controller.signal.addEventListener("abort", abort, { once: true });
          connection = httpRequest(`${base}/events`, { headers, agent: false }, response => {
            controller.signal.removeEventListener("abort", abort);
            resolve(response);
          });
          connection.once("error", error => { controller.signal.removeEventListener("abort", abort); reject(error); });
          connection.end();
        });
        responseStream = response;
        if (response.statusCode !== 200) {
          let body = "";
          for await (const chunk of response) {
            body += Buffer.from(chunk).toString("utf8");
            if (Buffer.byteLength(body) > DEFAULT_MAX_BODY) throw transportError("OWNER_PROTOCOL_ERROR", "The owner error response is too large.");
          }
          const parsed = OwnerResponseSchema.parse(JSON.parse(body));
          if (!parsed.ok) throw new OwnerTransportError(parsed.error, response.statusCode);
          throw transportError("OWNER_PROTOCOL_ERROR", "The owner returned an unexpected HTTP status.");
        }
        if (response.headers[VERSION_HEADER] !== version || response.headers["content-type"]?.split(";")[0] !== "text/event-stream") {
          throw transportError("OWNER_PROTOCOL_ERROR", "The owner event handshake is invalid.");
        }
        iterator = response[Symbol.asyncIterator]();
        const handshake = parseFrame(await nextFrame());
        if (handshake.event !== "owner") throw transportError("OWNER_PROTOCOL_ERROR", "The owner event identity is missing.");
        assertIdentity(OwnerHealthSchema.parse(JSON.parse(handshake.data)), metadata);
        clearTimeout(timer);
      } catch (error) {
        cleanup();
        if (handshakeTimedOut) throw transportError("OWNER_TIMEOUT", "The owner event handshake timed out. No request was replayed.", 504);
        throw error;
      }
      const done = (async () => {
        try {
          while (!detached) {
            const frame = parseFrame(await nextFrame());
            if (!frame.data) continue;
            if (frame.event !== undefined && frame.event !== "message") throw transportError("OWNER_PROTOCOL_ERROR", "The owner sent an unexpected event type.");
            listener(ResearchEventSchema.parse(JSON.parse(frame.data)));
          }
        } catch (error) {
          if (!detached) {
            const failure = error instanceof Error ? error : transportError("OWNER_DISCONNECTED", "The event stream disconnected.");
            subscription.onDisconnect?.(failure);
            throw failure;
          }
        } finally { cleanup(); }
      })();
      // Consumers can use either done or onDisconnect without an unhandled
      // rejection. Returning the original promise preserves awaited failures.
      void done.catch(() => undefined);
      return { close, done };
    },
  };
}
