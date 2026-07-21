import { ZodError } from "zod";
import type { AppErrorCode, AppErrorPayload } from "./ipc";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  provider_timeout: 504,
  backend_unavailable: 503,
  secure_storage_unavailable: 503,
  internal_error: 500,
};

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  validation_error: "The request is invalid.",
  unauthorized: "The request is not authorized.",
  not_found: "The requested item was not found.",
  conflict: "The request conflicts with the current state.",
  provider_timeout: "A provider timed out. Please try again.",
  backend_unavailable: "The local backend is unavailable.",
  secure_storage_unavailable: "Secure storage is unavailable. Secrets were not saved.",
  internal_error: "Something went wrong. Please try again.",
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message = DEFAULT_MESSAGES[code], status = STATUS_BY_CODE[code]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError || error instanceof SyntaxError) return new AppError("validation_error");
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new AppError("provider_timeout");
  }
  return new AppError("internal_error");
}

export function toErrorPayload(error: unknown): { status: number; error: AppErrorPayload } {
  const normalized = normalizeAppError(error);
  return {
    status: normalized.status,
    error: { code: normalized.code, message: normalized.message },
  };
}
