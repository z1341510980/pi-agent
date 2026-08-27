/**
 * 桌面 UI Slot 系统类型定义。
 *
 * P2 只允许注册桌面编译产物中的受信任 React 组件，不执行远程源码。
 */

export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

export type SlotScope = 'root' | 'session-maybe' | 'session'

export type ChildrenDecl = Readonly<Record<string, SlotSpec>>

export interface SlotSpec {
  kind: SlotKind
  scope: SlotScope
  inject?: object
}

export interface StoredEntry {
  id: string
  component: React.ComponentType<any>
  options: {
    key?: string
    id?: string
    order?: number
    priority?: number
    label?: string | (() => string)
  }
  select?: ((owner: any) => unknown) | null
  inject?: ((...args: any[]) => Record<string, unknown>) | null
  children?: ChildrenDecl
  pluginId?: string
  contributionId?: string
}

/** PluginUiRegistry 的注册配置。Slot 类型和作用域由宿主声明。 */
export interface RegisterOptions {
  name: string
  pluginId?: string
  contributionId?: string
  priority?: number
  children?: ChildrenDecl
  select?: (owner: any) => unknown
  inject?: (...args: any[]) => Record<string, unknown>
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
}

export interface SlotRenderResult {
  entries: StoredEntry[]
  isChain: boolean
}

export type SlotEffectStatus = 'active' | 'shadowed' | 'disposed' | 'failed'

export interface SlotLedgerRecord {
  effectId: string
  slot: string
  kind: SlotKind
  scope: SlotScope
  pluginId?: string
  contributionId?: string
  priority: number
  status: SlotEffectStatus
  active: boolean
  registeredAt: number
  disposedAt?: number
  renderError?: string
}

export interface LiveSlotNode {
  name: string
  kind: SlotKind
  scope: SlotScope
  declaredBy?: string
  occupants: Array<{
    pluginId?: string
    contributionId?: string
    key?: string
    id?: string
    order?: number
    priority: number
    active: boolean
    status?: SlotEffectStatus
  }>
  children: LiveSlotNode[]
}

/** 桌面宿主预定义的 Slot。插件只能注册到这些 Slot 或宿主明确声明的子 Slot。 */
export const BUILTIN_SLOTS = {
  SIDEBAR_NAVIGATION: 'sidebar.navigation',
  CHAT_HEADER_ACTIONS: 'chat.header.actions',
  CHAT_COMPOSER_LEFT: 'chat.composer.left',
  CHAT_COMPOSER_RIGHT: 'chat.composer.right',
  CHAT_COMPOSER_DOCK: 'chat.composer.dock',
  CHAT_MESSAGE_ACTIONS: 'chat.message.actions',
  CHAT_TOOL_DETAIL: 'chat.tool.detail',
  RIGHT_PANEL_TAB: 'right-panel.tab',
  WORKSPACE_MAIN: 'workspace.main',
  PLUGIN_PAGE_TOP: 'plugin-page.top',
  PLUGIN_SETTINGS: 'plugin-settings',
  HOME_SHOWCASE: 'home.showcase',
  HOME_ACTIONS: 'home.actions',
  HOME_HERO_ASIDE: 'home.hero-aside',
  HOME_FOOTER: 'home.footer'
} as const

export type BuiltinSlot = (typeof BUILTIN_SLOTS)[keyof typeof BUILTIN_SLOTS]
