import { describe, expect, it, vi } from 'vitest'
import { CredentialBridge } from '../core/config/credential-bridge.js'

describe('CredentialBridge', () => {
  it('从环境变量获取 API Key', async () => {
    process.env.PI_API_KEY_OPENAI = 'sk-test-openai-key'
    const bridge = new CredentialBridge()
    const key = await bridge.getApiKey('openai')
    expect(key).toBe('sk-test-openai-key')
    delete process.env.PI_API_KEY_OPENAI
  })

  it('回退到通用 PI_API_KEY', async () => {
    process.env.PI_API_KEY = 'sk-generic-key'
    const bridge = new CredentialBridge()
    const key = await bridge.getApiKey('unknown-provider')
    expect(key).toBe('sk-generic-key')
    delete process.env.PI_API_KEY
  })

  it('无 Key 时返回 undefined', async () => {
    const bridge = new CredentialBridge()
    const key = await bridge.getApiKey('nonexistent')
    expect(key).toBeUndefined()
  })

  it('支持自定义 Key 获取器', async () => {
    const customFetcher = vi.fn().mockResolvedValue('custom-key')
    const bridge = new CredentialBridge(customFetcher)
    const key = await bridge.getApiKey('openai')
    expect(key).toBe('custom-key')
    expect(customFetcher).toHaveBeenCalledWith('openai')
  })
})
