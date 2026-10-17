import { describe, expect, it } from 'vitest'
import { createRoleBoundaryNames } from '../core/orchestration/role-boundaries.js'

describe('novel orchestration role boundaries', () => {
  it('exposes one structured boundary for every creation role', () => {
    expect(createRoleBoundaryNames()).toEqual([
      'DirectorPlanner',
      'WriterRunner',
      'QualityGate',
      'RevisionController',
      'MemoryFinalizer',
    ])
  })
})
