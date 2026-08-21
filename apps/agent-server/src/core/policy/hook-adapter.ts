/**
 * Hook 配置解析器
 *
 * 将自有配置格式（PiHookConfig）直接转换为内部 Hook 定义。
 * 不兼容 DSH/Codex/Claude 外部格式，也不输出降级诊断层。
 *
 * @module core/policy/hook-adapter
 */

import type { HookDefinition, PolicyHookSecurityOptions } from './policy-hook-manager.js'

// ============================================================================
// 自有配置格式
// ============================================================================

/** 合法 Hook 触发点 */
export const HOOK_POINTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'Stop'
] as const

export type HookPointName = (typeof HOOK_POINTS)[number]

/**
 * Pi Hook 配置格式
 */
export interface PiHookConfig {
  /**
   * 宿主安全策略。
   *
   * 缺省即最严格：无 shell、只继承环境变量白名单、输出有上限。
   * `trusted: true` 是显式的信任声明，只应在用户自己维护的本地配置中出现。
   */
  security?: {
    trusted?: boolean
    envAllowlist?: string[]
    maxOutputBytes?: number
    cwd?: string
  }
  hooks?: Array<{
    /** Hook 触发点 */
    point: HookPointName
    /** 要执行的命令 */
    command: string
    /** 显式 argv 参数（无 shell 执行时优先于命令分词） */
    args?: string[]
    /** 超时时间（秒） */
    timeoutSec?: number
    /** 匹配器（正则字符串或 '|' 分隔的候选集） */
    matcher?: string
    /** 是否启用，默认 true */
    enabled?: boolean
    /** 是否要求 shell 求值；仅在 security.trusted 为 true 时生效 */
    shell?: boolean
  }>
}

// ============================================================================
// 内部归一化格式
// ============================================================================

export interface NormalizedHook {
  point: HookPointName
  command: string
  args?: string[]
  timeoutSec?: number
  matcher?: string
  enabled: boolean
  shell?: boolean
}

/** 解析结果：归一化 Hook + 宿主安全策略 + 被丢弃条目的原因 */
export interface ParsedHookConfig {
  hooks: NormalizedHook[]
  security: PolicyHookSecurityOptions
  /** 被拒绝的配置条目诊断（索引 + 原因），供启动日志如实上报 */
  rejected: Array<{ index: number; reason: string }>
}

// ============================================================================
// 配置解析
// ============================================================================

/** 解析配置并同时返回安全策略与拒绝原因 */
export function parsePiHookConfigDetailed(config: PiHookConfig): ParsedHookConfig {
  const rejected: Array<{ index: number; reason: string }> = []
  const hooks: NormalizedHook[] = []

  const entries = config.hooks ?? []
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      rejected.push({ index, reason: 'Hook 条目不是对象' })
      return
    }
    if (!HOOK_POINTS.includes(entry.point)) {
      rejected.push({ index, reason: `未知 Hook point: ${String(entry.point)}` })
      return
    }
    if (typeof entry.command !== 'string' || entry.command.trim().length === 0) {
      rejected.push({ index, reason: 'command 缺失或为空' })
      return
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      rejected.push({ index, reason: 'args 必须为字符串数组' })
      return
    }
    if (entry.args?.some((arg) => typeof arg !== 'string')) {
      rejected.push({ index, reason: 'args 必须为字符串数组' })
      return
    }
    if (entry.timeoutSec !== undefined) {
      if (typeof entry.timeoutSec !== 'number' || !Number.isFinite(entry.timeoutSec)) {
        rejected.push({ index, reason: 'timeoutSec 必须为有限数字' })
        return
      }
      if (entry.timeoutSec <= 0) {
        rejected.push({ index, reason: 'timeoutSec 必须大于 0' })
        return
      }
    }

    hooks.push({
      point: entry.point,
      command: entry.command,
      ...(entry.args ? { args: [...entry.args] } : {}),
      timeoutSec: entry.timeoutSec,
      matcher: entry.matcher,
      enabled: entry.enabled ?? true,
      ...(entry.shell !== undefined ? { shell: entry.shell } : {})
    })
  })

  return { hooks, security: parseHookSecurity(config), rejected }
}

/** 解析宿主安全策略；缺省与非法值都退回最严格设置 */
export function parseHookSecurity(config: PiHookConfig): PolicyHookSecurityOptions {
  const raw = config.security
  const security: PolicyHookSecurityOptions = { trusted: raw?.trusted === true }
  if (Array.isArray(raw?.envAllowlist)) {
    const names = raw.envAllowlist.filter((name): name is string => typeof name === 'string')
    if (names.length > 0) security.envAllowlist = names
  }
  if (
    typeof raw?.maxOutputBytes === 'number' &&
    Number.isFinite(raw.maxOutputBytes) &&
    raw.maxOutputBytes > 0
  ) {
    security.maxOutputBytes = Math.floor(raw.maxOutputBytes)
  }
  if (typeof raw?.cwd === 'string' && raw.cwd.trim().length > 0) {
    security.cwd = raw.cwd
  }
  return security
}

/**
 * 将归一化 Hook 转换为 PolicyHookManager 使用的 HookDefinition
 */
export function normalizeToHookDefinitions(normalized: NormalizedHook[]): HookDefinition[] {
  return normalized.map((h) => ({
    point: h.point,
    command: h.command,
    ...(h.args ? { args: h.args } : {}),
    timeoutSec: h.timeoutSec,
    matcher: h.matcher,
    enabled: h.enabled,
    ...(h.shell !== undefined ? { shell: h.shell } : {})
  }))
}

/**
 * 一站式解析：从配置直接到 HookDefinition
 */
export function parsePiHooks(config: PiHookConfig): HookDefinition[] {
  return normalizeToHookDefinitions(parsePiHookConfigDetailed(config).hooks)
}

