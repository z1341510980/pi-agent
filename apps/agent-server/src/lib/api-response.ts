import type { ApiFailure, ApiSuccess } from "@repo/shared/api";

export function createTraceId() {
  return crypto.randomUUID();
}

export function success<T>(data: T, traceId: string): ApiSuccess<T> {
  return {
    ok: true,
    data,
    meta: {
      traceId,
      timestamp: Date.now(),
    },
  };
}

export function failure(
  code: string,
  message: string,
  traceId: string,
  details?: unknown,
): ApiFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
    meta: {
      traceId,
      timestamp: Date.now(),
    },
  };
}
