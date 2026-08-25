/**
 * Structured Outputs（方案 A2）支持度探测与响应格式注入构建。
 *
 * 背景：`response_format: { type: 'json_object' }` 只承诺"合法 JSON"，
 * 不约束结构，且大量中转网关直接忽略该字段；模型仍会输出寒暄前缀。
 * `json_schema`（strict）是推理时语法约束解码——合法性与结构同时得到
 * 数学保证。但支持面远小于 json_object：OpenAI 官方端点、部分自建
 * vLLm/推理栈支持；多数中转、Anthropic 系不支持（会 400 或忽略）。
 *
 * 因此策略是探测 + 分档：
 * - strict       → 注入 json_schema（严格结构）
 * - json-object  → 退回 json_object（仅合法性）
 * - unsupported  → 不注入（由调用方的容错解析兜底）
 *
 * 探测口径（保守优先，误开 strict 会直接 400 打断任务）：
 * 1. PI_STRUCTURED_OUTPUTS=off        → 全局关闭
 * 2. PI_JSON_SCHEMA_STRICT_PROVIDERS  → 按.provider 名强制启用清单
 * 3. 官方 OpenAI 端点                  → 默认 strict
 * 4. 其余                              → unknown（调用方维持既有行为）
 *
 * 与 cache-control-support 相同的定位：纯函数、可单测、调用方只消费结果。
 */

export type JsonSchemaSupport = 'strict' | 'json-object' | 'unsupported'

const OFFICIAL_OPENAI_HOSTS = new Set(['api.openai.com'])

function normalizeHost(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return undefined
  }
}

export function resolveJsonSchemaSupport(
  input: { provider?: string; baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env
): JsonSchemaSupport {
  if ((env.PI_STRUCTURED_OUTPUTS ?? '').toLowerCase() === 'off') return 'unsupported'
  const provider = (input.provider ?? '').trim().toLowerCase()
  const forced = (env.PI_JSON_SCHEMA_STRICT_PROVIDERS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (provider && forced.includes(provider)) return 'strict'
  const host = normalizeHost(input.baseUrl)
  if (host && OFFICIAL_OPENAI_HOSTS.has(host)) return 'strict'
  // 未知网关保守处理：误开 strict 会 400 打断任务，宁可不注入
  return 'unsupported'
}

export interface ResponseFormatInjection {
  response_format?: unknown
  tool_choice?: unknown
}

/**
 * 构建 provider payload 的响应格式注入片段。
 *
 * - responseJsonSchema + strict → json_schema 严格结构化输出
 * - responseFormat === 'json'   → json_object（既有行为，字节级不变）
 * - 其余                        → 空对象（不注入）
 *
 * 注意：两条互斥路径都附带 tool_choice='none'——结构化输出场景下工具调用
 * 是干扰项，且部分网关在 json 模式下收到 tool_calls 会产生消息不成对错误。
 */
export function buildResponseFormatInjection(opts: {
  responseFormat?: 'json' | 'text'
  responseJsonSchema?: { name: string; schema: Record<string, unknown> }
  support: JsonSchemaSupport
}): ResponseFormatInjection {
  if (opts.responseJsonSchema) {
    if (opts.support !== 'strict') return {}
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: opts.responseJsonSchema.name,
          schema: opts.responseJsonSchema.schema,
          strict: true
        }
      },
      tool_choice: 'none'
    }
  }
  if (opts.responseFormat === 'json') {
    return { response_format: { type: 'json_object' }, tool_choice: 'none' }
  }
  return {}
}
