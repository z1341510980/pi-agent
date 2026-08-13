import { describe, expect, it } from 'vitest'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'

function entity(id: string, projectId: string, name: string) {
  return {
    id, projectId, name, description: `${name}描述`, identity: '调查员', currentState: '受伤',
    currentGoal: '找到真相', currentPressure: '追兵迫近', arcStage: 'resistance',
  }
}

function createBuilder() {
  const characters = [
    entity('char-local', 'project-a', '林深'),
    entity('char-partner', 'project-a', '周岚'),
  ]
  const stores = {
    listCharacters: (projectId: string) => characters.filter((item) => item.projectId === projectId),
    listConflicts: () => [],
    listForeshadowing: () => [],
    listClues: () => [],
    listFactions: () => [],
    listLocations: () => [],
    listItems: () => [],
    listWorldElements: () => [],
    listInformationLayers: () => [],
    listRelationships: (projectId: string) => projectId === 'project-a' ? [{
      id: 'rel-local', projectId, characterA: 'char-local', characterB: 'char-partner',
      relationType: '盟友', currentStage: '互相试探', trend: 'warming',
    }] : [],
    listWorldRules: (projectId: string) => projectId === 'project-a' ? [{
      id: 'rule-local', projectId, category: '代价', rule: '每次预言都会失去一段记忆', cost: '记忆缺失',
    }] : [],
  }
  return new NovelPromptBuilder({} as any, stores as any)
}

describe('minimal reference fact packs', () => {
  it('resolves existing project entities by ID or exact name and injects compact facts', () => {
    const builder = createBuilder()
    const byId = builder.buildReferenceFactPack('project-a', ['char-local'])
    const byName = builder.buildReferenceFactPack('project-a', ['林深'])

    expect(byId).toContain('必要事实引用')
    expect(byId).toContain('林深')
    expect(byId).toContain('目标：找到真相')
    expect(byName).toBe(byId)
  })

  it('adds no section for empty, unknown, or foreign references', () => {
    const builder = createBuilder()
    expect(builder.buildReferenceFactPack('project-a', [])).toBe('')
    expect(builder.buildReferenceFactPack('project-a', ['missing'])).toBe('')
    expect(builder.buildReferenceFactPack('project-b', ['char-local', '林深'])).toBe('')
  })

  it('derives Reviser facts only from entities named in structured findings', () => {
    const builder = createBuilder()
    expect(builder.buildReviewFactPack('project-a', ['林深在第三段的目标与设定冲突']))
      .toContain('目标：找到真相')
    expect(builder.buildReviewFactPack('project-a', ['第三段标点错误'])).toBe('')
  })

  it('resolves project relationships by ID or exact character-pair/type reference', () => {
    const builder = createBuilder()
    const byId = builder.buildReferenceFactPack('project-a', ['rel-local'])

    expect(byId).toContain('林深/周岚/盟友')
    expect(byId).toContain('林深 ↔ 周岚')
    expect(builder.buildReferenceFactPack('project-a', ['周岚/林深/盟友'])).toBe(byId)
    expect(builder.buildReviewFactPack('project-a', ['林深与周岚的关系变化不符合前文']))
      .toContain('类型：盟友')
  })

  it('resolves world rules by ID or exact rule text and detects them in review findings', () => {
    const builder = createBuilder()
    const byId = builder.buildReferenceFactPack('project-a', ['rule-local'])

    expect(byId).toContain('每次预言都会失去一段记忆')
    expect(byId).toContain('类别：代价')
    expect(builder.buildReferenceFactPack('project-a', ['每次预言都会失去一段记忆'])).toBe(byId)
    expect(builder.buildReviewFactPack('project-a', ['这里违反了每次预言都会失去一段记忆']))
      .toContain('原文：每次预言都会失去一段记忆')
  })

  it('历史章节事实包使用快照状态，Snapshot 外实体只补静态档案', () => {
    const builder = createBuilder()
    const boundaryCharacter = {
      ...entity('char-local', 'project-a', '林深'),
      currentState: '章前仍被困在码头',
      currentGoal: '设法离开码头',
    }
    const boundary = {
      chapterNumber: 2,
      fromSnapshot: true,
      state: {},
      entities: {
        characters: [boundaryCharacter],
        relationships: [], conflicts: [], foreshadowing: [], clues: [], factions: [],
        locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      },
    } as any

    const snapshotFact = builder.buildReferenceFactPack('project-a', ['char-local'], boundary)
    expect(snapshotFact).toContain('章前仍被困在码头')
    expect(snapshotFact).toContain('设法离开码头')
    expect(snapshotFact).not.toContain('状态：受伤')
    expect(snapshotFact).not.toContain('目标：找到真相')

    const newEntityFact = builder.buildReferenceFactPack('project-a', ['char-partner'], boundary)
    expect(newEntityFact).toContain('周岚')
    expect(newEntityFact).toContain('身份：调查员')
    expect(newEntityFact).toContain('章前动态状态未知')
    expect(newEntityFact).not.toContain('状态：受伤')
    expect(newEntityFact).not.toContain('目标：找到真相')
  })
})
