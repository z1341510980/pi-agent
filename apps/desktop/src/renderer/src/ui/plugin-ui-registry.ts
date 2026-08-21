/**
 * 桌面 Plugin UI Registry。
 *
 * Registry 只持有本地编译产物中的 React component；动态 bundle、eval 和
 * 远程源码执行不属于 P2。所有注册均可枚举，并通过 disposer 幂等回收。
 */

import { BUILTIN_SLOTS } from './slot-types'
import type {
  LiveSlotNode,
  RegisterOptions,
  SlotKind,
  SlotLedgerRecord,
  SlotSpec,
  StoredEntry
} from './slot-types'

interface SlotRecord {
  spec?: SlotSpec
  declaredBy?: string
  parent?: string
  entries: StoredEntry[]
  version: number
  ledgers: SlotLedgerRecord[]
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

/**
 * 取某个 effectId 的**当前**账本行。
 *
 * 同一 effectId 可以有多行历史：贡献被撤销后又以相同身份重新注册（例如 props
 * 变化触发"撤销 + 重建"）时，旧行保留为 disposed 作为审计记录，新行才是现状。
 * 因此所有状态判定必须取最后一行，否则新注册会被旧的 disposed 行判成已撤销。
 */
function currentLedger(record: SlotRecord, effectId: string): SlotLedgerRecord | undefined {
  for (let i = record.ledgers.length - 1; i >= 0; i--) {
    if (record.ledgers[i]!.effectId === effectId) return record.ledgers[i]
  }
  return undefined
}

export class PluginUiRegistry {
  private readonly records = new Map<string, SlotRecord>()
  private readonly entryErrors = new Set<
    (slot: string, entry: StoredEntry, error: unknown) => void
  >()
  private readonly rootSlots = new Set<string>()
  private sequence = 0

  constructor() {
    this.declareSlot('root', { kind: 'single', scope: 'root' }, '(built-in)')
    const builtins: Array<[string, SlotSpec]> = [
      [BUILTIN_SLOTS.SIDEBAR_NAVIGATION, { kind: 'list', scope: 'root' }],
      [BUILTIN_SLOTS.CHAT_HEADER_ACTIONS, { kind: 'list', scope: 'session-maybe' }],
      [BUILTIN_SLOTS.CHAT_COMPOSER_LEFT, { kind: 'list', scope: 'session-maybe' }],
      [BUILTIN_SLOTS.CHAT_COMPOSER_RIGHT, { kind: 'list', scope: 'session-maybe' }],
      [BUILTIN_SLOTS.CHAT_COMPOSER_DOCK, { kind: 'list', scope: 'session-maybe' }],
      [BUILTIN_SLOTS.CHAT_MESSAGE_ACTIONS, { kind: 'list', scope: 'session-maybe' }],
      [BUILTIN_SLOTS.CHAT_TOOL_DETAIL, { kind: 'keyed', scope: 'session-maybe' }],
      [BUILTIN_SLOTS.RIGHT_PANEL_TAB, { kind: 'list', scope: 'root' }],
      [BUILTIN_SLOTS.WORKSPACE_MAIN, { kind: 'keyed', scope: 'root' }],
      [BUILTIN_SLOTS.PLUGIN_PAGE_TOP, { kind: 'list', scope: 'root' }]
    ]
    for (const [name, spec] of builtins) this.declareSlot(name, spec, '(built-in)')
  }

  declareSlot(name: string, spec: SlotSpec, declaredBy = '(built-in)'): void {
    const record = this.getOrCreate(name)
    if (record.spec) {
      throw new Error(`Slot "${name}" 已被声明（由 ${record.declaredBy ?? 'unknown'}）`)
    }
    record.spec = spec
    record.declaredBy = declaredBy
    this.rootSlots.add(name)
    this.notifyDeclaration(record)
  }

  declareSlotWithDisposer(name: string, spec: SlotSpec, declaredBy = '(built-in)'): () => void {
    this.declareSlot(name, spec, declaredBy)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const record = this.records.get(name)
      if (!record || record.entries.length > 0) return
      record.spec = undefined
      record.declaredBy = undefined
      this.rootSlots.delete(name)
      this.notifyDeclaration(record)
    }
  }

  register(options: RegisterOptions, component: React.ComponentType<any>): () => void {
    const record = this.records.get(options.name)
    if (!record?.spec) {
      throw new Error(`Slot "${options.name}" 未声明（必须先由父级或框架声明）`)
    }

    this.validateOptions(options, record.spec)
    this.checkConflict(options, record)

    const childNames: string[] = []
    try {
      for (const [childName, childSpec] of Object.entries(options.children ?? {})) {
        this.declareSlot(
          childName,
          childSpec,
          `由 "${options.name}" 中的贡献声明（${options.pluginId ?? 'unknown'}）`
        )
        const child = this.getOrCreate(childName)
        child.parent = options.name
        this.rootSlots.delete(childName)
        childNames.push(childName)
      }
    } catch (error) {
      for (const childName of childNames) this.disposeDeclaration(childName)
      throw error
    }

    const entry: StoredEntry = {
      id: `${options.pluginId ?? 'unknown'}:${options.contributionId ?? `contribution-${++this.sequence}`}`,
      component,
      options: {
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        ...(options.label !== undefined ? { label: options.label } : {})
      },
      ...(options.select !== undefined ? { select: options.select } : {}),
      ...(options.inject !== undefined ? { inject: options.inject } : {}),
      ...(options.children !== undefined ? { children: options.children } : {}),
      pluginId: options.pluginId,
      contributionId: options.contributionId
    }

    record.entries = [...record.entries, entry]
    this.sortEntries(record.entries, record.spec.kind)
    const ledger: SlotLedgerRecord = {
      effectId: entry.id,
      slot: options.name,
      kind: record.spec.kind,
      scope: record.spec.scope,
      pluginId: options.pluginId,
      contributionId: options.contributionId,
      priority: options.priority ?? 0,
      status: 'active',
      active: true,
      registeredAt: Date.now()
    }
    record.ledgers.push(ledger)
    this.refreshStatuses(record)
    this.notify(record)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.removeEntry(options.name, entry.id)
      for (const childName of childNames) this.disposeDeclaration(childName)
    }
  }

  clearDeclaration(name: string): boolean {
    const record = this.records.get(name)
    if (!record || record.entries.length > 0 || !record.spec) return false
    record.spec = undefined
    record.declaredBy = undefined
    record.parent = undefined
    this.rootSlots.delete(name)
    this.notifyDeclaration(record)
    return true
  }

  ledgerSnapshot(): SlotLedgerRecord[] {
    return [...this.records.values()].flatMap((record) =>
      record.ledgers.map((ledger) => ({ ...ledger }))
    )
  }
  removeEntry(name: string, id: string): boolean {
    const record = this.records.get(name)
    if (!record) return false
    const index = record.entries.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    record.entries.splice(index, 1)
    const ledger = currentLedger(record, id)
    if (ledger) {
      ledger.status = 'disposed'
      ledger.active = false
      ledger.disposedAt = Date.now()
    }
    this.refreshStatuses(record)
    this.refreshDisposedShadow(record, id)
    this.notify(record)
    return true
  }

  entriesOfSlot(name: string): StoredEntry[] {
    const record = this.records.get(name)
    if (!record?.spec) return []
    return this.entriesOfSlotByRecord(record)
  }

  rawEntries(name: string): StoredEntry[] {
    return [...(this.records.get(name)?.entries ?? [])]
  }

  spec(name: string): SlotSpec | undefined {
    return this.records.get(name)?.spec
  }

  version(name: string): number {
    return this.records.get(name)?.version ?? 0
  }

  subscribe(name: string, listener: () => void): () => void {
    const record = this.getOrCreate(name)
    record.listeners.add(listener)
    return () => record.listeners.delete(listener)
  }

  subscribeDeclaration(name: string, listener: () => void): () => void {
    const record = this.getOrCreate(name)
    record.declarationListeners.add(listener)
    return () => record.declarationListeners.delete(listener)
  }

  snapshot(root?: string): LiveSlotNode[] {
    const names = root ? [root] : [...this.records.keys()].filter((name) => this.isRoot(name))
    return names.flatMap((name) => {
      const node = this.buildSnapshot(name, new Set())
      return node ? [node] : []
    })
  }

  reportEntryError(slot: string, entry: StoredEntry, error: unknown): void {
    const record = this.records.get(slot)
    const ledger = record ? currentLedger(record, entry.id) : undefined
    if (ledger) {
      ledger.status = 'failed'
      ledger.active = false
      ledger.renderError = error instanceof Error ? error.message : String(error)
      if (record) {
        this.refreshStatuses(record)
        this.notify(record)
      }
    }
    for (const listener of this.entryErrors) {
      try {
        listener(slot, entry, error)
      } catch {
        // 一个错误监听器不能影响其他监听器或页面渲染。
      }
    }
  }

  onEntryError(listener: (slot: string, entry: StoredEntry, error: unknown) => void): () => void {
    this.entryErrors.add(listener)
    return () => this.entryErrors.delete(listener)
  }

  clear(): void {
    for (const record of this.records.values()) {
      for (const ledger of record.ledgers) {
        if (ledger.status !== 'disposed') {
          ledger.status = 'disposed'
          ledger.active = false
          ledger.disposedAt = Date.now()
        }
      }
      record.entries = []
      record.spec = undefined
      record.declaredBy = undefined
      record.parent = undefined
      record.listeners.clear()
      record.declarationListeners.clear()
    }
    this.records.clear()
    this.rootSlots.clear()
    this.declareSlot('root', { kind: 'single', scope: 'root' }, '(built-in)')
  }

  private getOrCreate(name: string): SlotRecord {
    let record = this.records.get(name)
    if (!record) {
      record = {
        entries: [],
        version: 0,
        ledgers: [],
        listeners: new Set(),
        declarationListeners: new Set()
      }
      this.records.set(name, record)
    }
    return record
  }

  private disposeDeclaration(name: string): void {
    const record = this.records.get(name)
    if (!record || record.entries.length > 0) return
    record.spec = undefined
    record.declaredBy = undefined
    record.parent = undefined
    this.rootSlots.delete(name)
    this.notifyDeclaration(record)
  }

  private validateOptions(options: RegisterOptions, spec: SlotSpec): void {
    if (spec.kind === 'keyed' && options.key === undefined) {
      throw new Error(`keyed slot "${options.name}" 必须提供 options.key`)
    }
    if (spec.kind === 'list' && options.id === undefined) {
      throw new Error(`list slot "${options.name}" 必须提供 options.id`)
    }
    if (spec.kind === 'chain' && options.select === undefined) {
      throw new Error(`chain slot "${options.name}" 必须提供 options.select`)
    }
  }

  private checkConflict(options: RegisterOptions, record: SlotRecord): void {
    const priority = options.priority ?? 0
    const sameCell = (entry: StoredEntry): boolean => {
      if (record.spec?.kind === 'single') return true
      if (record.spec?.kind === 'keyed') return entry.options.key === options.key
      if (record.spec?.kind === 'list') return entry.options.id === options.id
      return false
    }
    const conflict = record.entries.find(
      (entry) => sameCell(entry) && (entry.options.priority ?? 0) === priority
    )
    if (conflict) {
      throw new Error(
        `Slot "${options.name}" 已有冲突注册（${conflict.pluginId ?? conflict.id}），请使用不同 priority`
      )
    }
  }

  private sortEntries(entries: StoredEntry[], kind: SlotKind): void {
    entries.sort((a, b) => {
      const priority = (a.options.priority ?? 0) - (b.options.priority ?? 0)
      if (priority !== 0) return priority
      if (kind === 'list') return (a.options.order ?? 0) - (b.options.order ?? 0)
      return 0
    })
  }

  private refreshDisposedShadow(record: SlotRecord, disposedId: string): void {
    if (!record.spec || record.spec.kind === 'list' || record.spec.kind === 'chain') return
    const disposed = currentLedger(record, disposedId)
    if (!disposed) return
    const replacement = this.entriesOfSlotByRecord(record)[0]
    if (!replacement) return
    const replacementLedger = currentLedger(record, replacement.id)
    if (replacementLedger && replacementLedger.status === 'shadowed') {
      replacementLedger.status = 'active'
      replacementLedger.active = true
    }
  }

  private refreshStatuses(record: SlotRecord): void {
    const active = new Set(this.entriesOfSlotByRecord(record).map((entry) => entry.id))
    for (const ledger of record.ledgers) {
      if (ledger.status === 'disposed' || ledger.status === 'failed') continue
      // 只有当前行参与 active/shadowed 判定：同 effectId 的历史行已定格
      if (currentLedger(record, ledger.effectId) !== ledger) continue
      ledger.active = active.has(ledger.effectId)
      ledger.status = ledger.active ? 'active' : 'shadowed'
    }
  }

  private entriesOfSlotByRecord(record: SlotRecord): StoredEntry[] {
    if (!record.spec) return []
    const usable = record.entries.filter((entry) => {
      const ledger = currentLedger(record, entry.id)
      return ledger?.status !== 'failed' && ledger?.status !== 'disposed'
    })
    if (record.spec.kind === 'list' || record.spec.kind === 'chain') return usable
    const cells = new Set<string>()
    return usable.filter((entry) => {
      const cell = record.spec?.kind === 'keyed' ? entry.options.key : '__single__'
      if (cell === undefined || cells.has(cell)) return false
      cells.add(cell)
      return true
    })
  }

  private buildSnapshot(name: string, seen: Set<string>): LiveSlotNode | undefined {
    const record = this.records.get(name)
    if (!record?.spec || seen.has(name)) return undefined
    const branch = new Set(seen)
    branch.add(name)
    const active = new Set(this.entriesOfSlotByRecord(record).map((entry) => entry.id))
    const children = [...this.records.entries()]
      .filter(([, child]) => child.spec && child.parent === name)
      .flatMap(([childName]) => {
        const child = this.buildSnapshot(childName, branch)
        return child ? [child] : []
      })
    return {
      name,
      kind: record.spec.kind,
      scope: record.spec.scope,
      ...(record.declaredBy ? { declaredBy: record.declaredBy } : {}),
      occupants: record.entries.map((entry) => ({
        pluginId: entry.pluginId,
        contributionId: entry.contributionId,
        key: entry.options.key,
        id: entry.options.id,
        order: entry.options.order,
        priority: entry.options.priority ?? 0,
        active: active.has(entry.id),
        status: currentLedger(record, entry.id)?.status
      })),
      children
    }
  }

  private isRoot(name: string): boolean {
    const record = this.records.get(name)
    return Boolean(record?.spec && !record.parent)
  }

  private notify(record: SlotRecord): void {
    record.version += 1
    for (const listener of record.listeners) {
      try {
        listener()
      } catch {
        // listener 错误隔离。
      }
    }
  }

  private notifyDeclaration(record: SlotRecord): void {
    record.version += 1
    for (const listener of record.declarationListeners) {
      try {
        listener()
      } catch {
        // listener 错误隔离。
      }
    }
  }
}

let globalRegistry: PluginUiRegistry | null = null

export function getPluginUiRegistry(): PluginUiRegistry {
  globalRegistry ??= new PluginUiRegistry()
  return globalRegistry
}

export function resetPluginUiRegistry(): void {
  globalRegistry = null
}
