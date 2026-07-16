const OPENAI_COMPATIBLE_APIS = new Set(['openai-completions', 'openai-responses'])

/** Normalize the API root expected by the OpenAI SDK. */
export function normalizeProviderBaseUrl(api: string, baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (!OPENAI_COMPATIBLE_APIS.has(api) || normalized.endsWith('/v1')) {
    return normalized
  }
  return `${normalized}/v1`
}

export function buildProviderModelsUrl(api: string, baseUrl: string): string {
  return `${normalizeProviderBaseUrl(api, baseUrl)}/models`
}
