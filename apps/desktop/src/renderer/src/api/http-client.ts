import type { ApiResponse } from '@repo/shared/api'
import { browserConfig } from '@repo/config/browser'
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly traceId?: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

export async function getApi<T>(path: string): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'GET'
  })

  const body = (await response.json()) as ApiResponse<T>

  if (!body.ok) {
    throw new ApiClientError(
      body.error.message,
      body.error.code,
      body.meta.traceId,
      body.error.details
    )
  }

  return body.data
}
