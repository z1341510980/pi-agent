import { describe, expect, it } from 'vitest'
import {
  buildResponseFormatInjection,
  resolveJsonSchemaSupport
} from '../core/plugin/structured-outputs-support.js'

describe('resolveJsonSchemaSupport', () => {
  it('官方 OpenAI 端点默认 strict', () => {
    expect(
      resolveJsonSchemaSupport({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
    ).toBe('strict')
  })

  it('显式强制清单按 provider 名命中（大小写不敏感）', () => {
    const env = { PI_JSON_SCHEMA_STRICT_PROVIDERS: ' My-Relay , deepseek' }
    expect(resolveJsonSchemaSupport({ provider: 'my-relay' }, env)).toBe('strict')
    expect(resolveJsonSchemaSupport({ provider: 'DeepSeek' }, env)).toBe('strict')
    expect(resolveJsonSchemaSupport({ provider: 'other' }, env)).toBe('unsupported')
  })

  it('PI_STRUCTURED_OUTPUTS=off 全局关闭，优先级高于强制清单', () => {
    const env = {
      PI_STRUCTURED_OUTPUTS: 'off',
      PI_JSON_SCHEMA_STRICT_PROVIDERS: 'my-relay'
    }
    expect(resolveJsonSchemaSupport({ provider: 'my-relay' }, env)).toBe('unsupported')
    expect(
      resolveJsonSchemaSupport(
        { provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
        env
      )
    ).toBe('unsupported')
  })

  it('未知网关保守返回 unsupported（误开 strict 会 400 打断任务）', () => {
    expect(resolveJsonSchemaSupport({ provider: 'some-relay', baseUrl: 'https://x.example.com' })).toBe(
      'unsupported'
    )
  })
})

describe('buildResponseFormatInjection', () => {
  const schema = { name: 'chunk_observations', schema: { type: 'object' } }

  it('strict 支持：注入 json_schema + tool_choice none', () => {
    const injection = buildResponseFormatInjection({
      responseJsonSchema: schema,
      support: 'strict'
    })
    expect(injection.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'chunk_observations', strict: true }
    })
    expect(injection.tool_choice).toBe('none')
  })

  it('带 schema 但探测非 strict：不注入（调用方维持既有行为）', () => {
    expect(buildResponseFormatInjection({ responseJsonSchema: schema, support: 'unsupported' })).toEqual({})
  })

  it('responseFormat=json 且无 schema：维持 json_object 既有行为', () => {
    const injection = buildResponseFormatInjection({ responseFormat: 'json', support: 'strict' })
    expect(injection.response_format).toEqual({ type: 'json_object' })
    expect(injection.tool_choice).toBe('none')
  })

  it('纯文本会话：不注入任何响应格式', () => {
    expect(buildResponseFormatInjection({ responseFormat: 'text', support: 'strict' })).toEqual({})
  })
})
