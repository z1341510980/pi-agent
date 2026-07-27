import { useEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { FontSizes, FontSizeKey } from '@/types/theme'

// 与现有 main.css @theme inline 块的 Type Scale 对齐
const DEFAULTS: FontSizes = {
  display: 20,
  heading: 15,
  body: 14,
  caption: 12,
  micro: 11,
}

const MIN_PX = 10
const MAX_PX = 48
const STEP = 1

export function clampFontSize(px: number): number {
  return Math.max(MIN_PX, Math.min(MAX_PX, Math.round(px)))
}

interface FontSizeStoreState {
  sizes: FontSizes
  setFontSize: (key: FontSizeKey, px: number) => void
  resetFontSize: (key: FontSizeKey) => void
  resetAll: () => void
}

export const useFontSizeStore = create<FontSizeStoreState>()(
  persist(
    (set) => ({
      sizes: DEFAULTS,
      setFontSize: (key, px) => set(state => ({
        sizes: { ...state.sizes, [key]: clampFontSize(px) }
      })),
      resetFontSize: (key) => set(state => ({
        sizes: { ...state.sizes, [key]: DEFAULTS[key] }
      })),
      resetAll: () => set({ sizes: DEFAULTS }),
    }),
    {
      name: 'wenlang-agent.font-sizes',
      storage: createJSONStorage(() => localStorage),
    }
  )
)

export function applyFontSizes(sizes: FontSizes): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--font-size-display', `${sizes.display}px`)
  root.style.setProperty('--font-size-heading', `${sizes.heading}px`)
  root.style.setProperty('--font-size-body', `${sizes.body}px`)
  root.style.setProperty('--font-size-caption', `${sizes.caption}px`)
  root.style.setProperty('--font-size-micro', `${sizes.micro}px`)
}

export function useFontSizes() {
  const sizes = useFontSizeStore(s => s.sizes)
  const setFontSize = useFontSizeStore(s => s.setFontSize)
  const resetFontSize = useFontSizeStore(s => s.resetFontSize)
  const resetAll = useFontSizeStore(s => s.resetAll)

  useEffect(() => {
    applyFontSizes(sizes)
  }, [sizes])

  return {
    sizes,
    setFontSize: (key: FontSizeKey, px: number) => setFontSize(key, clampFontSize(px)),
    resetFontSize,
    resetAll,
    increment: (key: FontSizeKey) => setFontSize(key, sizes[key] + STEP),
    decrement: (key: FontSizeKey) => setFontSize(key, sizes[key] - STEP),
    range: { min: MIN_PX, max: MAX_PX, step: STEP },
  }
}
