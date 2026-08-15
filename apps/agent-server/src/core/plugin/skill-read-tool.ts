/**
 * 受限 skill_read 工具（方案 §9.2）
 *
 * 给插件 Agent 读取「本次显式授权 Skill 目录」内的参考文件（如 SKILL 拆出的
 * references/ 大文件），但不开放通用 read：
 * - 路径必须在授权根目录内（resolve 后前缀校验，拒绝路径穿越）；
 * - 只读普通文件，拒绝目录与符号链接指向越界的场景；
 * - 扩展名白名单（默认 .md / .txt / .json）；
 * - 单文件大小上限（默认 64KB）。
 *
 * 用途：Skill 正文仍由 /skill: 或组合编译器注入；只有拆出去的大体积参考材料
 * 通过 skill_read 按需读取。该工具是 per-session 注入的 extraTool，授权范围
 * 绑定到本次会话的 skills，不进入全局 pluginSessionTools。
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Type, type Static } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'

const SkillReadParams = Type.Object({
  path: Type.String({ description: 'Skill 目录内的相对或绝对文件路径' }),
})
type SkillReadParams = Static<typeof SkillReadParams>

export interface SkillReadToolOptions {
  /** 授权可读的根目录列表（通常为本次会话各 Skill 所在目录） */
  roots: string[]
  /** 单文件大小上限（字节），默认 64KB */
  maxBytes?: number
  /** 允许的扩展名白名单，默认 ['.md', '.txt', '.json'] */
  extensions?: string[]
}

export const DEFAULT_SKILL_READ_MAX_BYTES = 64 * 1024
export const DEFAULT_SKILL_READ_EXTENSIONS = ['.md', '.txt', '.json']

export interface SkillReadPathResolution {
  ok: boolean
  path?: string
  error?: string
}

/**
 * 校验并解析请求路径：必须落在任一授权根目录内（拒绝路径穿越与绝对越界）。
 * 纯函数，便于单测。
 */
export function resolveSkillReadPath(requested: string, options: SkillReadToolOptions): SkillReadPathResolution {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, error: '缺少文件路径参数' }
  }
  const candidate = resolve(requested)
  const roots = options.roots.map((root) => resolve(root))
  const inside = roots.some((root) => {
    const rel = relative(root, candidate)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!inside) {
    return { ok: false, error: `路径不在授权 Skill 目录内: ${requested}` }
  }
  return { ok: true, path: candidate }
}

/** 创建受限 skill_read 工具（Pi SDK ToolDefinition 格式，注入 extraTools）。 */
export function createSkillReadTool(options: SkillReadToolOptions): ToolDefinition<typeof SkillReadParams> {
  const maxBytes = options.maxBytes ?? DEFAULT_SKILL_READ_MAX_BYTES
  const extensions = (options.extensions ?? DEFAULT_SKILL_READ_EXTENSIONS)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase())
  const fail = (text: string): AgentToolResult<undefined> => ({
    content: [{ type: 'text', text: `skill_read 拒绝：${text}` }],
    details: undefined,
  })

  return defineTool({
    name: 'skill_read',
    label: '读取授权 Skill 文件',
    description:
      '读取本次显式授权 Skill 目录内的参考文件。仅限授权目录、允许的扩展名' +
      `（${extensions.join('/')}）且单文件不超过 ${maxBytes} 字节；不能读取工作区其他文件。`,
    promptSnippet: '读取授权 Skill 目录内的参考文件',
    parameters: SkillReadParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const resolution = resolveSkillReadPath(params.path, options)
      if (!resolution.ok) return fail(resolution.error ?? '路径校验失败')

      const filePath = resolution.path!
      const ext = extname(filePath).toLowerCase()
      if (!extensions.includes(ext)) {
        return fail(`文件类型 ${ext || '(无扩展名)'} 不在白名单内`)
      }
      try {
        const info = await stat(filePath)
        if (!info.isFile()) return fail('目标不是普通文件')
        if (info.size > maxBytes) {
          return fail(`文件大小 ${info.size} 字节超过上限 ${maxBytes} 字节`)
        }
        const content = await readFile(filePath, 'utf-8')
        return { content: [{ type: 'text', text: content }], details: undefined }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  })
}
