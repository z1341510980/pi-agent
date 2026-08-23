/**
 * 插件目录（catalog）解析：配置身份、环境变量引用与依赖拓扑
 *
 * 对应研究文档 §10.2 / §10.11 的三处已证实失配：
 * 1. `plugins.yml` 注释声称 `${VAR_NAME}` 会在启动时替换，但加载器只调 `js-yaml.load()`
 *    并把结果原样交给插件。含 `${WEB_SEARCH_API_KEY}` 的配置被当成已解析的密钥使用。
 * 2. `enabled: false` 的条目根本不进 `PluginManager`，于是 `desiredState=false`
 *    与"未发现"被混为一谈，`POST /enable` 找不到目标。
 * 3. `manifest.dependencies` 不构成依赖图，缺失依赖和循环依赖都没有诊断。
 *
 * 本模块只做纯函数解析与排序，不触碰运行时；便于单测覆盖失败路径。
 *
 * @module core/plugin/plugin-catalog
 */

import type { PluginCapability } from './plugin-types.js'

/** 全部合法 capability，用于拒绝未知授权 */
export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  'tools.register',
  'agent.hooks',
  'provider.transform',
  'provider.observe',
  'routes.register',
  'storage.plugin',
  'ui.contribute',
  'network.outbound',
  'process.exec',
  'session.create',
  'agent.orchestrate',
  'confirmation.request'
  , 'media.generate'
]

/** 一条已校验的 catalog 条目 */
export interface PluginCatalogItem {
  /** 配置/安装记录主键（YAML 的 id），不等于 manifest.name */
  catalogId: string
  source: 'builtin' | 'local' | 'npm'
  /** 期望状态：false 时插件仍进 catalog，但不 setup */
  enabled: boolean
  isolate?: boolean
  config?: Record<string, unknown>
  grants?: PluginCapability[]
  sourceRef?: string
  /**
   * 锁定的包完整性声明（SRI 格式 `sha256-<base64>`）。
   *
   * 存在时加载侧会在 import 之前校验包目录摘要；格式非法按错误处理，
   * 不能静默降级为"未锁定"。
   */
  integrity?: string
  /** 锁定的版本号；与 package.json 的 version 精确比对 */
  resolvedVersion?: string
}

/** 解析诊断：catalogId 为 null 表示条目级结构错误 */
export interface PluginCatalogDiagnostic {
  catalogId: string | null
  /** 条目在 YAML 数组中的下标，便于定位 */
  index: number
  level: 'error' | 'warn'
  message: string
}

export interface PluginCatalogParseResult {
  items: PluginCatalogItem[]
  diagnostics: PluginCatalogDiagnostic[]
}

/** 环境变量引用形如 ${NAME}；只接受大写字母、数字和下划线 */
const ENV_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/

/** 字符串中是否含 ${...} 形式的引用（用于识别未被完整替换的混合写法） */
const ENV_REF_ANYWHERE = /\$\{[^}]*\}/

export interface EnvResolution {
  /** 替换后的值 */
  value: unknown
  /** 已解析的变量名（不含值，避免密钥进日志） */
  resolved: string[]
  /** 引用了但环境中不存在的变量名 */
  missing: string[]
  /** 语法不受支持的引用原文（如 `prefix-${A}-suffix` 或 `${lower}`） */
  unsupported: string[]
}

/**
 * 递归解析配置中的环境变量引用。
 *
 * 只支持"整个字符串就是一个引用"这一种形式：`${NAME}`。
 * 混合写法（`https://${HOST}/api`）和小写名不做替换，而是记为 unsupported —— 
 * 悄悄留下原文会让插件把 `${HOST}` 当成真实主机名。
 *
 * 缺失的变量替换为 undefined 并记入 missing，让调用方决定是拒绝还是降级；
 * 绝不回落到原文。
 */
export function resolveEnvRefs(
  input: unknown,
  env: Record<string, string | undefined> = process.env
): EnvResolution {
  const resolved: string[] = []
  const missing: string[] = []
  const unsupported: string[] = []

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = ENV_REF_PATTERN.exec(value)
      if (exact) {
        const name = exact[1]
        const found = env[name]
        if (typeof found === 'string' && found.length > 0) {
          resolved.push(name)
          return found
        }
        missing.push(name)
        return undefined
      }
      if (ENV_REF_ANYWHERE.test(value)) unsupported.push(value)
      return value
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(item)
      }
      return out
    }
    return value
  }

  return { value: walk(input), resolved, missing, unsupported }
}

/** plugins.yml 的原始形状（解析前不可信） */
export interface RawPluginCatalog {
  plugins?: unknown
}

/**
 * 解析并校验 plugins.yml 的 plugins 数组。
 *
 * 结构非法的条目被丢弃并记 error 诊断；`enabled: false` 的条目仍会保留，
 * 因为"用户希望它关着"和"我们没找到它"是两件不同的事。
 */
export function parsePluginCatalog(
  raw: RawPluginCatalog | null | undefined,
  env: Record<string, string | undefined> = process.env
): PluginCatalogParseResult {
  const diagnostics: PluginCatalogDiagnostic[] = []
  const items: PluginCatalogItem[] = []

  const entries = raw?.plugins
  if (entries === undefined) return { items, diagnostics }
  if (!Array.isArray(entries)) {
    diagnostics.push({
      catalogId: null,
      index: -1,
      level: 'error',
      message: 'plugins 字段必须是数组'
    })
    return { items, diagnostics }
  }

  const seen = new Set<string>()

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push({ catalogId: null, index, level: 'error', message: '条目不是对象' })
      return
    }
    const record = entry as Record<string, unknown>
    const catalogId = record.id
    if (typeof catalogId !== 'string' || catalogId.trim().length === 0) {
      diagnostics.push({ catalogId: null, index, level: 'error', message: 'id 缺失或为空' })
      return
    }
    if (seen.has(catalogId)) {
      diagnostics.push({
        catalogId,
        index,
        level: 'error',
        message: `catalogId 重复: ${catalogId}`
      })
      return
    }
    const source = record.source
    if (source !== 'builtin' && source !== 'local' && source !== 'npm') {
      diagnostics.push({
        catalogId,
        index,
        level: 'error',
        message: `source 必须是 builtin/local/npm，实际为 ${String(source)}`
      })
      return
    }
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
      diagnostics.push({
        catalogId,
        index,
        level: 'error',
        message: 'enabled 必须是布尔值'
      })
      return
    }
    if ((source === 'local' || source === 'npm') && typeof record.sourceRef !== 'string') {
      diagnostics.push({
        catalogId,
        index,
        level: 'error',
        message: `${source} 插件必须提供 sourceRef`
      })
      return
    }

    // 锁定字段：integrity 必须是合法 SRI，resolvedVersion 必须是非空字符串。
    // 写错的锁不能静默降级为"未锁定"，否则完整性校验形同虚设。
    // 算法只接受 sha256——与 plugin-integrity 的目录摘要算法一致；放行 sha384/sha512
    // 会让配置通过校验却在加载期永久失败。
    if (record.integrity !== undefined) {
      if (
        typeof record.integrity !== 'string' ||
        !/^sha256-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity.trim())
      ) {
        diagnostics.push({
          catalogId,
          index,
          level: 'error',
          message: `integrity 必须是 SRI 格式（sha256-<base64>）: ${String(record.integrity)}`
        })
        return
      }
    }
    if (record.resolvedVersion !== undefined) {
      if (typeof record.resolvedVersion !== 'string' || record.resolvedVersion.trim().length === 0) {
        diagnostics.push({
          catalogId,
          index,
          level: 'error',
          message: 'resolvedVersion 必须是非空字符串'
        })
        return
      }
    }

    // grants 只接受已知 capability；未知项拒绝而不是静默丢弃，
    // 否则用户以为授权成功但插件调用会失败。
    let grants: PluginCapability[] | undefined
    if (record.grants !== undefined) {
      if (!Array.isArray(record.grants)) {
        diagnostics.push({ catalogId, index, level: 'error', message: 'grants 必须是数组' })
        return
      }
      const unknown = record.grants.filter(
        (item) => !ALL_PLUGIN_CAPABILITIES.includes(item as PluginCapability)
      )
      if (unknown.length > 0) {
        diagnostics.push({
          catalogId,
          index,
          level: 'error',
          message: `未知 capability: ${unknown.map(String).join(', ')}`
        })
        return
      }
      grants = record.grants as PluginCapability[]
    }

    let config: Record<string, unknown> | undefined
    if (record.config !== undefined) {
      if (!record.config || typeof record.config !== 'object' || Array.isArray(record.config)) {
        diagnostics.push({ catalogId, index, level: 'error', message: 'config 必须是对象' })
        return
      }
      const resolution = resolveEnvRefs(record.config, env)
      config = resolution.value as Record<string, unknown>
      // 只记变量名，绝不记值
      if (resolution.resolved.length > 0) {
        diagnostics.push({
          catalogId,
          index,
          level: 'warn',
          message: `已从环境变量解析: ${resolution.resolved.join(', ')}`
        })
      }
      for (const name of resolution.missing) {
        diagnostics.push({
          catalogId,
          index,
          level: 'error',
          message: `环境变量 ${name} 未设置，对应配置项为 undefined`
        })
      }
      for (const text of resolution.unsupported) {
        diagnostics.push({
          catalogId,
          index,
          level: 'error',
          message: `不支持的环境变量引用（只支持整值 \${NAME}）: ${text}`
        })
      }
    }

    seen.add(catalogId)
    items.push({
      catalogId,
      source,
      enabled: record.enabled !== false,
      ...(typeof record.isolate === 'boolean' ? { isolate: record.isolate } : {}),
      ...(config ? { config } : {}),
      ...(grants ? { grants } : {}),
      ...(typeof record.sourceRef === 'string' ? { sourceRef: record.sourceRef } : {}),
      ...(typeof record.integrity === 'string'
        ? { integrity: record.integrity.trim() }
        : {}),
      ...(typeof record.resolvedVersion === 'string'
        ? { resolvedVersion: record.resolvedVersion.trim() }
        : {})
    })
  })

  return { items, diagnostics }
}

/** 依赖排序的输入节点 */
export interface DependencyNode {
  /** manifest.name，依赖引用的目标身份 */
  pluginId: string
  dependencies: string[]
}

export interface DependencyOrderResult {
  /** 可安全启动的顺序（依赖先于消费方） */
  order: string[]
  /** pluginId → 缺失的依赖列表 */
  missing: Map<string, string[]>
  /** 参与循环依赖的 pluginId → 环路路径 */
  cycles: Map<string, string[]>
  /** 因依赖缺失或成环而被阻断的 pluginId（含被传递阻断的消费方） */
  blocked: Set<string>
}

/**
 * 对插件按 manifest.dependencies 做拓扑排序。
 *
 * 缺失依赖和循环依赖不会静默通过：
 * - 直接缺失依赖的插件进 `missing`；
 * - 依赖链上游被阻断的插件也进 `blocked`（否则它会在 setup 里拿不到服务而报模糊错误）；
 * - 成环的插件进 `cycles`，环路路径用于诊断展示。
 *
 * `order` 只包含可安全启动的插件，且保持输入顺序作为同层稳定序。
 */
export function resolveDependencyOrder(nodes: DependencyNode[]): DependencyOrderResult {
  const byId = new Map<string, DependencyNode>()
  for (const node of nodes) byId.set(node.pluginId, node)

  const missing = new Map<string, string[]>()
  const cycles = new Map<string, string[]>()
  const blocked = new Set<string>()
  const order: string[] = []

  // 0=未访问 1=访问中 2=已完成
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []

  const visit = (pluginId: string): boolean => {
    const current = state.get(pluginId) ?? 0
    if (current === 2) return !blocked.has(pluginId)
    if (current === 1) {
      // 回边：从栈中截出环路
      const start = stack.indexOf(pluginId)
      const cycle = [...stack.slice(start), pluginId]
      for (const member of cycle) {
        cycles.set(member, cycle)
        blocked.add(member)
      }
      return false
    }

    state.set(pluginId, 1)
    stack.push(pluginId)

    const node = byId.get(pluginId)
    let ok = true
    const absent: string[] = []
    for (const dependency of node?.dependencies ?? []) {
      if (!byId.has(dependency)) {
        absent.push(dependency)
        ok = false
        continue
      }
      if (!visit(dependency)) ok = false
    }
    if (absent.length > 0) missing.set(pluginId, absent)

    stack.pop()
    state.set(pluginId, 2)
    if (!ok) {
      blocked.add(pluginId)
      return false
    }
    order.push(pluginId)
    return true
  }

  for (const node of nodes) visit(node.pluginId)

  return { order, missing, cycles, blocked }
}
