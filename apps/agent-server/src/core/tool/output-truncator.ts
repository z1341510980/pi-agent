/**
 * 工具输出截断器
 *
 * 单个工具输出超过 32KB 时，截断为 head(16KB) + tail(16KB) + 中间省略提示。
 * 使用 Buffer 处理 UTF-8 字节，确保多字节字符正确处理。
 */

export interface TruncationConfig {
  /** 最大字节数，默认 32768 (32KB) */
  maxBytes: number
  /** 头部保留字节数，默认 16384 (16KB) */
  headBytes: number
  /** 尾部保留字节数，默认 16384 (16KB) */
  tailBytes: number
  /** 截断提示消息，支持 {total} 和 {omitted} 占位符 */
  truncationMessage: string
}

const DEFAULT_CONFIG: TruncationConfig = {
  maxBytes: 32768,
  headBytes: 16384,
  tailBytes: 16384,
  truncationMessage: '\n... [输出已截断，共 {total} 字节，省略 {omitted} 字节] ...\n'
}

/** 合并配置 */
function resolveConfig(config?: Partial<TruncationConfig>): TruncationConfig {
  return { ...DEFAULT_CONFIG, ...config }
}

/**
 * 判断输出是否需要截断
 */
export function shouldTruncate(output: string, config?: Partial<TruncationConfig>): boolean {
  const cfg = resolveConfig(config)
  return Buffer.byteLength(output, 'utf8') > cfg.maxBytes
}

/**
 * 截断输出
 *
 * 当输出字节数超过 maxBytes 时，保留前 headBytes 字节和后 tailBytes 字节，
 * 中间用 truncationMessage 替换（包含总字节数和省略字节数）。
 *
 * 使用 Buffer.subarray 按字节切片，避免破坏多字节字符的完整性
 * （切片边界可能落在多字节字符中间，toString('utf8') 会用替换字符处理）。
 */
export function truncateOutput(output: string, config?: Partial<TruncationConfig>): string {
  const cfg = resolveConfig(config)
  const buffer = Buffer.from(output, 'utf8')
  const totalBytes = buffer.length

  if (totalBytes <= cfg.maxBytes) {
    return output
  }

  const headBuffer = buffer.subarray(0, cfg.headBytes)
  const tailBuffer = buffer.subarray(totalBytes - cfg.tailBytes)

  const head = headBuffer.toString('utf8')
  const tail = tailBuffer.toString('utf8')

  const omitted = totalBytes - cfg.headBytes - cfg.tailBytes
  const message = cfg.truncationMessage
    .replace('{total}', String(totalBytes))
    .replace('{omitted}', String(omitted))

  return head + message + tail
}
