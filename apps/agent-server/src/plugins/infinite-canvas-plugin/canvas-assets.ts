/**
 * 画布资产存储：把生成的远程图片（慢 CDN、可能过期）转成服务端本地资产，
 * 前端通过 /assets/:id 拿到货真价实的 image/* 响应——
 * 不再触发 ORB 拦截，也不再受上游速度/可用性影响。
 *
 * 远程图走"先占位、后台转存"：生成响应立即返回资产路径，
 * 下载在后台流式进行；转存完成前 /assets/:id 302 到源 URL 兜底。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import { mediaDiag } from '../../core/config/media-diag.js'

/** 后台下载单张的硬上限：正常 CDN 几十秒内完成，慢 CDN 也别无限挂着。 */
export const ASSET_DOWNLOAD_TIMEOUT_MS = 15 * 60_000

const ASSET_PATH_PREFIX = '/api/plugins/infinite-canvas/assets'

type AssetStatus = 'ready' | 'downloading' | 'failed'

interface AssetRow {
  id: string
  project_id: string | null
  file_path: string
  mime: string
  bytes: number
  source_url: string | null
  status: AssetStatus
  created_at: number
}

export interface CanvasAssetRecord {
  id: string
  projectId: string | null
  filePath: string
  mime: string
  bytes: number
  sourceUrl: string | null
  status: AssetStatus
  createdAt: number
}

const MAGIC_SIGNATURES: Array<{ bytes: number[]; offset: number; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: 'image/webp' }, // RIFF + WEBP 再确认
  { bytes: [0x42, 0x4d], offset: 0, mime: 'image/bmp' }
]

function matches(buffer: Buffer, signature: { bytes: number[]; offset: number }): boolean {
  if (buffer.length < signature.offset + signature.bytes.length) return false
  return signature.bytes.every((byte, index) => buffer[signature.offset + index] === byte)
}

/**
 * 按魔数识别真实图片格式；识别不出时接受显式的 image/* 声明，
 * 否则回落到不可执行的二进制类型（防止 HTML/JSON 被当成图片渲染）。
 */
export function imageMimeFromBytes(buffer: Buffer, declaredContentType: string): string {
  for (const signature of MAGIC_SIGNATURES) {
    if (matches(buffer, signature)) {
      if (signature.mime === 'image/webp') {
        const isWebp =
          buffer.length >= 12 &&
          buffer[8] === 0x57 &&
          buffer[9] === 0x45 &&
          buffer[10] === 0x42 &&
          buffer[11] === 0x50
        if (isWebp) return 'image/webp'
        continue
      }
      return signature.mime
    }
  }
  const declared = declaredContentType.split(';')[0].trim().toLowerCase()
  return declared.startsWith('image/') ? declared : 'application/octet-stream'
}

/**
 * 资产 MIME 判定：音频/视频产物（语音合成 data URL、视频 CDN URL）没有稳定的
 * 图片魔数，直接信任服务声明的 audio/* / video/*；其余走图片魔数嗅探。
 */
function assetMimeFromBytes(buffer: Buffer, declaredContentType: string): string {
  const declared = declaredContentType.split(';')[0].trim().toLowerCase()
  if (declared.startsWith('audio/') || declared.startsWith('video/')) return declared
  return imageMimeFromBytes(buffer, declaredContentType)
}

function extensionForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/opus': '.opus',
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/pcm': '.pcm',
    'video/mp4': '.mp4',
    'video/webm': '.webm'
  }
  return map[mime] ?? '.bin'
}

function parseDataUrl(value: string): { bytes: Buffer; contentType: string } | undefined {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value)
  if (!match) return undefined
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  return { bytes, contentType: match[1] || 'application/octet-stream' }
}

export class CanvasAssetStore {
  private readonly assetsDir: string
  private readonly stmtInsert: Database.Statement
  private readonly stmtGetByPath: Database.Statement
  private readonly stmtListByProject: Database.Statement
  private readonly stmtDeleteByProject: Database.Statement
  private readonly stmtFinalize: Database.Statement
  private readonly stmtMarkStatus: Database.Statement
  private readonly stmtFindByHash: Database.Statement
  /** 进行中的后台转存：防止并发重复下载，重启后按需懒恢复。 */
  private readonly inflight = new Map<string, Promise<void>>()
  /** 最近一次转存失败原因（id → message），供诊断与测试。 */
  private readonly failureReasons = new Map<string, string>()

  constructor(
    private readonly db: Database.Database,
    assetsDir: string
  ) {
    this.assetsDir = assetsDir
    mkdirSync(assetsDir, { recursive: true })
    this.stmtInsert = db.prepare(
      `INSERT INTO infinite_canvas_assets (id, project_id, file_path, mime, bytes, source_url, status, created_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.stmtGetByPath = db.prepare('SELECT * FROM infinite_canvas_assets WHERE id = ?')
    this.stmtListByProject = db.prepare(
      'SELECT * FROM infinite_canvas_assets WHERE project_id = ?'
    )
    this.stmtDeleteByProject = db.prepare(
      'DELETE FROM infinite_canvas_assets WHERE project_id = ?'
    )
    this.stmtFinalize = db.prepare(
      'UPDATE infinite_canvas_assets SET file_path = ?, mime = ?, bytes = ?, status = ?, content_hash = ? WHERE id = ?'
    )
    this.stmtMarkStatus = db.prepare(
      'UPDATE infinite_canvas_assets SET status = ? WHERE id = ?'
    )
    this.stmtFindByHash = db.prepare(
      'SELECT * FROM infinite_canvas_assets WHERE content_hash = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
    )
  }

  /** 供路由解析：path 形如 /api/plugins/infinite-canvas/assets/{id}。 */
  getAssetByPath(path: string): CanvasAssetRecord | undefined {
    const id = path.startsWith(`${ASSET_PATH_PREFIX}/`)
      ? path.slice(ASSET_PATH_PREFIX.length + 1)
      : path
    const row = this.stmtGetByPath.get(id) as AssetRow | undefined
    return row ? this.toRecord(row) : undefined
  }

  listProjectAssets(projectId: string): CanvasAssetRecord[] {
    return (this.stmtListByProject.all(projectId) as AssetRow[]).map((row) => this.toRecord(row))
  }

  /** 删除项目时清掉资产行与磁盘文件（文件清理尽力而为）。 */
  deleteForProject(projectId: string): void {
    for (const asset of this.listProjectAssets(projectId)) {
      try {
        if (existsSync(asset.filePath)) rmSync(asset.filePath, { force: true })
      } catch {
        /* 清理失败不阻塞项目删除 */
      }
    }
    this.stmtDeleteByProject.run(projectId)
  }

  /** 远程生成图：立即登记资产并启动后台转存，绝不阻塞生成响应。 */
  beginRemoteAsset(projectId: string | null, url: string): string {
    const id = randomUUID()
    const partPath = join(this.assetsDir, `${id}.part`)
    this.stmtInsert.run(id, projectId, partPath, 'image/png', 0, url, 'downloading', Date.now(), null)
    const task = this.downloadInBackground(id, url, partPath).finally(() => {
      this.inflight.delete(id)
    })
    this.inflight.set(id, task)
    return `${ASSET_PATH_PREFIX}/${id}`
  }

  /** 测试辅助：等待所有后台转存结束。 */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()])
  }

  private async downloadInBackground(id: string, url: string, partPath: string): Promise<void> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
        redirect: 'follow',
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partPath))
      // 按魔数确定真实格式后落成正式文件名（音视频产物信任声明的媒体类型）
      const bytes = readFileSync(partPath)
      const mime = assetMimeFromBytes(bytes, response.headers.get('content-type') ?? '')
      if (mime === 'application/octet-stream') throw new Error('响应不是可识别的媒体内容')
      const hash = createHash('sha256').update(bytes).digest('hex')
      const finalPath = join(this.assetsDir, `${id}-${hash.slice(0, 12)}${extensionForMime(mime)}`)
      renameSync(partPath, finalPath)
      this.stmtFinalize.run(finalPath, mime, bytes.length, 'ready', hash, id)
    } catch (error) {
      // 转存失败保留 failed 状态：服务端按 302 回源兜底
      this.failureReasons.set(id, error instanceof Error ? error.message : String(error))
      try {
        if (existsSync(partPath)) rmSync(partPath, { force: true })
      } catch {
        /* 清理失败不影响状态标记 */
      }
      this.stmtMarkStatus.run('failed', id)
    }
  }

  /** 转存失败原因；undefined 表示未失败。 */
  failureReason(path: string): string | undefined {
    const id = path.startsWith(`${ASSET_PATH_PREFIX}/`) ? path.slice(ASSET_PATH_PREFIX.length + 1) : path
    return this.failureReasons.get(id)
  }

  /** data URL（b64_json 结果 / 语音合成产物）→ 本地文件，行为与远程一致。 */
  storeFromDataUrl(projectId: string | null, dataUrl: string): string | null {
    try {
      const parsed = parseDataUrl(dataUrl)
      if (!parsed) return null
      return this.writeAsset(
        projectId,
        parsed.bytes,
        assetMimeFromBytes(parsed.bytes, parsed.contentType),
        null
      )
    } catch {
      return null
    }
  }

  private writeAsset(
    projectId: string | null,
    bytes: Buffer,
    mime: string,
    sourceUrl: string | null
  ): string | null {
    if (!bytes.length) return null
    if (mime === 'application/octet-stream') {
      // 拿不到可信的图片格式就不落盘：存下来也没法当图片渲染
      return null
    }
    // 内容去重：同一张图（蒙版/参考图反复出现）只存一份
    const hash = createHash('sha256').update(bytes).digest('hex')
    const existing = this.stmtFindByHash.get(hash, 'ready') as AssetRow | undefined
    if (existing) return `${ASSET_PATH_PREFIX}/${existing.id}`
    const id = randomUUID()
    const filePath = join(this.assetsDir, `${id}-${hash.slice(0, 12)}${extensionForMime(mime)}`)
    writeFileSync(filePath, bytes)
    this.stmtInsert.run(id, projectId, filePath, mime, bytes.length, sourceUrl, 'ready', Date.now(), hash)
    return `${ASSET_PATH_PREFIX}/${id}`
  }

  private toRecord(row: AssetRow): CanvasAssetRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      filePath: row.file_path,
      mime: row.mime,
      bytes: row.bytes,
      sourceUrl: row.source_url,
      status: row.status,
      createdAt: row.created_at
    }
  }
}

// ── 媒体生成日志 ──

export interface MediaLogReference {
  /** 可预览地址：本地资产路径或远程 URL */
  preview: string
  bytes: number
}

export interface MediaLogInsert {
  kind: 'generate' | 'edit'
  projectId: string | null
  endpoint: string
  model: string | null
  size: string | null
  prompt: string
  references: MediaLogReference[]
  maskPath?: string | null
  responseImages: string[]
  error?: string | null
  status: 'ok' | 'error'
  durationMs: number
  traceId?: string | null
}

export interface MediaLogEntry {
  id: string
  kind: 'generate' | 'edit'
  projectId: string | null
  endpoint: string
  model: string | null
  size: string | null
  prompt: string
  references: MediaLogReference[]
  maskPath: string | null
  responseImages: string[]
  error: string | null
  status: 'ok' | 'error'
  durationMs: number
  traceId: string | null
  createdAt: number
}

interface MediaLogRow {
  id: string
  kind: string
  project_id: string | null
  endpoint: string
  model: string | null
  size: string | null
  prompt: string
  references_json: string
  mask_path: string | null
  response_json: string
  error: string | null
  status: string
  duration_ms: number
  trace_id: string | null
  created_at: number
}

/** 日志保留上限：超出后最旧的被清除（预览资产是内容去重的，文件按需共享）。 */
const MEDIA_LOG_RETENTION = 200

export class MediaLogStore {
  private readonly stmtInsert: Database.Statement
  private readonly stmtList: Database.Statement
  private readonly stmtPrune: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT INTO infinite_canvas_media_logs
         (id, kind, project_id, endpoint, model, size, prompt, references_json, mask_path,
          response_json, error, status, duration_ms, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.stmtList = db.prepare(
      'SELECT * FROM infinite_canvas_media_logs ORDER BY created_at DESC, rowid DESC LIMIT ?'
    )
    this.stmtPrune = db.prepare(
      `DELETE FROM infinite_canvas_media_logs WHERE id NOT IN (
         SELECT id FROM infinite_canvas_media_logs ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    )
  }

  insert(entry: MediaLogInsert): void {
    this.stmtInsert.run(
      randomUUID(),
      entry.kind,
      entry.projectId,
      entry.endpoint,
      entry.model,
      entry.size,
      entry.prompt,
      JSON.stringify(entry.references ?? []),
      entry.maskPath ?? null,
      JSON.stringify(entry.responseImages ?? []),
      entry.error ?? null,
      entry.status,
      entry.durationMs,
      entry.traceId ?? null,
      Date.now()
    )
    this.stmtPrune.run(MEDIA_LOG_RETENTION)
  }

  list(limit = 50): MediaLogEntry[] {
    const rows = this.stmtList.all(limit) as MediaLogRow[]
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as MediaLogEntry['kind'],
      projectId: row.project_id,
      endpoint: row.endpoint,
      model: row.model,
      size: row.size,
      prompt: row.prompt,
      references: JSON.parse(row.references_json) as MediaLogReference[],
      maskPath: row.mask_path,
      responseImages: JSON.parse(row.response_json) as string[],
      error: row.error,
      status: row.status as MediaLogEntry['status'],
      durationMs: row.duration_ms,
      traceId: row.trace_id,
      createdAt: row.created_at
    }))
  }
}

function extractAssetSuffix(reference: string): string | null {
  const marker = `${ASSET_PATH_PREFIX}/`
  const index = reference.indexOf(marker)
  if (index < 0) return null
  const id = reference.slice(index + marker.length)
  return /^[\w-]+$/.test(id) ? id : null
}

async function referenceToDataUrl(assets: CanvasAssetStore, reference: string): Promise<string> {
  if (reference.startsWith('data:')) return reference

  // 本地资产：直接读盘，绕开网络
  const assetId = extractAssetSuffix(reference)
  if (assetId) {
    const asset = assets.getAssetByPath(`${ASSET_PATH_PREFIX}/${assetId}`)
    if (asset && asset.status === 'ready' && existsSync(asset.filePath)) {
      const bytes = readFileSync(asset.filePath)
      return `data:${asset.mime};base64,${bytes.toString('base64')}`
    }
    throw new Error(`参考图资产不存在或尚未转存完成：${reference}`)
  }

  // 远程图：走系统代理取回（部分域名直连不可达）
  if (/^https?:\/\//.test(reference)) {
    const response = await fetch(reference, {
      signal: AbortSignal.timeout(60_000),
      redirect: 'follow',
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    })
    if (!response.ok) throw new Error(`参考图下载失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const mime = imageMimeFromBytes(bytes, response.headers.get('content-type') ?? '')
    if (!mime.startsWith('image/')) throw new Error(`参考图不是有效图片：${reference}`)
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  throw new Error(`不支持的参考图地址：${reference}`)
}

/**
 * 参考图归一化：所有参考图必须以 data URL 形式发给图片 Provider。
 * 本地资产路径、localhost 地址、内网不可达 URL 都不是服务商能取到的形式；
 * 归一化失败时抛出可见错误，绝不悄悄丢参考图。
 */
export async function referencesToDataUrls(
  assets: CanvasAssetStore,
  references: string[] | undefined
): Promise<string[] | undefined> {
  if (!references?.length) return references
  const converted = await Promise.all(references.map((ref) => referenceToDataUrl(assets, ref)))
  mediaDiag.event('reference-normalized', {
    total: converted.length,
    fromData: references.filter((ref) => ref.startsWith('data:')).length
  })
  return converted
}
