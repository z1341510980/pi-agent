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

/**
 * 调用后端 API（返回 ApiResponse 包装格式：{ ok, data, error, meta }）
 * 适用于 /api/* 路由
 */
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

/**
 * 调用 AG-UI 端点（返回裸 JSON，无 ApiResponse 包装）
 * 适用于 /ag-ui/* 路由
 */
export async function getAgui<T>(path: string): Promise<T> {
  const response = await fetch(`${browserConfig.aguiBaseUrl}${path}`, {
    method: 'GET'
  })

  if (!response.ok) {
    throw new ApiClientError(
      `AG-UI 请求失败: HTTP ${response.status}`,
      'AGUI_ERROR'
    )
  }

  return (await response.json()) as T
}

/**
 * POST 调用 AG-UI 端点（返回裸 JSON，无 ApiResponse 包装）
 * 适用于 /ag-ui/* 路由
 */
export async function postAgui<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.aguiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new ApiClientError(
      `AG-UI 请求失败: HTTP ${response.status}`,
      'AGUI_ERROR'
    )
  }

  return (await response.json()) as T
}

export async function putApi<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

export async function deleteApi<T>(path: string): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'DELETE'
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

export async function postApi<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
