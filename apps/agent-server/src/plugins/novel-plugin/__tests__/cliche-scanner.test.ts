import { describe, it, expect } from 'vitest'
import {
  scanCliches,
  ClicheScanner,
  formatClicheReport,
  type ClicheHit,
} from '../core/cliche-scanner.js'

describe('ClicheScanner - 防 AI 腔扫描', () => {
  it('空文本返回空数组', () => {
    expect(scanCliches('')).toEqual([])
  })

  it('检测滥用破折号"——"', () => {
    const text = '他抬头看天——乌云密布——雷声轰隆——'
    const hits = scanCliches(text)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const dashHit = hits.find((h) => h.pattern === 'em_dash_abuse')
    expect(dashHit).toBeDefined()
    expect(dashHit!.count).toBe(3)
    expect(dashHit!.hint).toContain('破折号')
  })

  it('检测"突然"滥用（出现 ≥ 2 次）', () => {
    const text = '突然，门开了。突然，他笑了。突然，风停了。'
    const hits = scanCliches(text)
    const suddenHit = hits.find((h) => h.pattern === 'sudden_adverb')
    expect(suddenHit).toBeDefined()
    expect(suddenHit!.count).toBe(3)
    expect(suddenHit!.hint).toContain('突然')
  })

  it('检测"然而"作为转折连词开头（出现 ≥ 2 次）', () => {
    const text = '然而他没有说话。然而她已经走远。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'however_conjunction')
    expect(hit).toBeDefined()
    expect(hit!.count).toBe(2)
  })

  it('检测"于是"过度使用', () => {
    const text = '于是他走了。于是她哭了。于是天黑了。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'so_conjunction')
    expect(hit).toBeDefined()
    expect(hit!.count).toBe(3)
  })

  it('检测"不由得""不禁"AI 总结腔', () => {
    const text = '他不禁感叹，这真是命运的安排。她不由得想起了从前。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'cant_help_but')
    expect(hit).toBeDefined()
    expect(hit!.count).toBeGreaterThanOrEqual(2)
  })

  it('检测"仿佛...一般"AI 比喻模板', () => {
    const text = '他的眼神仿佛寒冰一般冷。她的笑容仿佛春风一般温暖。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'simile_template')
    expect(hit).toBeDefined()
    expect(hit!.count).toBe(2)
  })

  it('检测"内心深处""灵魂深处"等陈词滥调', () => {
    const text = '在他内心深处，有一个声音在呼唤。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'deep_inside')
    expect(hit).toBeDefined()
  })

  it('检测章节末尾的总结性句子"就这样，...结束了"等', () => {
    const text = '就这样，他的一天结束了。这便是命运的安排。'
    const hits = scanCliches(text)
    const summaryHit = hits.find((h) => h.pattern === 'ending_summary')
    expect(summaryHit).toBeDefined()
  })

  it('单次出现"突然"不触发（阈值保护）', () => {
    const text = '突然，他停下了脚步。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'sudden_adverb')).toBeUndefined()
  })

  it('扫描结果含位置（hit.positions 含每个匹配的索引）', () => {
    const text = '突然他笑了。突然她哭了。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'sudden_adverb')!
    expect(hit.positions.length).toBe(2)
    expect(text.substring(hit.positions[0])).toMatch(/突然/)
  })

  it('ClicheScanner 类实例可复用，结果一致', () => {
    const scanner = new ClicheScanner()
    const text = '突然，他走了。突然，她来了。'
    const r1 = scanner.scan(text)
    const r2 = scanner.scan(text)
    expect(r1).toEqual(r2)
  })

  it('formatClicheReport 把扫描结果格式化为 Reviewer 可读文本', () => {
    const hits: ClicheHit[] = [
      {
        pattern: 'sudden_adverb',
        name: '"突然"滥用',
        count: 3,
        positions: [0, 10, 20],
        hint: '建议改为更具体的动作描写或心理变化',
        severity: 'medium',
      },
    ]
    const report = formatClicheReport(hits)
    expect(report).toContain('防 AI 腔扫描')
    expect(report).toContain('"突然"滥用')
    expect(report).toContain('出现 3 次')
    expect(report).toContain('建议改为更具体的动作描写')
  })
})

describe('ClicheScanner - 补充模式覆盖', () => {
  it('检测开头纯风景描写（opening_scenery）', () => {
    const hits = scanCliches('天空阴沉沉的，他叹了口气。')
    expect(hits.find((h) => h.pattern === 'opening_scenery')).toBeDefined()
  })

  it('开头是对话时不触发 opening_scenery', () => {
    const hits = scanCliches('"走吧。"他推开门。')
    expect(hits.find((h) => h.pattern === 'opening_scenery')).toBeUndefined()
  })

  it('检测元叙事评论（meta_narration，threshold=2）', () => {
    const hits = scanCliches('读者可以感受到他的痛苦。故事还在继续。')
    const hit = hits.find((h) => h.pattern === 'meta_narration')
    expect(hit).toBeDefined()
    expect(hit!.count).toBeGreaterThanOrEqual(2)
  })

  it('单次"读者"不触发 meta_narration（阈值保护）', () => {
    const hits = scanCliches('读者朋友们好。')
    expect(hits.find((h) => h.pattern === 'meta_narration')).toBeUndefined()
  })

  it('检测紫色散文（purple_prose，threshold=3）', () => {
    const hits = scanCliches('犹如梦境，宛若天堂，仿佛前世。')
    const hit = hits.find((h) => h.pattern === 'purple_prose')
    expect(hit).toBeDefined()
    expect(hit!.count).toBeGreaterThanOrEqual(3)
  })

  it('紫色散文出现 2 次不触发（threshold=3）', () => {
    const hits = scanCliches('犹如梦境，宛若天堂。')
    expect(hits.find((h) => h.pattern === 'purple_prose')).toBeUndefined()
  })

  it('检测 ending_summary 的"这便是...安排"分支', () => {
    const hits = scanCliches('这便是命运的安排。')
    expect(hits.find((h) => h.pattern === 'ending_summary')).toBeDefined()
  })

  it('检测 ending_summary 的"一切都...尘埃落定"分支', () => {
    const hits = scanCliches('一切都尘埃落定。')
    expect(hits.find((h) => h.pattern === 'ending_summary')).toBeDefined()
  })

  it('检测 ending_summary 的"所有的...都...释然"分支', () => {
    const hits = scanCliches('所有的过往都随风释然。')
    expect(hits.find((h) => h.pattern === 'ending_summary')).toBeDefined()
  })
})
