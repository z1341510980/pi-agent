/**
 * aimanplay OSS 素材桥（aimanplay 视频适配设计 Task 1）。
 *
 * aimanplay.cn 视频生成接口只收 URL 不收 base64（api.md §3）——参考图/参考音频
 * 必须先上传到站点 OSS 换取公开 URL 再进提交体。本桥把三类素材统一物化：
 * - http(s) 公网 URL：原样返回（上游可直接取）；
 * - data URL：解析出字节与 mime；
 * - 本地资产路径（/api/plugins/infinite-canvas/assets/:id）：经插件注入的
 *   资产解析器（canvas-assets.referenceToDataUrl）读盘转 data URL。
 *
 * 上传协议（api.md §3）：POST {站点根}/api/video-upload/oss-sts 取 STS 凭证
 * （Bearer 同一 sk 令牌，凭证 1h 有效，模块级按 providerId 缓存至过期前 5min），
 * 再按 OSS V1 签名 PUT（x-oss-object-acl: public-read 参与签名；StringToSign 的
 * Date 槽位必须填 x-oss-date 同值——留空会 SignatureDoesNotMatch，生产实测坑）。
 * 公开 URL = {host}/{dir}/{uuid}.{ext}。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mediaDiag } from '../../../core/config/media-diag.js'
import { errorText } from './shared.js'
import { ASSET_PATH_PREFIX } from '../canvas-assets.js'

/** 上传运行时：provider 行解析出的身份（baseUrl 以 /v1 结尾，站点根按需剥离）。 */
export interface AimanplayOssRuntime {
  providerId: string
  baseUrl: string
  apiKey: string
}

/** STS 凭证中参与签名/URL 拼装与上限校验的字段（api.md §3.1 响应）。 */
export interface AimanplayStsCredentials {
  host: string
  bucket: string
  dir: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  /** ISO8601 过期时间；缺失/不可解析时不缓存（每次上传重取）。 */
  expiration: string
  /** 图片/音频大小上限（字节）；0 表示响应未声明，跳过上限校验。 */
  maxImageBytes: number
  maxAudioBytes: number
}

/** 本地资产路径 → data URL 的解析器：桥不持有 CanvasAssetStore，由插件装配时注入。 */
export type AimanplayOssAssetResolver = (source: string) => Promise<string>

let assetDataUrlResolver: AimanplayOssAssetResolver | undefined

/** 插件装配时注入资产解析器；传 undefined 解除注入（测试隔离用）。 */
export function setAimanplayOssAssetDataUrlResolver(
  resolver: AimanplayOssAssetResolver | undefined
): void {
  assetDataUrlResolver = resolver
}

/** baseUrl（…/v1）→ 站点根 origin：STS 路由挂在站点根而非 /v1 下。 */
export function siteOriginFromBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
  let origin = trimmed
  let path = ''
  try {
    const url = new URL(trimmed)
    origin = url.origin
    path = url.pathname
  } catch {
    // 非法 URL 退化为字符串截断：scheme://host 后第一段路径
    const schemeIndex = trimmed.indexOf('://')
    if (schemeIndex > 0) {
      const rest = trimmed.slice(schemeIndex + 3)
      const firstSlash = rest.indexOf('/')
      if (firstSlash > 0) {
        origin = trimmed.slice(0, schemeIndex + 3 + firstSlash)
        path = rest.slice(firstSlash)
      }
    }
  }
  const cleanPath = path.replace(/\/+$/, '')
  return cleanPath.toLowerCase().endsWith('/v1')
    ? `${origin}${cleanPath.slice(0, -3)}`
    : `${origin}${cleanPath}`
}

/**
 * OSS V1 StringToSign（纯函数，供单测做已知向量断言）：
 * 6 段 \n 连接 —— VERB、Content-MD5（空串）、Content-Type、Date、
 * CanonicalizedOSSHeaders、CanonicalizedResource(/bucket/key)。
 * canonical headers 按 x-oss-* 名排序，name:value（冒号后无空格）。
 */
export function buildOssStringToSign(input: {
  verb: 'PUT'
  contentType: string
  date: string
  bucket: string
  key: string
  securityToken: string
}): string {
  const canonicalHeaders = [
    `x-oss-date:${input.date}`,
    'x-oss-object-acl:public-read',
    `x-oss-security-token:${input.securityToken}`
  ]
    .sort()
    .join('\n')
  return [
    input.verb,
    '',
    input.contentType,
    // Date 槽位必须与 x-oss-date 头同值（浏览器禁设 Date 头，时间戳由 x-oss-date 承载）
    input.date,
    canonicalHeaders,
    `/${input.bucket}/${input.key}`
  ].join('\n')
}

/** 由 STS 凭证拼装签名 PUT 请求（url 即上传完成后的公开 URL）。 */
export function buildOssPutRequest(
  sts: AimanplayStsCredentials,
  contentType: string,
  key: string,
  date: string
): { url: string; headers: Record<string, string> } {
  const stringToSign = buildOssStringToSign({
    verb: 'PUT',
    contentType,
    date,
    bucket: sts.bucket,
    key,
    securityToken: sts.securityToken
  })
  const signature = createHmac('sha1', sts.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64')
  return {
    url: `${sts.host}/${key}`,
    headers: {
      Authorization: `OSS ${sts.accessKeyId}:${signature}`,
      'Content-Type': contentType,
      'x-oss-date': date,
      'x-oss-object-acl': 'public-read',
      'x-oss-security-token': sts.securityToken
    }
  }
}

const AUDIO_EXT_BY_SUBTYPE: Record<string, string> = {
  mpeg: 'mp3',
  mp3: 'mp3',
  wav: 'wav',
  'x-wav': 'wav',
  ogg: 'ogg',
  flac: 'flac',
  aac: 'aac',
  mp4: 'm4a'
}

/** 对象 key 扩展名：image/png→png、image/jpeg→jpg、audio/* 按子类型（缺省 mp3）、其余 bin。 */
function extFromMime(mime: string): string {
  const normalized = mime.split(';')[0].trim().toLowerCase()
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized.startsWith('audio/')) {
    return AUDIO_EXT_BY_SUBTYPE[normalized.slice('audio/'.length)] ?? 'mp3'
  }
  return 'bin'
}

function parseDataUrl(value: string): { bytes: Buffer; mime: string } | undefined {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value)
  if (!match) return undefined
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  return { bytes, mime: match[1] || 'application/octet-stream' }
}

async function materializeSourceBytes(
  source: string,
  kind: 'image' | 'audio'
): Promise<{ bytes: Buffer; mime: string }> {
  const label = kind === 'image' ? '参考图' : '参考音频'
  if (source.startsWith('data:')) {
    const parsed = parseDataUrl(source)
    if (!parsed || !parsed.bytes.length) {
      throw new Error(`${label} data URL 无法解析出有效内容`)
    }
    return parsed
  }
  if (source.startsWith(`${ASSET_PATH_PREFIX}/`)) {
    if (!assetDataUrlResolver) {
      throw new Error(`本地资产素材缺少解析器，无法上传 OSS：${source}`)
    }
    const dataUrl = await assetDataUrlResolver(source)
    const parsed = parseDataUrl(dataUrl)
    if (!parsed || !parsed.bytes.length) {
      throw new Error(`本地资产素材读取失败：${source}`)
    }
    return parsed
  }
  throw new Error(
    `不支持的素材地址（仅支持 data URL / 本地资产路径 / http(s) URL）：${source.slice(0, 120)}`
  )
}

/** STS 缓存：按 providerId，过期前 5min 视为失效（留足跨请求余量）。 */
const STS_REFRESH_MARGIN_MS = 5 * 60_000

interface StsCacheEntry {
  credentials: AimanplayStsCredentials
  validUntilMs: number
}

const stsCache = new Map<string, StsCacheEntry>()
/** 内容缓存：providerId:sha256(bytes) → 公开 URL（重复素材免重复上传）。 */
const contentUrlCache = new Map<string, string>()
const CONTENT_CACHE_MAX_ENTRIES = 200

/** 清空 STS 与内容缓存：模块级缓存会跨用例残留，测试隔离用。 */
export function clearAimanplayOssCaches(): void {
  stsCache.clear()
  contentUrlCache.clear()
}

function readStsCredentials(body: unknown): AimanplayStsCredentials | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const str = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const host = str('host')?.replace(/\/+$/, '')
  const bucket = str('bucket')
  const dir = str('dir')
  const accessKeyId = str('accessKeyId')
  const accessKeySecret = str('accessKeySecret')
  const securityToken = str('securityToken')
  if (!host || !bucket || !dir || !accessKeyId || !accessKeySecret || !securityToken) {
    return undefined
  }
  const num = (key: string): number => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  return {
    host,
    bucket,
    dir,
    accessKeyId,
    accessKeySecret,
    securityToken,
    expiration: typeof record.expiration === 'string' ? record.expiration : '',
    maxImageBytes: num('maxImageBytes'),
    maxAudioBytes: num('maxAudioBytes')
  }
}

async function fetchAimanplaySts(runtime: AimanplayOssRuntime): Promise<AimanplayStsCredentials> {
  const cached = stsCache.get(runtime.providerId)
  if (cached && cached.validUntilMs > Date.now()) return cached.credentials
  const endpoint = `${siteOriginFromBaseUrl(runtime.baseUrl)}/api/video-upload/oss-sts`
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {},
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    throw new Error(`OSS 上传凭证获取失败（${endpoint}）：${errorText(error)}`)
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const message =
    typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : ''
  if (!response.ok) {
    throw new Error(`OSS 上传凭证获取失败: ${message || `HTTP ${response.status}`}`)
  }
  if (body?.enabled === false) {
    throw new Error(`OSS 上传未开启：${message || '站点未启用 OSS 上传功能'}`)
  }
  if (body?.success === false) {
    throw new Error(`OSS 上传凭证获取失败: ${message || '站点返回 success=false'}`)
  }
  const credentials = readStsCredentials(body)
  if (!credentials) {
    throw new Error(
      'OSS 上传凭证响应缺少必要字段（host/bucket/dir/accessKeyId/accessKeySecret/securityToken）'
    )
  }
  const expiresAtMs = Date.parse(credentials.expiration)
  if (Number.isFinite(expiresAtMs)) {
    stsCache.set(runtime.providerId, {
      credentials,
      validUntilMs: expiresAtMs - STS_REFRESH_MARGIN_MS
    })
  }
  return credentials
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${bytes}B`
}

/**
 * 素材 → OSS 公开 URL：http(s) 原样返回；data URL/资产路径解析出字节后
 * 按内容 sha256 查缓存（命中免上传）→ 取 STS → 上限校验 → 签名 PUT。
 * 所有失败都抛可读错误；网络错误包装上下文后重抛。
 */
export async function uploadToAimanplayOss(
  runtime: AimanplayOssRuntime,
  source: string,
  kind: 'image' | 'audio'
): Promise<string> {
  const trimmed = source.trim()
  if (!trimmed) throw new Error('OSS 上传素材为空')
  // 公网 URL 原样返回：视频接口只收 URL，可直取的地址不必再转存
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const label = kind === 'image' ? '图片' : '音频'
  const { bytes, mime } = await materializeSourceBytes(trimmed, kind)
  const cacheKey = `${runtime.providerId}:${createHash('sha256').update(bytes).digest('hex')}`
  const cachedUrl = contentUrlCache.get(cacheKey)
  if (cachedUrl) return cachedUrl
  const sts = await fetchAimanplaySts(runtime)
  const maxBytes = kind === 'image' ? sts.maxImageBytes : sts.maxAudioBytes
  if (maxBytes > 0 && bytes.length > maxBytes) {
    throw new Error(
      `${label}素材 ${formatLimit(bytes.length)} 超过 OSS 上限 ${formatLimit(maxBytes)}，请压缩后再试`
    )
  }
  const ext = extFromMime(mime)
  const key = `${sts.dir}/${randomUUID()}.${ext}`
  const date = new Date().toUTCString()
  const put = buildOssPutRequest(sts, mime, key, date)
  let response: Response
  try {
    response = await fetch(put.url, {
      method: 'PUT',
      headers: put.headers,
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    throw new Error(`OSS 上传失败（${label} ${key}）：${errorText(error)}`)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200).trim()
    throw new Error(`OSS 上传失败: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
  }
  const url = `${sts.host}/${key}`
  if (contentUrlCache.size >= CONTENT_CACHE_MAX_ENTRIES) {
    const oldest = contentUrlCache.keys().next()
    if (!oldest.done) contentUrlCache.delete(oldest.value)
  }
  contentUrlCache.set(cacheKey, url)
  // 诊断只记元信息（数量/字节/扩展名），不落素材内容
  mediaDiag.event('oss-upload', {
    providerId: runtime.providerId,
    kind,
    bytes: bytes.length,
    ext
  })
  return url
}
