import { describe, expect, it } from 'vitest'
import {
  normalizeImageBaseUrl,
  normalizeOpenAiCompatibleSize,
  parseImages
} from '../shared.js'
import { defaultImageModelForBaseUrl, isXKiroBaseUrl } from '../adapters/openai-images.js'

/**
 * shared.ts 纯函数用例（自宿主 core/config/media-generator.test.ts 迁入）：
 * parseImages 深度遍历、OpenAI 兼容 size 白名单吸附、baseUrl 归一与 xKiro 默认模型。
 */
describe('media shared helpers', () => {
  it('parses b64 and url image payloads', () => {
    expect(
      parseImages({ data: [{ b64_json: 'abc' }, { url: 'https://example.com/a.png' }, {}] })
    ).toEqual(['data:image/png;base64,abc', 'https://example.com/a.png'])
    expect(parseImages(null)).toEqual([])
  })

  it('snaps non-whitelist sizes to the documented OpenAI-compatible size table', () => {
    expect(normalizeOpenAiCompatibleSize('1024x1024')).toBe('1024x1024')
    expect(normalizeOpenAiCompatibleSize('2048x1152')).toBe('2048x1152')
    expect(normalizeOpenAiCompatibleSize('3840x2160')).toBe('3840x2160')
    // 旧 dall-e 比例吸附到 1k 白名单
    expect(normalizeOpenAiCompatibleSize('1024x1792')).toBe('864x1536')
    expect(normalizeOpenAiCompatibleSize('1792x1024')).toBe('1536x864')
    // 非法自由分辨率按比例吸附（5678px 高 → 4k 档内选最近长宽比）
    expect(normalizeOpenAiCompatibleSize('1234x5678')).toBe('2160x3840')
    expect(normalizeOpenAiCompatibleSize(undefined)).toBeUndefined()
    expect(normalizeOpenAiCompatibleSize('auto')).toBeUndefined()
  })

  it('normalizes canvas base urls and resolves the xKiro model default', () => {
    expect(normalizeImageBaseUrl('https://api.xkiro.com')).toBe('https://api.xkiro.com/v1')
    expect(normalizeImageBaseUrl('https://api.xkiro.com/v1/')).toBe('https://api.xkiro.com/v1')
    expect(normalizeImageBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(isXKiroBaseUrl('https://api.xkiro.com/v1')).toBe(true)
    expect(isXKiroBaseUrl('https://xkiro.com.example.net')).toBe(false)
    expect(defaultImageModelForBaseUrl('https://api.xkiro.com/v1')).toBe('gpt-image')
    expect(defaultImageModelForBaseUrl('https://api.openai.com/v1')).toBe('dall-e-3')
  })
})
