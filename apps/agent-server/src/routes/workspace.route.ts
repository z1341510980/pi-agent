import type { FastifyPluginAsync } from 'fastify'
import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'

const workspaceSetSchema = z.object({
  path: z.string().min(1),
})

/** 文件/目录条目 */
type FileEntry = {
  name: string
  type: 'file' | 'directory'
  size?: number
}

/** 工作区信息 */
type WorkspaceInfo = {
  path: string
  name: string
  gitBranch?: string
  gitDirty?: boolean
}

export const workspaceRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/workspace
   * 获取当前工作区信息
   */
  app.get('/api/workspace', async (request) => {
    const cwd = process.env.PI_CWD ?? process.cwd()
    const info: WorkspaceInfo = {
      path: cwd,
      name: basename(cwd),
    }

    // 尝试获取 git 状态
    try {
      info.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch {
      // 非 git 仓库
    }

    try {
      const status = execSync('git status --porcelain', {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      info.gitDirty = status.length > 0
    } catch {
      // 忽略
    }

    return success(info, request.traceId)
  })

  /**
   * PUT /api/workspace
   * 设置工作区路径
   */
  app.put('/api/workspace', async (request, reply) => {
    const input = validateBody(workspaceSetSchema, request, reply)
    if (!input) return reply

    const { path: newPath } = input

    if (!existsSync(newPath)) {
      return reply.status(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: '路径不存在' },
        meta: { traceId: request.traceId, timestamp: Date.now() },
      })
    }

    // 更新环境变量
    process.env.PI_CWD = newPath

    // 更新 Gate 工作区
    app.gate.setWorkspace(newPath)

    const info: WorkspaceInfo = {
      path: newPath,
      name: basename(newPath),
    }

    try {
      info.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: newPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch {
      // 非 git 仓库
    }

    try {
      const status = execSync('git status --porcelain', {
        cwd: newPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      info.gitDirty = status.length > 0
    } catch {
      // 忽略
    }

    return success(info, request.traceId)
  })

  /**
   * GET /api/workspace/files
   * 列出工作区顶层文件和目录
   */
  app.get('/api/workspace/files', async (request) => {
    const cwd = process.env.PI_CWD ?? process.cwd()

    if (!existsSync(cwd)) {
      return success([], request.traceId)
    }

    let entries: FileEntry[]
    try {
      const dirents = await readdir(cwd, { withFileTypes: true })
      entries = dirents.map((d) => ({
        name: d.name,
        type: d.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
    } catch {
      entries = []
    }

    return success(entries, request.traceId)
  })
}
