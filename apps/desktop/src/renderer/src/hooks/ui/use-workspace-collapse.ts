import { useCallback, useEffect, useState } from 'react'

const WORKSPACE_TOGGLE_EVENT = 'pi-workspace-toggle'
const WORKSPACE_HAS_FILES_EVENT = 'pi-workspace-has-files'

interface UseWorkspaceCollapseOptions {
  preferenceKey: string
  isTemporaryWorkspace?: boolean
  defaultCollapsed?: boolean
}

export function useWorkspaceCollapse(options: UseWorkspaceCollapseOptions) {
  const { preferenceKey, isTemporaryWorkspace = false, defaultCollapsed = true } = options
  const storageKey = `pi-workspace-preference-${preferenceKey}`
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem(storageKey)
    if (stored === 'expanded') return false
    if (stored === 'collapsed') return true
    return defaultCollapsed
  })

  const persist = useCallback((next: boolean) => {
    setCollapsed(next)
    localStorage.setItem(storageKey, next ? 'collapsed' : 'expanded')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WORKSPACE_TOGGLE_EVENT, { detail: { collapsed: next, preferenceKey } }))
    }
  }, [storageKey, preferenceKey])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { hasFiles: boolean; isInitial: boolean }
      if (!detail) return
      if (isTemporaryWorkspace && detail.isInitial) return
      if (detail.hasFiles && collapsed) persist(false)
    }
    window.addEventListener(WORKSPACE_HAS_FILES_EVENT, handler)
    return () => window.removeEventListener(WORKSPACE_HAS_FILES_EVENT, handler)
  }, [collapsed, isTemporaryWorkspace, persist])

  const toggle = useCallback(() => persist(!collapsed), [collapsed, persist])

  return { collapsed, setCollapsed: persist, toggle }
}

export function dispatchWorkspaceHasFiles(hasFiles: boolean, isInitial: boolean = false) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WORKSPACE_HAS_FILES_EVENT, { detail: { hasFiles, isInitial } }))
}
