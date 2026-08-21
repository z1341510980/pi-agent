import { PluginUiRegistry } from '../ui/plugin-ui-registry'
import type { ComponentType } from 'react'
import type {
  LiveSlotNode,
  RegisterOptions,
  SlotKind,
  SlotScope,
  SlotSpec,
  StoredEntry
} from '../ui/slot-types'

/** 兼容早期调用方的轻量 facade；正式扩展 API 使用 PluginUiRegistry。 */
export class SlotRegistry {
  private readonly registry = new PluginUiRegistry()

  declare(name: string, spec: SlotSpec, declaredBy = '(built-in)'): () => void {
    this.registry.declareSlotWithDisposer(name, spec, declaredBy)
    return () => this.registry.clearDeclaration(name)
  }

  register(
    name: string,
    component: ComponentType<any>,
    options: Omit<RegisterOptions, 'name'> & { kind?: SlotKind; scope?: SlotScope },
    props?: Record<string, unknown>
  ): () => void {
    const existing = this.registry.spec(name)
    if (!existing) {
      this.registry.declareSlot(name, {
        kind: options.kind ?? inferKind(name),
        scope: options.scope ?? inferScope(name)
      })
    } else if (
      (options.kind && options.kind !== existing.kind) ||
      (options.scope && options.scope !== existing.scope)
    ) {
      throw new Error(`Slot "${name}" 的 kind/scope 与既有声明不一致`)
    }
    return this.registry.register(
      { ...options, name, inject: props ? () => props : undefined },
      component
    )
  }

  unregister(name: string, id: string): boolean {
    return this.registry.removeEntry(name, id)
  }

  get(name: string): StoredEntry[] {
    return this.registry.entriesOfSlot(name)
  }

  rawEntries(name: string): StoredEntry[] {
    return this.registry.rawEntries(name)
  }

  snapshot(): LiveSlotNode[] {
    return this.registry.snapshot()
  }

  ledgerSnapshot() {
    return this.registry.ledgerSnapshot()
  }

  clear(): void {
    this.registry.clear()
  }
}

function inferKind(name: string): SlotKind {
  if (name.includes('.detail') || name.includes('.main')) return 'keyed'
  if (name.includes('.chain')) return 'chain'
  if (name.includes('.list') || name.includes('.tab') || name.includes('.action')) return 'list'
  return 'list'
}

function inferScope(name: string): SlotScope {
  return name.includes('session') ? 'session' : 'root'
}
