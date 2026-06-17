/**
 * CredentialBridge：API Key 获取桥接
 *
 * 优先级：
 * 1. 自定义 Key 获取器（用于 Electron safeStorage 桥接）
 * 2. Provider 专用环境变量 PI_API_KEY_{PROVIDER}
 * 3. 通用环境变量 PI_API_KEY
 */
export class CredentialBridge {
  private readonly customFetcher?: (provider: string) => Promise<string | undefined>

  constructor(customFetcher?: (provider: string) => Promise<string | undefined>) {
    this.customFetcher = customFetcher
  }

  /** 获取指定 Provider 的 API Key */
  async getApiKey(provider: string): Promise<string | undefined> {
    // 1. 自定义获取器
    if (this.customFetcher) {
      const key = await this.customFetcher(provider)
      if (key) return key
    }

    // 2. Provider 专用环境变量
    const envKey = `PI_API_KEY_${provider.toUpperCase().replace(/-/g, '_')}`
    const providerKey = process.env[envKey]
    if (providerKey) return providerKey

    // 3. 通用环境变量
    return process.env.PI_API_KEY
  }
}
