import { request as httpRequest } from "node:http";
import { z } from "zod";
import { ApiErrorResponseSchema, ApiResponseSchema, type BackendReady } from "../shared/ipc";
import { AppError } from "../shared/errors";

/** One HTTP attempt only: a lost response never replays an admitted mutation. */
export async function requestBackend(ready: BackendReady, path: string, init?: RequestInit): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//") || (init?.body != null && typeof init.body !== "string")) {
    throw new AppError("validation_error", "Invalid local backend request.");
  }
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${ready.token}`);
  headers.set("content-type", "application/json");
  let response: { status: number; body: string };
  try {
    response = await new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: "127.0.0.1", port: ready.port, path, method: init?.method ?? "GET",
        headers: Object.fromEntries(headers.entries()), agent: false,
        ...(init?.signal ? { signal: init.signal } : {}),
      }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("aborted", () => reject(new Error("Incomplete backend response")));
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.once("error", reject);
      request.end(init?.body ?? undefined);
    });
  } catch {
    throw new AppError("backend_unavailable", "The local backend connection ended. No request was replayed. Inspect saved state before retrying.");
  }
  let payload: unknown;
  try { payload = JSON.parse(response.body); }
  catch { throw new AppError("internal_error", "The local backend returned an invalid response."); }
  if (response.status < 200 || response.status >= 300) {
    const parsed = ApiErrorResponseSchema.safeParse(payload);
    if (!parsed.success) throw new AppError("internal_error");
    const { code, message, reference, recovery } = parsed.data.error;
    throw new AppError(code, message, response.status, reference, recovery);
  }
  const parsed = ApiResponseSchema(z.unknown()).safeParse(payload);
  if (!parsed.success || !parsed.data.ok) throw new AppError("internal_error");
  return parsed.data.data;
}
