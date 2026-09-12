import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildOssPutRequest,
  buildOssStringToSign,
  clearAimanplayOssCaches,
  setAimanplayOssAssetDataUrlResolver,
  siteOriginFromBaseUrl,
  uploadToAimanplayOss,
  type AimanplayStsCredentials
} from '../aimanplay-oss.js'

/**
 * aimanplay OSS 素材桥用例：签名串 6 段组合（Date 槽位 = x-oss-date 同值）、
 * PUT 请求拼装、STS 获取/缓存/过期、大小上限与 disabled 的可读错误、
 * http(s) 直传、资产路径解析器与内容缓存。
 */

const STS: AimanplayStsCredentials = {
  host: 'https://aima-bucket.oss-cn-hangzhou.aliyuncs.com',
  bucket: 'aima-bucket',
  dir: 'video-upload/2026',
  accessKeyId: 'STS_AK',
  accessKeySecret: 'STS_SK',
  securityToken: 'STS_TOKEN',
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  maxImageBytes: 10 * 1024 * 1024,
  maxAudioBytes: 20 * 1024 * 1024
}

/** 模拟站点 STS 接口响应（§3.1）：success/enabled + 凭证字段。 */
const STS_RESPONSE = {
  success: true,
  enabled: true,
  message: '',
  region: 'oss-cn-hangzhou',
  ...STS
}

const RUNTIME = { providerId: 'video', baseUrl: 'https://aimanplay.cn/v1', apiKey: 'sk-test' }

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const isStsRequest = (url: unknown): boolean => String(url).includes('/api/video-upload/oss-sts')
const isOssPut = (url: unknown): boolean => String(url).includes('.aliyuncs.com')

describe('aimanplay OSS 素材桥', () => {
  beforeEach(() => {
    clearAimanplayOssCaches()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setAimanplayOssAssetDataUrlResolver(undefined)
  })

  it('buildOssStringToSign：冻结日期向量断言 6 段组合（Date 槽位=x-oss-date、无空格 canonical headers、/bucket/key）', () => {
    const date = 'Wed, 03 Sep 2026 12:00:00 GMT'
    expect(
      buildOssStringToSign({
        verb: 'PUT',
        contentType: 'image/png',
        date,
        bucket: 'aima-bucket',
        key: 'video-upload/2026/abc.png',
        securityToken: 'TOKEN-1'
      })
    ).toBe(
      [
        'PUT',
        '',
        'image/png',
        date,
        `x-oss-date:${date}\nx-oss-object-acl:public-read\nx-oss-security-token:TOKEN-1`,
        '/aima-bucket/video-upload/2026/abc.png'
      ].join('\n')
    )
  })

  it('buildOssPutRequest：Authorization 为 OSS AK:base64(HMAC-SHA1(secret, stringToSign))，头与 url 齐备', () => {
    const date = 'Wed, 03 Sep 2026 12:00:00 GMT'
    const request = buildOssPutRequest(STS, 'image/png', 'video-upload/2026/abc.png', date)
    expect(request.url).toBe(`${STS.host}/video-upload/2026/abc.png`)
    const expectedSignature = createHmac('sha1', STS.accessKeySecret)
      .update(
        buildOssStringToSign({
          verb: 'PUT',
          contentType: 'image/png',
          date,
          bucket: STS.bucket,
          key: 'video-upload/2026/abc.png',
          securityToken: STS.securityToken
        }),
        'utf8'
      )
      .digest('base64')
    expect(request.headers.Authorization).toBe(`OSS ${STS.accessKeyId}:${expectedSignature}`)
    expect(request.headers).toMatchObject({
      'Content-Type': 'image/png',
      'x-oss-date': date,
      'x-oss-object-acl': 'public-read',
      'x-oss-security-token': STS.securityToken
    })
  })

  it('siteOriginFromBaseUrl：剥离 /v1 得到站点根', () => {
    expect(siteOriginFromBaseUrl('https://aimanplay.cn/v1')).toBe('https://aimanplay.cn')
    expect(siteOriginFromBaseUrl('https://aimanplay.cn/v1/')).toBe('https://aimanplay.cn')
    expect(siteOriginFromBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234')
    expect(siteOriginFromBaseUrl('https://aimanplay.cn')).toBe('https://aimanplay.cn')
  })

  it('http(s) 素材原样返回，不触发任何上传', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const url = 'https://cdn.example.com/pic.png'
    await expect(uploadToAimanplayOss(RUNTIME, url, 'image')).resolves.toBe(url)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('data URL 上传：STS + 签名 PUT + 公开 URL 拼装；第二次上传命中 STS 缓存只发 PUT', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(STS_RESPONSE))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))

    const url1 = await uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    const url2 = await uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,BBBB', 'image')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    // STS：POST {站点根}/api/video-upload/oss-sts，Bearer 同一 sk 令牌
    expect(fetchMock.mock.calls[0][0]).toBe('https://aimanplay.cn/api/video-upload/oss-sts')
    const stsInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(stsInit.method).toBe('POST')
    expect(stsInit.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    // PUT：签名头 + public-read + security token，key = dir/uuid.ext
    expect(url1).toMatch(
      /^https:\/\/aima-bucket\.oss-cn-hangzhou\.aliyuncs\.com\/video-upload\/2026\/[0-9a-f-]{36}\.png$/
    )
    expect(url2).toMatch(/\.png$/)
    expect(url2).not.toBe(url1)
    const putInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(putInit.method).toBe('PUT')
    expect(putInit.headers).toMatchObject({
      'Content-Type': 'image/png',
      'x-oss-object-acl': 'public-read',
      'x-oss-security-token': STS.securityToken
    })
    expect(
      (putInit.headers as Record<string, string>).Authorization?.startsWith(
        `OSS ${STS.accessKeyId}:`
      )
    ).toBe(true)
  })

  it('STS 过期（expiration 已过）后重新获取凭证', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const expired = { ...STS_RESPONSE, expiration: new Date(Date.now() - 1000).toISOString() }
    fetchMock
      .mockResolvedValueOnce(jsonResponse(expired))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(expired))
      .mockResolvedValueOnce(new Response('', { status: 200 }))

    await uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    await uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,BBBB', 'image')

    expect(fetchMock.mock.calls.filter(([url]) => isStsRequest(url))).toHaveLength(2)
  })

  it('内容缓存：同 providerId 相同字节重复上传只 PUT 一次并返回同一 URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(STS_RESPONSE))
      .mockResolvedValueOnce(new Response('', { status: 200 }))

    const url1 = await uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    const url2 = await uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')

    expect(url2).toBe(url1)
    expect(fetchMock.mock.calls.filter(([url]) => isOssPut(url))).toHaveLength(1)
  })

  it('素材超过 maxImageBytes/maxAudioBytes 时报可读错误且不发起 PUT', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...STS_RESPONSE, maxImageBytes: 2 }))

    await expect(
      uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    ).rejects.toThrow('超过 OSS 上限 2B')
    expect(fetchMock.mock.calls.filter(([url]) => isOssPut(url))).toHaveLength(0)
  })

  it('enabled=false 时报可读错误（含站点 message）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, enabled: false, message: 'OSS 未开启' })
    )
    await expect(
      uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    ).rejects.toThrow('OSS 上传未开启：OSS 未开启')
  })

  it('HTTP 503（success=false）透出站点 message', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, message: '未开启' }, 503))
    await expect(
      uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    ).rejects.toThrow('OSS 上传凭证获取失败: 未开启')
  })

  it('OSS PUT 非 2xx 报可读错误（含状态码与响应片段）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(STS_RESPONSE))
      .mockResolvedValueOnce(
        new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })
      )
    await expect(
      uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    ).rejects.toThrow('OSS 上传失败: HTTP 403')
  })

  it('网络错误包装为带上下文的可读错误', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(
      uploadToAimanplayOss(RUNTIME, 'data:image/png;base64,AAAA', 'image')
    ).rejects.toThrow(
      'OSS 上传凭证获取失败（https://aimanplay.cn/api/video-upload/oss-sts）：ECONNREFUSED'
    )
  })

  it('资产路径经注入的解析器物化为 data URL 后上传（mime 决定扩展名）', async () => {
    setAimanplayOssAssetDataUrlResolver(async (source) => {
      expect(source).toBe('/api/plugins/infinite-canvas/assets/abc')
      return 'data:image/jpeg;base64,CCCC'
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(STS_RESPONSE))
      .mockResolvedValueOnce(new Response('', { status: 200 }))

    const url = await uploadToAimanplayOss(
      RUNTIME,
      '/api/plugins/infinite-canvas/assets/abc',
      'image'
    )
    expect(url).toMatch(
      /^https:\/\/aima-bucket\.oss-cn-hangzhou\.aliyuncs\.com\/video-upload\/2026\/[0-9a-f-]{36}\.jpg$/
    )
  })

  it('未注入解析器时资产路径报可读错误且不发起请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      uploadToAimanplayOss(RUNTIME, '/api/plugins/infinite-canvas/assets/abc', 'image')
    ).rejects.toThrow('本地资产素材缺少解析器')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('音频素材按 mime 决定扩展名（audio/mpeg → mp3），上限走 maxAudioBytes', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(STS_RESPONSE))
      .mockResolvedValueOnce(new Response('', { status: 200 }))

    const url = await uploadToAimanplayOss(RUNTIME, 'data:audio/mpeg;base64,AAAA', 'audio')
    expect(url).toMatch(/\.mp3$/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
