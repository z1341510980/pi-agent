import { describe, expect, it } from 'vitest'
import { selectCanResume, selectHasPendingCheckpoint, selectResultContent } from '../creation-flow-selectors'

describe('creation-flow selectors', () => {
  it('derives checkpoint, resumability, and result content without UI state mutation', () => {
    expect(selectHasPendingCheckpoint(null)).toBe(false)
    expect(selectHasPendingCheckpoint({ type: 'review', phase: 'checkpoint_review', data: {} })).toBe(true)
    expect(selectCanResume({ status: 'error', canResume: true })).toBe(true)
    expect(selectResultContent({ status: 'completed', content: '正文' })).toBe('正文')
    expect(selectResultContent(null, 'fallback')).toBe('fallback')
  })
})
