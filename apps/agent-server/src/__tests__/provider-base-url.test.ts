import { describe, expect, it } from 'vitest'
import { buildProviderModelsUrl, normalizeProviderBaseUrl } from '../core/config/provider-base-url.js'

describe('normalizeProviderBaseUrl', () => {
  it('adds the OpenAI-compatible /v1 API root', () => {
    expect(normalizeProviderBaseUrl('openai-completions', 'https://www.fastaitoken.com'))
      .toBe('https://www.fastaitoken.com/v1')
    expect(normalizeProviderBaseUrl('openai-responses', 'https://gateway.example.com/api'))
      .toBe('https://gateway.example.com/api/v1')
  })

  it('does not duplicate /v1 and removes trailing slashes', () => {
    expect(normalizeProviderBaseUrl('openai-completions', 'https://api.example.com/v1/'))
      .toBe('https://api.example.com/v1')
  })

  it('does not append /v1 for non-OpenAI APIs', () => {
    expect(normalizeProviderBaseUrl('anthropic-messages', 'https://api.example.com/'))
      .toBe('https://api.example.com')
  })
})

describe('buildProviderModelsUrl', () => {
  it('uses the same normalized API root as runtime requests', () => {
    expect(buildProviderModelsUrl('openai-completions', 'https://www.fastaitoken.com'))
      .toBe('https://www.fastaitoken.com/v1/models')
  })
})
