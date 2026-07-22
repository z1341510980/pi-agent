import type { ChangeValueType } from '@repo/shared/novel'

export function parseStoryValue(raw: string, valueType: ChangeValueType): unknown {
  const value = raw.trim()
  if (!value) return null
  if (valueType === 'number' || valueType === 'level') {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (valueType === 'set') {
    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Fall back to delimiter parsing below.
      }
    }
    return value.split(/[，,、]/).map((item) => item.trim()).filter(Boolean)
  }
  return value
}
