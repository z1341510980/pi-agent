import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

const DetailPanelEditContext = createContext<((dirty: boolean) => void) | null>(null)

export function DetailPanelEditProvider({
  children,
  onDirtyChange
}: {
  children: ReactNode
  onDirtyChange: (dirty: boolean) => void
}): ReactNode {
  const value = useMemo(() => onDirtyChange, [onDirtyChange])
  return <DetailPanelEditContext.Provider value={value}>{children}</DetailPanelEditContext.Provider>
}

/** Connects existing explicit-save forms to the panel-level leave guard. */
export function useDetailPanelEditDirty(dirty: boolean): void {
  const onDirtyChange = useContext(DetailPanelEditContext)

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
}
