/**
 * 插件管理 API 客户端
 *
 * 提供插件列表、详情、启用/禁用、授权管理等功能。
 * 对应后端 `/api/plugins` 路由。
 */

export interface PluginListItem {
  name: string
  version: string
  description?: string
  author?: string
  /** 实际状态（observedState） */
  status: 'loaded' | 'enabled' | 'disabled' | 'error'
  /**
   * 配置声明的期望状态（desiredState）。
   *
   * 与 status 分开：`enabled: false` 的插件仍在列表里可见，只是没有 setup。
   * UI 应据此区分"用户关掉了它"与"它启动失败了"。
   */
  desiredEnabled: boolean
  source: 'builtin' | 'local' | 'npm'
  /**
   * 包完整性校验状态。
   *
   * - verified：plugins.yml 有锁且加载前校验通过
   * - unverified：无锁的 local/npm（代码未经校验即加载）
   * - not-applicable：builtin，随应用一起构建
   */
  integrityStatus: 'verified' | 'unverified' | 'not-applicable'
  error?: string
  /** 依赖诊断（缺失依赖 / 循环依赖 / 被上游阻断） */
  dependencyDiagnostics?: string[]
  lifecycle: 'loaded' | 'enabled' | 'disabled' | 'error' | 'starting' | 'stopping'
  activationGeneration: number
  runId?: string
  effectCount: number
  activeEffectCount: number
  /** route/service 是否已真正挂到宿主 */
  hostAttached: boolean
  /**
   * 本次启用注册的 route/service 需要重启才生效。
   *
   * 宿主只在启动期挂载路由和 decorate 服务。运行期 enable 的插件即使 setup 成功，
   * HTTP 请求也打不到它的 route，UI 必须提示重启而不是显示"已可用"。
   */
  effectiveAfterRestart: boolean
  lastStop?: {
    outcome: 'completed' | 'partial' | 'failed'
    errors: string[]
    residualEffectCount: number
  }
  restartRequired: boolean
  unloadScope: 'none' | 'restart-required' | 'session'
  toolCount: number
  routeCount: number
  panelCount: number
  eventHandlerCount: number
  migrationCount: number
  sessionToolCount: number
  serviceCount: number
}
import { getApi, postApi, putApi, patchApi } from './http-client.js'

export interface PluginUiContribution {
  pluginId: string
  activationGeneration: number
  contributionId: string
  /** 显示名（PanelDefinition.title），用于 tab 标签等位置 */
  label?: string
  slot:
    | 'app.navigation'
    | 'workspace.main'
    | 'right-panel.tab'
    | 'tool.detail'
    | 'trace.detail'
    | 'plugin-page.top'
    | 'home.showcase'
  scope: 'app' | 'page' | 'session'
  priority: number
  rendererKey: string
  entryKey?: string
  props?: Record<string, unknown>
  state: 'active' | 'disabled' | 'restart-required' | 'invalid'
}

export interface PluginInspect {
  schemaVersion: number
  plugin: {
    pluginId: string
    catalogId: string
    packageName: string
    version: string
    status: PluginListItem['status']
    lifecycle: PluginListItem['lifecycle']
    integrityStatus: PluginListItem['integrityStatus']
    desiredEnabled: boolean
    activationGeneration: number
    runId?: string
    restartRequired: boolean
    /** 本次启用注册的 route/service 需要重启才生效 */
    effectiveAfterRestart: boolean
    unloadScope: PluginListItem['unloadScope']
    error?: string
    dependencyDiagnostics: string[]
    lastStop?: PluginListItem['lastStop']
  }
  effects: Array<{
    id: string
    kind: string
    resourceId: string
    owner: string
    activationGeneration: number
    unloadScope: string
    state: string
    hostAttached: boolean
    createdAt: number
    disposedAt?: number
    disposeAttempts: number
    lastError?: string
  }>
  slots: Array<{
    contributionId: string
    slot: PluginUiContribution['slot']
    scope: PluginUiContribution['scope']
    priority: number
    rendererKey: string
    state: PluginUiContribution['state']
  }>
  diagnostics: string[]
}

/**
 * 插件详情（包含完整信息）
 */
export interface PluginDetail extends PluginListItem {
  /** 插件 ID（manifest.name） */
  pluginId: string
  /** 目录 ID（来自 YAML 配置） */
  catalogId: string
  /** 已授予的能力列表 */
  grants: string[]
  /** 请求的权限列表 */
  permissions: string[]
  /** 配置项 */
  config: Record<string, unknown>
  /** 已注册的工具名称列表 */
  toolNames: string[]
  /** 已注册的路由路径列表 */
  routePaths: string[]
  /** 已注册的面板 ID 列表 */
  panelIds: string[]
  /** 依赖的插件列表 */
  dependencies: string[]
  /** 文件路径（local/npm 插件） */
  filePath?: string
  /** 是否可重载 */
  reloadable: boolean
  /** 受信 renderer manifest */
  uiContributions: PluginUiContribution[]
}

/**
 * 授权更新请求
 */
export interface GrantUpdateRequest {
  /** 要授予的能力列表（全量替换） */
  grants: string[]
}

/**
 * 插件配置更新请求
 */
export interface PluginConfigUpdateRequest {
  config: Record<string, unknown>
  /** 是否启用 */
  enabled?: boolean
}

/**
 * 插件启用/禁用结果
 */
export interface PluginToggleResult {
  pluginId: string
  status: 'enabled' | 'disabled'
  /** 期望状态；enable/disable 都会持久化它 */
  desiredEnabled: boolean
  /** 本次操作注册的 route/service 需要重启才生效 */
  effectiveAfterRestart?: boolean
  restartRequired: boolean
}

/**
 * 获取所有插件列表
 */
export async function getPlugins(): Promise<PluginListItem[]> {
  const response = await getApi<{
    schemaVersion: number
    plugins: PluginListItem[]
    total: number
  }>('/api/plugins')
  return response.plugins
}

/**
 * 获取单个插件详情
 */
export async function getPlugin(pluginId: string): Promise<PluginDetail> {
  return getApi<PluginDetail>(`/api/plugins/${encodeURIComponent(pluginId)}`)
}

export async function inspectPlugin(pluginId: string): Promise<PluginInspect> {
  return getApi<PluginInspect>(`/api/plugins/${encodeURIComponent(pluginId)}/inspect`)
}

/**
 * 启用插件
 */
export async function enablePlugin(pluginId: string): Promise<PluginToggleResult> {
  return postApi<PluginToggleResult>(`/api/plugins/${encodeURIComponent(pluginId)}/enable`, {})
}

/**
 * 禁用插件
 */
export async function disablePlugin(pluginId: string): Promise<PluginToggleResult> {
  return postApi<PluginToggleResult>(`/api/plugins/${encodeURIComponent(pluginId)}/disable`, {})
}

/**
 * 更新插件配置
 */
export async function updatePluginConfig(
  pluginId: string,
  updates: PluginConfigUpdateRequest
): Promise<PluginDetail> {
  return patchApi<PluginDetail>(`/api/plugins/${encodeURIComponent(pluginId)}/config`, updates)
}

/**
 * 更新插件授权
 */
export async function updatePluginGrants(
  pluginId: string,
  grants: string[]
): Promise<{ pluginId: string; grants: string[] }> {
  return putApi<{ pluginId: string; grants: string[] }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/grants`,
    { grants } as GrantUpdateRequest
  )
}

/**
 * 重载插件（热更新）
 */
export async function reloadPlugin(
  pluginId: string
): Promise<{ pluginId: string; status: string }> {
  return postApi<{ pluginId: string; status: string }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/reload`,
    {}
  )
}

/** 获取当前启用插件的受信 renderer manifest。 */
export async function getPluginUiContributions(): Promise<{
  schemaVersion: number
  contributions: PluginUiContribution[]
}> {
  return getApi('/api/plugins/ui-contributions')
}

/**
 * 获取插件目录配置（包括 disabled 插件）
 */
export async function getPluginCatalog(): Promise<
  Array<{
    catalogId: string
    source: 'builtin' | 'local' | 'npm'
    enabled: boolean
    sourceRef?: string
  }>
> {
  return getApi('/api/plugins/catalog')
}
