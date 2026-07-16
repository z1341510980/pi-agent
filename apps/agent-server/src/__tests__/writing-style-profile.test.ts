import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompt-manager.js'
import { compileWritingStylePrompt } from '../plugins/novel-plugin/core/writing-style-prompt-factory.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import type { NovelWritingStyleProfileInput } from '@repo/shared/novel'

let db: Database.Database
let store: NovelStore

const profileInput: NovelWritingStyleProfileInput = {
  name: '冷峻测试文风',
  preset: 'restrained',
  narrativePerson: 'third',
  narrativeDistance: 'limited',
  sentenceRhythm: 'short',
  dialogueRatio: 40,
  emotionalTemperature: 3,
  imageryDensity: 2,
  vocabularyRegister: 'plain',
  hardRules: ['不使用长横线破折号', '不替读者总结'],
  softRules: ['动作优先'],
  positiveExamples: ['雨落下来——院子里没有人动。檐下的水一滴一滴砸在石阶上。'],
  notes: '观察距离贴近当前角色。',
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  store = new NovelStore(db)
  store.createProject({
    id: 'project-1',
    title: '测试小说',
    genre: '悬疑',
    synopsis: '',
    targetWords: 100000,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  })
})

afterEach(() => db.close())

describe('writing style profile', () => {
  it('按项目 upsert 并递增版本', () => {
    const first = store.upsertWritingStyleProfile('project-1', profileInput)
    const second = store.upsertWritingStyleProfile('project-1', { ...profileInput, name: '第二版' })

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(second.id).toBe(first.id)
    expect(store.getWritingStyleProfile('project-1')).toMatchObject({
      name: '第二版',
      hardRules: profileInput.hardRules,
      positiveExamples: profileInput.positiveExamples,
    })
  })

  it('按 Agent 职责编译提示词并清理样本中的长横线', () => {
    const profile = store.upsertWritingStyleProfile('project-1', profileInput)
    const writer = compileWritingStylePrompt(profile, 'writer')
    const reviewer = compileWritingStylePrompt(profile, 'reviewer')

    expect(writer.content).toContain('项目文风档案：冷峻测试文风')
    expect(writer.content).toContain('正向文风样本')
    expect(writer.content).not.toContain('——')
    expect(reviewer.content).toContain('文风验收方式')
    expect(reviewer.profileHash).not.toBe(writer.profileHash)
  })

  it('限制文风档案注入体积，避免 Agent 身份被用户长文本撑大', () => {
    const profile = store.upsertWritingStyleProfile('project-1', profileInput)
    const compiled = compileWritingStylePrompt({
      ...profile,
      hardRules: Array.from({ length: 20 }, (_, i) => `硬规则${i + 1}：${'必须保持一致。'.repeat(50)}`),
      softRules: Array.from({ length: 20 }, (_, i) => `软偏好${i + 1}：${'可以适度使用。'.repeat(50)}`),
      positiveExamples: Array.from({ length: 5 }, (_, i) => `样本${i + 1}：${'角色推开门，屋内无人。'.repeat(100)}`),
      notes: '补充说明。'.repeat(500),
    }, 'writer')

    expect(compiled.content.length).toBeLessThan(6000)
    expect(compiled.content).toContain('硬规则8')
    expect(compiled.content).not.toContain('硬规则9')
    expect(compiled.content).toContain('【样本 2】')
    expect(compiled.content).not.toContain('【样本 3】')
  })

  it('保持共享 system prompt，并只在正文 Agent 身份层注入完整文风档案', () => {
    store.upsertWritingStyleProfile('project-1', profileInput)
    const builder = new NovelPromptBuilder(new PromptManager(db, process.cwd()), store)

    expect(builder.buildSystemPrompt('project-1', 'writer')).toBe(builder.buildSystemPrompt('project-1', 'director'))
    expect(builder.buildSystemPrompt('project-1', 'writer')).not.toContain('项目文风档案：冷峻测试文风')
    expect(builder.buildAgentIdentity('project-1', 'writer')).toContain('项目文风档案：冷峻测试文风')
    expect(builder.buildAgentIdentity('project-1', 'reviewer')).toContain('文风验收方式')
    expect(builder.buildAgentIdentity('project-1', 'director')).not.toContain('项目文风档案：冷峻测试文风')
  })
})
