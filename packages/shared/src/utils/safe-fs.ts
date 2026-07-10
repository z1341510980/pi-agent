import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 原子写入文件
 * 先写入临时文件，再 rename 到目标路径，避免写入中断导致文件损坏
 */
export function atomicWriteSync(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const tmpFile = join(
    tmpdir(),
    `wenlang-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  )

  try {
    writeFileSync(tmpFile, content, 'utf-8')
    renameSync(tmpFile, filePath)
  } catch {
    // renameSync 可能跨设备失败，回退到直接写入
    writeFileSync(filePath, content, 'utf-8')
  }
}
