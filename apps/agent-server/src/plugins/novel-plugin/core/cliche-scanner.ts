/**
 * 防 AI 腔正则扫描器（借鉴 PlotPilot ClicheScanner）
 *
 * 与 Writer 系统提示词的 4 条风格规则对应：
 * 1. 不用"——"做转折 → em_dash_abuse
 * 2. 开头直接进入场景 → opening_scenery（开头纯风景描写，启发式）
 * 3. 结尾止于画面 → ending_summary
 * 4. 语言干净 → sudden_adverb/however_conjunction/so_conjunction
 *
 * 每个模式带 hint 字段，Reviewer 拿到扫描结果后可给出具体修改建议。
 *
 * 阈值设计：单次出现的"突然""然而"等是正常的（小说语言天然会有），
 * 只有滥用（出现 ≥ 2 次）才标记为 AI 腔。
 */

export type ClicheSeverity = 'low' | 'medium' | 'high'

export interface ClichePattern {
  /** 模式 ID（稳定，不随文案变化） */
  pattern: string
  /** 中文名称 */
  name: string
  /** 正则表达式（g 标志必须，用于全局匹配） */
  regex: RegExp
  /** 触发阈值（出现次数 >= 阈值才算命中） */
  threshold: number
  /** 修复建议 */
  hint: string
  /** 严重程度 */
  severity: ClicheSeverity
}

export interface ClicheHit {
  pattern: string
  name: string
  count: number
  /** 每个匹配的起始索引 */
  positions: number[]
  hint: string
  severity: ClicheSeverity
}

const PATTERNS: ClichePattern[] = [
  {
    pattern: 'em_dash_abuse',
    name: '滥用破折号"——"',
    regex: /——/g,
    threshold: 1,
    hint: '不使用破折号做情节转折或插说。所有转折通过角色的行动、对话或心理变化自然完成。',
    severity: 'high',
  },
  {
    pattern: 'sudden_adverb',
    name: '"突然"滥用',
    regex: /突然[，,]?/g,
    threshold: 2,
    hint: '"突然"出现过于频繁，建议改为更具体的动作描写或心理变化。如"突然门开了"→"门吱呀一声推开"。',
    severity: 'medium',
  },
  {
    pattern: 'however_conjunction',
    name: '"然而"做转折开头',
    regex: /然而[，,]?/g,
    threshold: 2,
    hint: '"然而"作为转折连词开头过于密集。建议改用角色行动或对话承载转折，如"她没有回头"。',
    severity: 'medium',
  },
  {
    pattern: 'so_conjunction',
    name: '"于是"过度使用',
    regex: /于是[，,]?/g,
    threshold: 2,
    hint: '"于是"出现频繁。建议拆分为独立句子，用动作或时间推进替代。',
    severity: 'low',
  },
  {
    pattern: 'cant_help_but',
    name: '"不禁/不由得"AI 总结腔',
    regex: /(不禁|不由得|不由自主地)/g,
    threshold: 2,
    hint: '"不禁/不由得"是 AI 总结腔的常见标志。建议直接描写角色的具体动作或表情。',
    severity: 'medium',
  },
  {
    // {1,15} 限制中间长度，避免跨句误匹配（如"仿佛春天来了。过了一会儿，他像往常一样"）
    pattern: 'simile_template',
    name: '"仿佛...一般"AI 比喻模板',
    regex: /(仿佛|宛如|犹如)[^，。！？]{1,15}(一般|似的|一样)/g,
    threshold: 2,
    hint: '比喻句式过于工整。建议减少"仿佛...一般"模板，改用更直接的意象。',
    severity: 'low',
  },
  {
    pattern: 'deep_inside',
    name: '"内心深处"等陈词滥调',
    regex: /(内心深处|灵魂深处|心底深处|心底里)/g,
    threshold: 1,
    hint: '"内心深处"是 AI 常见的情感陈词滥调。建议改用具体动作或微表情承载情感。',
    severity: 'medium',
  },
  {
    pattern: 'ending_summary',
    name: '结尾总结性句子',
    regex: /(就这样[，,].{0,20}结束了|这便是.{0,15}安排|一切都.{0,10}尘埃落定|所有的.{0,10}都.{0,10}释然)/g,
    threshold: 1,
    hint: '结尾出现总结性句子。结尾应止于一个动作、一句对话或一个画面，绝不发表总结性、感悟性的句子。',
    severity: 'high',
  },
  {
    pattern: 'opening_scenery',
    name: '开头纯风景描写',
    regex: /^[^"「『]{0,5}(天|云|风|雨|月|日|阳光|夜色|山|水)/g,
    threshold: 1,
    hint: '开头可能为纯风景/环境描写。开头必须直接进入场景、动作或对话。',
    severity: 'medium',
  },
  {
    pattern: 'meta_narration',
    name: '元叙事评论',
    regex: /(读者|观众|故事|剧情|作者|笔锋|文字)/g,
    threshold: 2,
    hint: '元叙事评论（提及"读者/故事"等）破坏沉浸感。建议删除直接对读者的称呼。',
    severity: 'medium',
  },
  {
    // 注意：与 simile_template 在"仿佛/宛如/犹如"上有重叠。
    // 区别：simile_template 检测"...一般/似的/一样"完整句式；
    //       purple_prose 检测比喻词的总体密度（threshold=3）。
    pattern: 'purple_prose',
    name: '紫色散文（过度修饰）',
    regex: /(犹如|宛若|仿佛|恍若|好似|有如)/g,
    threshold: 3,
    hint: '比喻词密度过高。建议精简，仅保留最具表现力的比喻。',
    severity: 'low',
  },
]

export class ClicheScanner {
  private readonly patterns: ClichePattern[]

  constructor(patterns: ClichePattern[] = PATTERNS) {
    this.patterns = patterns
  }

  scan(text: string): ClicheHit[] {
    if (!text) return []
    const hits: ClicheHit[] = []
    for (const p of this.patterns) {
      // 重置 regex lastIndex（g 标志会保留状态）
      p.regex.lastIndex = 0
      const positions: number[] = []
      let match: RegExpExecArray | null
      while ((match = p.regex.exec(text)) !== null) {
        positions.push(match.index)
        // 防止零宽匹配死循环
        if (match.index === p.regex.lastIndex) p.regex.lastIndex++
      }
      if (positions.length >= p.threshold) {
        hits.push({
          pattern: p.pattern,
          name: p.name,
          count: positions.length,
          positions,
          hint: p.hint,
          severity: p.severity,
        })
      }
    }
    return hits
  }
}

const defaultScanner = new ClicheScanner()

export function scanCliches(text: string): ClicheHit[] {
  return defaultScanner.scan(text)
}

/**
 * 把扫描结果格式化为 Reviewer 可读的文本块
 * 用于注入 Reviewer 系统提示词或用户消息
 *
 * 调用约定：即使 hits 为空也返回"未检测到"提示文本。
 * 若调用方希望"无命中时不注入"，应在调用前自行判断 hits.length > 0。
 */
export function formatClicheReport(hits: ClicheHit[]): string {
  if (hits.length === 0) {
    return '【防 AI 腔扫描】未检测到明显的 AI 腔模式。'
  }
  const lines: string[] = ['【防 AI 腔扫描】检测到以下问题：']
  for (const hit of hits) {
    lines.push(
      `- ${hit.name}：出现 ${hit.count} 次（严重度：${hit.severity}）`,
    )
    lines.push(`  建议：${hit.hint}`)
  }
  return lines.join('\n')
}
