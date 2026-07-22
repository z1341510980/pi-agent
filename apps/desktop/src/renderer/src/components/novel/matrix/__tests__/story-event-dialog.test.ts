import { describe, expect, it } from 'vitest'
import { parseStoryValue } from '../story-event-value'

describe('story event value parsing', () => {
  it('keeps numeric relationship levels numeric for context semantics', () => {
    expect(parseStoryValue('70', 'level')).toBe(70)
  })

  it('parses set values from Chinese and ASCII delimiters', () => {
    expect(parseStoryValue('A，B、钥匙', 'set')).toEqual(['A', 'B', '钥匙'])
  })

  it('keeps enum and reference values as text', () => {
    expect(parseStoryValue('escalating', 'enum')).toBe('escalating')
    expect(parseStoryValue('character-b', 'reference')).toBe('character-b')
  })
})
