/**
 * 浏览器下载工具。
 *
 * Electron 的另存为对话框是异步的，`URL.revokeObjectURL` 一定不能紧跟 click()
 * 调用——用户点确认时 blob 已被回收，下载就会静默失败。多 MB 的 data URL 直接
 * 挂到 `<a href>` 上也会让对话框弹出前先卡几秒，先转成 Blob 快得多。
 */

/** blob URL 的存活时间：给足用户在另存为对话框里选目录的时间。 */
const OBJECT_URL_TTL_MS = 10 * 60_000

/** 把 data URL 解成 Blob；非 data URL 抛错，交由调用方按原样处理。 */
export function dataUrlToBlob(value: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value)
  if (!match) throw new Error('不是合法的 data URL')
  const mime = match[1] || 'application/octet-stream'
  const payload = match[3]
  if (match[2]) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(payload)], { type: mime })
}

/**
 * 触发一次浏览器下载。
 *
 * - Blob 与 data URL 都走 object URL，避免 Chromium 解析大 data URL 时的长时间卡顿
 * - object URL 延迟回收，保证另存为对话框确认后仍能取到数据
 * - http(s) 等远端地址原样交给浏览器
 */
export function downloadUrl(filename: string, source: Blob | string): void {
  const blob =
    typeof source === 'string'
      ? source.startsWith('data:')
        ? dataUrlToBlob(source)
        : undefined
      : source
  const href = blob ? URL.createObjectURL(blob) : (source as string)

  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  if (blob) setTimeout(() => URL.revokeObjectURL(href), OBJECT_URL_TTL_MS)
}

/** JSON 导出：大载荷（含图片 data URL）不做缩进，能省下可观的体积与序列化时间。 */
export function downloadJson(filename: string, value: unknown): void {
  const compact = JSON.stringify(value)
  const text = compact.length > 4 * 1024 * 1024 ? compact : JSON.stringify(value, null, 2)
  downloadUrl(filename, new Blob([text], { type: 'application/json' }))
}

/**
 * 把任意节点内容取回成本地 Blob。
 *
 * `<a download>` 直接挂远程地址时，Electron 要等响应头回来才弹保存框
 * （上游慢弹框就慢几秒到几十秒），确认后还要继续走网络流，中途断流
 * 就会"点了确定却没保存"。先完整取回内存，弹框瞬时出现、写盘零依赖网络。
 */
export async function resolveDownloadBlob(source: string): Promise<Blob> {
  if (source.startsWith('data:')) return dataUrlToBlob(source)
  const { proxyExternalImageUrl } = await import('@/api/infinite-canvas-client')
  const response = await fetch(proxyExternalImageUrl(source))
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  return response.blob()
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  jpeg: '.jpg',
  'svg+xml': '.svg',
  'x-icon': '.ico'
}

/** 按图片真实格式给扩展名；识别不出时按 PNG 兜底（生成图的主流格式）。 */
export function imageFileExtension(mime: string | undefined): string {
  const subtype = (mime ?? '').toLowerCase().replace(/^image\//, '').split(';')[0].trim()
  if (!mime?.startsWith('image/') || !subtype) return '.png'
  return IMAGE_MIME_EXTENSIONS[subtype] ?? `.${subtype}`
}

const KNOWN_IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|svg|ico|avif)$/i

/** 用真实格式统一文件扩展名：替换错误扩展名，无扩展名则补上。 */
export function withImageExtension(filename: string, extension: string): string {
  const base = KNOWN_IMAGE_EXTENSIONS.test(filename)
    ? filename.slice(0, filename.search(KNOWN_IMAGE_EXTENSIONS))
    : filename
  return `${base}${extension}`
}

/**
 * 把任意节点内容转成可在 canvas 上绘制并导出的本地地址。
 *
 * 跨域 URL 直接画上 canvas 会污染画布（toDataURL 抛 Tainted canvas），
 * data URL 原样放行，其余取回 Blob 后走 object URL——同源、永不污染。
 * 调用方对返回的非 data: 地址负责 revokeObjectURL。
 */
export async function toEditableImageUrl(source: string): Promise<string> {
  if (source.startsWith('data:')) return source
  const blob = await resolveDownloadBlob(source)
  return URL.createObjectURL(blob)
}
