import { describe, it, expect } from 'vitest'
import {
  evaluateProseQuality,
  formatProseQualityReport,
  buildProseRevisionPlan,
} from '../core/quality/prose-quality-evaluator.js'
import { PROSE_SHAPE_LIMITS } from '../core/quality/quality-policy.js'

/**
 * 构造够长且**彼此不同**的正常段落。
 *
 * 三个约束，缺一个就会让"干净样本"自己命中检测：
 * 1. 段落之间内容不同 —— 复述检测按相邻段落 4 字滑窗重合度判定；
 * 2. 每段至少两句 —— 否则整份样本的单句段占比是 100%；
 * 3. 不含"像" —— 否则命中泛化比喻密度。
 */
const FILLER_SENTENCES = [
  '他把灯放回桌上，动作很稳。窗外的风掀起塑料布一角，又落回去。',
  '采石坑那边传来铁器磕碰的声响。隔着两道土墙，听不清有几个人。',
  '玉佩贴着胸口，是温的。他隔着衣服按了按，指腹摸到边缘那道细纹。',
  '水碗底下沉着一层灰。他端起来抿了一口，喉咙里那股铁锈味压下去一点。',
  '棚顶漏下来的月光落在膝盖上。草席的纹路把它切成一条一条。',
  '远处有人咳嗽，咳完骂了一句。然后是翻身压塌草垫的闷响。',
  '他把工具按大小排开。最小的那把螺丝刀滚到了席子外面。',
  '手指还在抖。他攥了两下拳，指节发白，松开的时候抖得更明显。',
]


function padParagraphs(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    FILLER_SENTENCES[index % FILLER_SENTENCES.length])
}


describe('正文形态扫描：新增检测项', () => {
  it('检出作者替角色命名情绪', () => {
    const content = [
      ...padParagraphs(24),
      '他说不出心里是什么感觉。',
      '不知道是激动还是虚弱，他扶着墙站了一会儿。',
      '一种茫然的、不太真实的庆幸涌上来。',
      '心里五味杂陈。',
    ].join('\n\n')
    const report = evaluateProseQuality(content)
    const issue = report.issues.find((item) => item.code === 'emotion_naming')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    // 摘录必须给出原文位置，否则 Reviser 只能凭印象找
    expect(issue?.excerpts?.length).toBeGreaterThan(0)
  })

  it('检出相邻段落复述同一判断', () => {
    const restated = '那七个穴位在蓝星人的身上不存在。'
    const content = [
      ...padParagraphs(22),
      restated,
      `${restated}他又念了一遍。`,
      `他想，${restated}`,
      `${restated}这句话在他脑子里转。`,
    ].join('\n\n')
    const report = evaluateProseQuality(content)
    expect(report.issues.some((item) => item.code === 'redundant_restatement')).toBe(true)
  })

  it('解释腔达到 6 处升级为严重', () => {
    const content = [
      ...padParagraphs(22),
      ...Array.from({ length: 6 }, (_, index) => `这意味着他们也可以开始了${index}。`),
    ].join('\n\n')
    const report = evaluateProseQuality(content)
    const issue = report.issues.find((item) => item.code === 'explanatory_tone')
    expect(issue?.severity).toBe('error')
  })

  it('模板悬念覆盖"没有人发现"这类旁白宣布式写法', () => {
    const content = [...padParagraphs(22), '没有人发现那道切痕。'].join('\n\n')
    const report = evaluateProseQuality(content)
    expect(report.issues.some((item) => item.code === 'generic_suspense')).toBe(true)
  })

  it('形态问题带出最长连续单句段的原文，供 Reviser 做段落合成', () => {
    const content = [
      '三秒。',
      '五秒。',
      '一把电钻。',
      '一块备用电池。',
      '他把工具摊在地上。',
      ...padParagraphs(20),
    ].join('\n\n')
    const report = evaluateProseQuality(content)
    const issue = report.issues.find((item) => item.code === 'fragmented_paragraphs')
    expect(issue).toBeDefined()
    expect(issue?.excerpts).toContain('三秒。')
  })

  it('报告里输出台词统计，让声音趋同可核对', () => {
    const dialogue = Array.from({ length: 12 }, (_, index) =>
      `"这是第${index}条完整准确的回答，信息量适中。"他说。`)
    const report = evaluateProseQuality([...padParagraphs(20), ...dialogue].join('\n\n'))
    const text = formatProseQualityReport(report)
    expect(text).toContain('完整句收尾')
    expect(text).toContain('反问/回避/未答')
  })
})

describe('修订计划：区分局部替换与结构性重整', () => {
  it('严重形态问题触发结构性重整，并给出具体修法', () => {
    const content = [
      ...Array.from({ length: 30 }, (_, index) => `他停住了${index}。`),
    ].join('\n\n')
    const report = evaluateProseQuality(content)
    const plan = buildProseRevisionPlan(report)
    expect(plan.needsStructuralRework).toBe(true)
    expect(plan.instruction).toContain('结构性文字重整')
    expect(plan.instruction).toContain(
      `连续单句段不得超过 ${PROSE_SHAPE_LIMITS.maxConsecutiveSingleSentenceParagraphs} 段`,
    )
    // 结构性重整必须声明不许动的东西，否则 Reviser 会顺手改剧情
    expect(plan.instruction).toContain('情节事件')
  })

  it('只有提示级问题时不开放整章重整权限', () => {
    const content = [
      ...padParagraphs(24),
      '他不是在等命令，而是在等一个借口。',
      '这并非退让，而是让步。',
      '与其说他在犹豫，不如说他在算代价。',
    ].join('\n\n')
    const report = evaluateProseQuality(content)
    const plan = buildProseRevisionPlan(report)
    expect(plan.needsStructuralRework).toBe(false)
    expect(plan.instruction).not.toContain('结构性文字重整')
  })

  it('干净正文不产生修订指令', () => {
    const plan = buildProseRevisionPlan(evaluateProseQuality(padParagraphs(30).join('\n\n')))
    expect(plan.needsStructuralRework).toBe(false)
    expect(plan.instruction).toBe('')
  })
})
