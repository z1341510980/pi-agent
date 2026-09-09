export type ApiMeta = {
  traceId: string;
  timestamp: number;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: ApiMeta;
};

export type ApiFailure = {
  ok: false;
  /** String errors are accepted for compatibility with older plugin routes. */
  error:
    | string
    | {
        code: string;
        message: string;
        details?: unknown;
      };
  meta: ApiMeta;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function isApiSuccess<T>(
  response: ApiResponse<T>,
): response is ApiSuccess<T> {
  return response.ok;
}
