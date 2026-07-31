/**
 * 长篇性能：localStorage 配额 + zundo 相等性判定
 *
 * 两处都是「长篇下才会暴露」的问题，且失败方式都很隐蔽：
 *
 * - **F1**：`NovelChapter.content` 是整章全文，300 章序列化后可达数 MB，
 *   超过 localStorage 配额会抛 QuotaExceededError，zustand persist 捕获后
 *   静默失败 —— 于是**整个 store** 的持久化全部失效，不只是章节。
 * - **F2**：`JSON.stringify` 全量比较，每次 set 都把含全文的 store 序列化两遍，
 *   而 set 在打字/拖拽时每秒触发多次。
 */
import { describe, it, expect } from 'vitest'
import { stripChapterContent, fingerprintTemporalState } from '../novel-data-store'
import type { NovelChapter } from '@/api/novel-client'

function chapter(partial: Partial<NovelChapter> = {}): NovelChapter {
  return {
    id: 'ch1',
    projectId: 'p1',
    volume: 1,
    chapterNumber: 1,
    title: '第一章',
    content: '正文'.repeat(2000),
    wordCount: 4000,
    status: 'completed',
    narrativeTask: '',
    acceptanceResult: null,
    createdAt: 1,
    updatedAt: 100,
    ...partial,
  } as NovelChapter
}

describe('stripChapterContent：不把全文写进 localStorage', () => {
  it('剥掉 content，保留其余元信息', () => {
    const stripped = stripChapterContent(chapter())

    expect(stripped.content).toBe('')
    expect(stripped.title).toBe('第一章')
    expect(stripped.wordCount).toBe(4000)
    expect(stripped.chapterNumber).toBe(1)
  })

  it('保留空串而非删字段 —— content 是必填类型，删掉会让下游 .length 抛错', () => {
    const stripped = stripChapterContent(chapter())
    expect('content' in stripped).toBe(true)
    expect(typeof stripped.content).toBe('string')
  })

  it('content 已为空时原样返回（避免无谓的对象复制）', () => {
    const empty = chapter({ content: '' })
    expect(stripChapterContent(empty)).toBe(empty)
  })

  it('不修改原对象', () => {
    const original = chapter()
    stripChapterContent(original)
    expect(original.content.length).toBeGreaterThan(0)
  })

  it('大量章节剥离后体积显著下降', () => {
    const chapters = Array.from({ length: 300 }, (_, i) =>
      chapter({ id: `ch${i}`, chapterNumber: i + 1 }),
    )
    const before = JSON.stringify(chapters).length
    const after = JSON.stringify(chapters.map(stripChapterContent)).length

    // 300 章 × 4000 字，剥离后应降到零头
    expect(after).toBeLessThan(before / 20)
  })
})

describe('fingerprintTemporalState：避免全量 JSON 序列化', () => {
  it('相同状态得到相同指纹', () => {
    const a = { chapters: [chapter()], characters: [] }
    const b = { chapters: [chapter()], characters: [] }
    expect(fingerprintTemporalState(a)).toBe(fingerprintTemporalState(b))
  })

  it('updatedAt 变化被识别 —— 实体字段变更必然改动它', () => {
    const a = { chapters: [chapter({ updatedAt: 100 })] }
    const b = { chapters: [chapter({ updatedAt: 200 })] }
    expect(fingerprintTemporalState(a)).not.toBe(fingerprintTemporalState(b))
  })

  it('新增/删除被识别（长度先变）', () => {
    const a = { chapters: [chapter()] }
    const b = { chapters: [chapter(), chapter({ id: 'ch2' })] }
    expect(fingerprintTemporalState(a)).not.toBe(fingerprintTemporalState(b))
  })

  it('id 变化被识别（替换而非修改）', () => {
    const a = { chapters: [chapter({ id: 'ch1' })] }
    const b = { chapters: [chapter({ id: 'ch2' })] }
    expect(fingerprintTemporalState(a)).not.toBe(fingerprintTemporalState(b))
  })

  it('顺序变化被识别 —— 排序也是需要进历史栈的操作', () => {
    const x = chapter({ id: 'a' })
    const y = chapter({ id: 'b' })
    expect(fingerprintTemporalState({ chapters: [x, y] }))
      .not.toBe(fingerprintTemporalState({ chapters: [y, x] }))
  })

  it('正文内容变化不影响指纹 —— 已知取舍', () => {
    // content 变更总是伴随 updatedAt 变更（后端统一维护），
    // 因此不比较正文不会漏掉真实变更；反之若比较正文就回到了全量序列化。
    const a = { chapters: [chapter({ content: 'A', updatedAt: 100 })] }
    const b = { chapters: [chapter({ content: 'B', updatedAt: 100 })] }
    expect(fingerprintTemporalState(a)).toBe(fingerprintTemporalState(b))
  })

  it('key 顺序不影响结果（对象字面量枚举顺序不保证）', () => {
    const a = { chapters: [chapter()], characters: [] }
    const b = { characters: [], chapters: [chapter()] }
    expect(fingerprintTemporalState(a)).toBe(fingerprintTemporalState(b))
  })

  it('无 updatedAt 的实体退化为按 id 比对', () => {
    const a = { nodePositions: [{ id: 'n1' }] }
    const b = { nodePositions: [{ id: 'n2' }] }
    expect(fingerprintTemporalState(a)).not.toBe(fingerprintTemporalState(b))
  })

  it('非数组字段直接参与比对', () => {
    expect(fingerprintTemporalState({ currentProjectId: 'p1' }))
      .not.toBe(fingerprintTemporalState({ currentProjectId: 'p2' }))
  })

  it('空状态不抛错', () => {
    expect(() => fingerprintTemporalState({})).not.toThrow()
  })

  it('指纹长度与正文无关 —— 这是替换全量序列化的核心收益', () => {
    const short = { chapters: [chapter({ content: 'x' })] }
    const long = { chapters: [chapter({ content: 'x'.repeat(100_000) })] }
    expect(fingerprintTemporalState(short).length).toBe(fingerprintTemporalState(long).length)
  })
})
