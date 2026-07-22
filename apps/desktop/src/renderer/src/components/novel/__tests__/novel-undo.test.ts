import { describe, it, expect, beforeEach } from 'vitest'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import type { NovelCharacter } from '@/api/novel-client'

const mockCharacter = (id: string, name: string): NovelCharacter => ({
  id,
  projectId: 'p1',
  name,
  description: '',
  identity: '',
  personality: '',
  appearance: '',
  currentState: '',
  currentGoal: '',
  currentPressure: '',
  secret: '',
  arcStage: '',
  arcHistory: '',
  speechStyle: '',
  isProtagonist: false,
  longTermDesire: '',
  plotRole: 'supporting',
  removalImpact: '',
  createdAt: 0,
  updatedAt: 0,
})

describe('novel-store undo/redo', () => {
  beforeEach(() => {
    useNovelDataStore.getState().clearProjectData()
    useNovelDataStore.getState().clearHistory()
  })

  it('upsertCharacter 进入历史栈，undo 后回退', () => {
    const { upsertCharacter, undo } = useNovelDataStore.getState()
    upsertCharacter(mockCharacter('c1', '张三'))
    expect(useNovelDataStore.getState().characters).toHaveLength(1)

    undo()
    expect(useNovelDataStore.getState().characters).toHaveLength(0)
  })

  it('undo 后 redo 可重做', () => {
    const { upsertCharacter, undo, redo } = useNovelDataStore.getState()
    upsertCharacter(mockCharacter('c1', '张三'))
    undo()
    expect(useNovelDataStore.getState().characters).toHaveLength(0)

    redo()
    expect(useNovelDataStore.getState().characters).toHaveLength(1)
    expect(useNovelDataStore.getState().characters[0].name).toBe('张三')
  })

  it('canUndo/canRedo 在栈空时为 false', () => {
    const { canUndo, canRedo } = useNovelDataStore.getState()
    expect(canUndo()).toBe(false)
    expect(canRedo()).toBe(false)
  })

  it('UI 状态字段不进入历史栈（setPlayheadChapter 不可 undo）', () => {
    const { setPlayheadChapter } = useNovelUiStore.getState()
    const { upsertCharacter, undo } = useNovelDataStore.getState()
    setPlayheadChapter(5)
    upsertCharacter(mockCharacter('c1', '李四'))
    undo()
    // upsertCharacter 已回退
    expect(useNovelDataStore.getState().characters).toHaveLength(0)
    // playheadChapter 不应回退
    expect(useNovelUiStore.getState().playheadChapter).toBe(5)
  })

  it('批量操作 clearProjectData 进入历史栈', () => {
    const { upsertCharacter, clearProjectData, undo } = useNovelDataStore.getState()
    upsertCharacter(mockCharacter('c1', '王五'))
    upsertCharacter(mockCharacter('c2', '赵六'))
    clearProjectData()
    expect(useNovelDataStore.getState().characters).toHaveLength(0)

    undo()
    expect(useNovelDataStore.getState().characters).toHaveLength(2)
  })

  it('clearHistory 清空历史栈后 canUndo 为 false', () => {
    const { upsertCharacter, clearHistory, canUndo } = useNovelDataStore.getState()
    upsertCharacter(mockCharacter('c1', '钱七'))
    expect(canUndo()).toBe(true)

    clearHistory()
    expect(canUndo()).toBe(false)
    // 数据本身不丢
    expect(useNovelDataStore.getState().characters).toHaveLength(1)
  })

  it('undoCount/redoCount 随操作正确同步', () => {
    const { upsertCharacter, undo, redo } = useNovelDataStore.getState()
    expect(useNovelDataStore.getState().undoCount).toBe(0)
    expect(useNovelDataStore.getState().redoCount).toBe(0)

    upsertCharacter(mockCharacter('c1', '测试同步'))
    expect(useNovelDataStore.getState().undoCount).toBe(1)
    expect(useNovelDataStore.getState().redoCount).toBe(0)

    undo()
    expect(useNovelDataStore.getState().undoCount).toBe(0)
    expect(useNovelDataStore.getState().redoCount).toBe(1)

    redo()
    expect(useNovelDataStore.getState().undoCount).toBe(1)
    expect(useNovelDataStore.getState().redoCount).toBe(0)
  })

  it('项目切换清理历史栈，避免跨项目数据污染', () => {
    const { upsertCharacter, setCurrentProject, canUndo, undo } = useNovelDataStore.getState()
    upsertCharacter(mockCharacter('c1', '项目A角色'))
    expect(canUndo()).toBe(true)
    expect(useNovelDataStore.getState().undoCount).toBe(1)

    // 切换到项目 B：历史栈应被清空
    setCurrentProject('project-b')
    expect(useNovelDataStore.getState().currentProjectId).toBe('project-b')
    expect(canUndo()).toBe(false)
    expect(useNovelDataStore.getState().undoCount).toBe(0)
    expect(useNovelDataStore.getState().redoCount).toBe(0)

    // undo 不应回退到项目 A 的状态
    undo()
    expect(useNovelDataStore.getState().currentProjectId).toBe('project-b')
  })
})
