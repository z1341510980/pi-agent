/**
 * Slot 运行时的宿主接线。
 *
 * 两条纪律：
 * 1. rendererKey 只能解析到本地编译产物中的白名单组件，服务端不下发可执行代码。
 * 2. 服务端贡献集合是唯一事实源，本地按"增量 diff"对齐：新增注册、消失撤销、
 *    属性变化则替换。插件在运行期被 disable 后必须真的从 UI 撤下来，
 *    不能等到应用重启（研究文档 §10.13 要求 registry 在 disable 与 generation
 *    替换时撤销对应实例）。
 */
import { createElement, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { PluginUiRegistry } from '../ui/plugin-ui-registry'
import { SlotContext } from './slot-context-value'
import { getPluginUiContributions, type PluginUiContribution } from '../api/plugin-client'
import { BUILTIN_SLOTS } from '../ui/slot-types'
import {
  HelloPanelContribution,
  HelloWorkspaceContribution,
  HelloRightPanelContribution,
  NovelWorkspaceContribution,
  NovelNavigationContribution,
  InfiniteCanvasWorkspaceContribution,
  InfiniteCanvasNavigationContribution
} from '../components/slot/trusted-renderers'

/**
 * 受信任 renderer 白名单。
 *
 * 只有出现在这里的 key 才会被实例化；未命中的 rendererKey（包括任何 URL 形态）
 * 直接跳过，不做动态 import、不做 eval。
 */
const RENDERERS: Record<string, React.ComponentType<Record<string, unknown>>> = {
  'builtin.hello-panel': HelloPanelContribution,
  'builtin.hello-workspace': HelloWorkspaceContribution,
  'builtin.hello-right-panel': HelloRightPanelContribution,
  'novel.workspace': NovelWorkspaceContribution,
  'novel.navigation': NovelNavigationContribution,
  'infinite-canvas.workspace': InfiniteCanvasWorkspaceContribution,
  'infinite-canvas.navigation': InfiniteCanvasNavigationContribution
}

export function registerTrustedRenderer(
  rendererKey: string,
  component: React.ComponentType<Record<string, unknown>>
): void {
  RENDERERS[rendererKey] = component
}

/** 服务端 slot 名 → 桌面宿主 slot 名。未列出的服务端 slot 一律跳过。 */
const SLOT_MAP: Partial<Record<PluginUiContribution['slot'], string>> = {
  'app.navigation': BUILTIN_SLOTS.SIDEBAR_NAVIGATION,
  'workspace.main': BUILTIN_SLOTS.WORKSPACE_MAIN,
  'right-panel.tab': BUILTIN_SLOTS.RIGHT_PANEL_TAB,
  'tool.detail': BUILTIN_SLOTS.CHAT_TOOL_DETAIL,
  'plugin-page.top': BUILTIN_SLOTS.PLUGIN_PAGE_TOP
}

/** 需要 key 的 keyed slot；其余按 list 处理（用 id 参与冲突判定） */
const KEYED_SLOTS = new Set<string>([BUILTIN_SLOTS.WORKSPACE_MAIN, BUILTIN_SLOTS.CHAT_TOOL_DETAIL])

// ---------------------------------------------------------------------------
// 重新拉取信号
//
// 插件的 enable/disable/reload/config 都发生在插件管理页，那里已经在
// invalidate react-query 缓存。Slot registry 不读 query 缓存，所以用一个
// 极小的订阅器把"插件集合变了"这件事通知过来，避免为此引入轮询或推送通道。
// ---------------------------------------------------------------------------
const revalidateListeners = new Set<() => void>()

/** 通知所有 SlotProvider 重新拉取贡献清单并做增量对齐。 */
export function requestSlotRevalidation(): void {
  for (const listener of [...revalidateListeners]) {
    try {
      listener()
    } catch {
      // 单个 provider 的同步失败不能影响其他 provider
    }
  }
}

function onSlotRevalidation(listener: () => void): () => void {
  revalidateListeners.add(listener)
  return () => revalidateListeners.delete(listener)
}

/** 本地已注册贡献的追踪信息 */
interface TrackedContribution {
  dispose: () => void
  /** 决定"是否需要重建"的指纹：任一字段变化都要先撤销再注册 */
  signature: string
}

/** 稳定身份：generation 参与其中，因此 generation 替换会走"撤销旧的 + 注册新的" */
function identityOf(contribution: PluginUiContribution): string {
  return `${contribution.pluginId}::${contribution.activationGeneration}::${contribution.contributionId}`
}

function signatureOf(contribution: PluginUiContribution, slot: string): string {
  return JSON.stringify([
    slot,
    contribution.rendererKey,
    contribution.priority,
    contribution.scope,
    contribution.entryKey ?? null,
    contribution.props ?? null
  ])
}

function buildRegisterOptions(
  contribution: PluginUiContribution,
  slot: string
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: slot,
    pluginId: contribution.pluginId,
    // 把 generation 编进 contributionId：registry 的 entry id 由此天然区分不同代
    contributionId: `${contribution.activationGeneration}:${contribution.contributionId}`,
    priority: contribution.priority
  }
  if (contribution.label) base.label = contribution.label
  if (KEYED_SLOTS.has(slot)) {
    base.key = contribution.entryKey ?? contribution.contributionId
  } else {
    base.id = contribution.contributionId
    if (contribution.entryKey) base.key = contribution.entryKey
  }
  return base
}

/**
 * 把服务端贡献清单同步到 registry。
 *
 * @returns 本次同步后仍然在册的贡献集合
 */
function syncContributions(
  registry: PluginUiRegistry,
  tracked: Map<string, TrackedContribution>,
  contributions: PluginUiContribution[]
): void {
  const desired = new Map<string, { contribution: PluginUiContribution; slot: string }>()
  for (const contribution of contributions) {
    // 白名单与状态两道门：任一不过就当它不存在
    if (!RENDERERS[contribution.rendererKey]) continue
    if (contribution.state !== 'active') continue
    const slot = SLOT_MAP[contribution.slot]
    if (!slot) continue
    desired.set(identityOf(contribution), { contribution, slot })
  }

  // 1. 消失的（插件被 disable / 贡献被移除 / generation 已换代）先撤销
  for (const [identity, entry] of [...tracked]) {
    const next = desired.get(identity)
    if (!next || next.contribution && signatureOf(next.contribution, next.slot) !== entry.signature) {
      entry.dispose()
      tracked.delete(identity)
    }
  }

  // 2. 新增或需要重建的再注册
  for (const [identity, { contribution, slot }] of desired) {
    if (tracked.has(identity)) continue
    const renderer = RENDERERS[contribution.rendererKey]!
    const component = (props: Record<string, unknown>) =>
      createElement(renderer, { ...contribution.props, ...props })
    try {
      const dispose = registry.register(
        { ...buildRegisterOptions(contribution, slot), children: undefined } as never,
        component
      )
      tracked.set(identity, { dispose, signature: signatureOf(contribution, slot) })
    } catch {
      // 单个 manifest 无效（slot 未声明、同 cell 同 priority 冲突等）时跳过，
      // 不影响宿主页面和其他贡献。
    }
  }
}

function useRemoteContributions(registry: PluginUiRegistry): void {
  const trackedRef = useRef<Map<string, TrackedContribution>>(new Map())

  useEffect(() => {
    const tracked = trackedRef.current
    let disposed = false

    const sync = (): void => {
      void getPluginUiContributions()
        .then(({ contributions }) => {
          if (disposed) return
          syncContributions(registry, tracked, contributions)
        })
        .catch(() => {
          // server 不可用时保留宿主 UI 与已注册贡献；管理页会单独显示 API 错误。
          // 这里刻意不撤销已有贡献：一次网络抖动不该让界面塌掉。
        })
    }

    sync()
    const unsubscribe = onSlotRevalidation(sync)

    return () => {
      disposed = true
      unsubscribe()
      for (const entry of tracked.values()) entry.dispose()
      tracked.clear()
    }
  }, [registry])
}

export function SlotProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(() => new PluginUiRegistry(), [])
  useRemoteContributions(registry)
  return <SlotContext.Provider value={registry}>{children}</SlotContext.Provider>
}

export { useSlotRegistry, useOptionalSlotRegistry } from './slot-context-value'
