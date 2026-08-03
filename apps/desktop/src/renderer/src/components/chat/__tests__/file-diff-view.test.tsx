import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileDiffView,
  computeDiffStats,
  parseDiffLines,
} from '../file-diff-view'

afterEach(cleanup)

describe('parseDiffLines', () => {
  it('按首字符分出增/删/上下文', () => {
    const lines = parseDiffLines('+added\n-removed\n unchanged')

    expect(lines.map((l) => l.kind)).toEqual(['add', 'remove', 'context'])
  })

  it('识别 unified patch 的元信息行', () => {
    const lines = parseDiffLines(
      'diff --git a/x b/x\nindex 111..222\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n+new',
    )

    expect(lines.map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'meta',
      'add',
    ])
  })

  it('剥掉行号前缀后再判类型（展示型 diff）', () => {
    const lines = parseDiffLines('  12 | +added\n  13 | -removed\n  14 |  same')

    expect(lines.map((l) => l.kind)).toEqual(['add', 'remove', 'context'])
    // 原文保留行号，展示时才看得出改的是哪一行
    expect(lines[0].text).toBe('  12 | +added')
  })

  it('末尾空行是 split 产物，不计入', () => {
    expect(parseDiffLines('+a\n')).toHaveLength(1)
  })

  it('空 diff 返回空数组', () => {
    expect(parseDiffLines('')).toEqual([])
  })
})

describe('computeDiffStats', () => {
  it('只统计增删，不算上下文与元信息', () => {
    const lines = parseDiffLines('@@ -1 +1 @@\n+a\n+b\n-c\n d')

    expect(computeDiffStats(lines)).toEqual({ added: 2, removed: 1 })
  })
})

describe('FileDiffView', () => {
  const DIFF = '@@ -1,2 +1,2 @@\n-old line\n+new line\n context line'

  it('默认折叠，只显示文件名与增删统计', () => {
    render(<FileDiffView diff={DIFF} filePath="src/deep/nested/index.ts" />)

    // 只显示文件名，完整路径放 title
    expect(screen.getByText('index.ts')).not.toBeNull()
    expect(screen.getByText('+1')).not.toBeNull()
    expect(screen.getByText('−1')).not.toBeNull()
    expect(screen.queryByText('+new line')).toBeNull()
  })

  it('点击后展开逐行 diff', () => {
    render(<FileDiffView diff={DIFF} filePath="a.ts" />)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('+new line')).not.toBeNull()
    expect(screen.getByText('-old line')).not.toBeNull()
  })

  it('没有文件路径时只显示统计', () => {
    render(<FileDiffView diff={DIFF} />)

    expect(screen.getByText('+1')).not.toBeNull()
  })

  it('被后端截断时展开后给出说明', () => {
    render(<FileDiffView diff={DIFF} truncated />)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/diff 过长已被截断/)).not.toBeNull()
  })

  it('未截断时不显示截断说明', () => {
    render(<FileDiffView diff={DIFF} />)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText(/diff 过长已被截断/)).toBeNull()
  })
})
