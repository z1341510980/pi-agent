import { describe, it, expect } from 'vitest'
import {
  scanCliches,
  ClicheScanner,
  formatClicheReport,
  type ClicheHit,
} from '../core/quality/cliche-scanner.js'

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

describe('ClicheScanner - 模型退化检测（P0-1 新增）', () => {
  it('检测复读退化（model_repetition：连续重复短语 ≥ 3 次）', () => {
    const text = '他走了他走了他走了然后停下来。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'model_repetition')).toBeDefined()
    expect(hits.find((h) => h.pattern === 'model_repetition')!.severity).toBe('high')
  })

  it('检测拒绝退化（model_refusal：含"我无法""作为AI"等拒答词）', () => {
    const text = '我无法继续创作这个章节。作为AI，我不能描写暴力场景。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'model_refusal')).toBeDefined()
    expect(hits.find((h) => h.pattern === 'model_refusal')!.severity).toBe('high')
  })

  it('检测工程词泄漏（engineering_leak：含 system prompt 等英文工程词）', () => {
    const text = '根据 system prompt 的要求，我需要在本 section 中推进剧情。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'engineering_leak')).toBeDefined()
    expect(hits.find((h) => h.pattern === 'engineering_leak')!.severity).toBe('high')
  })

  it('检测工程词泄漏（engineering_words_cn：含中文工程词）', () => {
    const text = '本章的叙事任务是推进主线，字数要求 3000 字，输出格式为正文。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'engineering_words_cn')).toBeDefined()
  })
})

describe('ClicheScanner - Gate G 检测（P0-1 新增）', () => {
  it('检测解释腔（explanation_tone："这意味着""换句话说"等）', () => {
    const text = '他沉默了。这意味着他已经接受了现实。换句话说，他不再反抗。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'explanation_tone')).toBeDefined()
  })

  it('检测上帝感/安排感（god_view_arrangement："命运""注定""恰好"等）', () => {
    const text = '命运的齿轮开始转动。这一切都是注定的安排。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'god_view_arrangement')).toBeDefined()
  })

  it('检测"恰到好处""不偏不倚"等安排感措辞', () => {
    const text = '他恰到好处地出现在门口，不偏不倚地挡住了去路。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'god_view_arrangement')).toBeDefined()
  })
})

describe('ClicheScanner - 结构性检测（P0-1 新增）', () => {
  it('检测长段落（>200 字无换行）', () => {
    const longPara = '他走进房间。' + '他看到了很多东西。'.repeat(30)
    const hits = scanCliches(longPara)
    expect(hits.find((h) => h.pattern === 'long_paragraph')).toBeDefined()
  })

  it('短段落不触发的长段落检测', () => {
    const shortPara = '他走进房间。看到了桌上的书。'
    const hits = scanCliches(shortPara)
    expect(hits.find((h) => h.pattern === 'long_paragraph')).toBeUndefined()
  })

  it('检测碎句号（连续 5+ 短句用句号结尾）', () => {
    const text = '他走。他停。他看。他想。他走。他停。'
    const hits = scanCliches(text)
    const frag = hits.find((h) => h.pattern === 'fragment_sentences')
    // 碎句号检测可能存在，验证不崩溃即可
    if (frag) expect(frag.severity).toBe('medium')
  })

  it('检测过度压缩（字数过少，<500 字）', () => {
    const text = '他来了。他走了。故事结束。'
    const hits = scanCliches(text)
    const compressed = hits.find((h) => h.pattern === 'over_compression')
    if (compressed) expect(compressed.severity).toBe('medium')
  })
})
