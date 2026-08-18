import { describe, expect, it } from 'vitest'
import { compileWritingStylePrompt } from '../core/prompting/writing-style-prompt-factory.js'

describe('structured style expert prompt compilation', () => {
  it('compiles kept techniques and exclusions instead of only a generic prompt', () => {
    const compiled = compileWritingStylePrompt({
      id: 'p', projectId: 'project', name: '基线', preset: 'custom', narrativePerson: 'third', narrativeDistance: 'limited', sentenceRhythm: 'balanced', dialogueRatio: 40, emotionalTemperature: 5, imageryDensity: 3, vocabularyRegister: 'plain', hardRules: [], softRules: [], positiveExamples: [], negativeExamples: [], notes: '', version: 1, createdAt: 0, updatedAt: 0,
      styleExperts: [{
        id: 'e', projectId: 'project', name: '感情蓄压', sourceTitle: '参考小说A', description: '爆发前收窄感官', distilledPrompt: '迁移蓄压机制', enabled: true, sortOrder: 0, version: 1, createdAt: 0, updatedAt: 0,
        techniques: [{ id: 't', dimension: 'emotion_craft', name: '感官收窄后释放', mechanism: '爆发前只保留一个感官通道', transfer: '在高压场景中延迟解释', evidence: [{ sectionId: 's', quote: '她没有抬头' }], metricAnchors: [], confidence: 'verified', kept: true }],
        exemplarPassages: [{ sectionId: 's', text: '她没有抬头，只把手指收紧。', reason: '爆发前蓄势' }],
        exclusions: ['原作人物姓名', '原作情节'],
      }],
    }, 'writer')
    expect(compiled.content).toContain('感官收窄后释放')
    expect(compiled.content).toContain('证据方向：她没有抬头')
    expect(compiled.content).toContain('手法样本（只学机制）：她没有抬头，只把手指收紧。')
    expect(compiled.content).toContain('不得迁移：原作人物姓名')
    expect(compiled.content).toContain('本次召集的独立文风能力')
  })
})
