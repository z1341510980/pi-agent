import { describe, expect, it } from 'vitest'
import { parseJsonObject } from '../core/analysis/reference-analysis-run-worker.js'

describe('parseJsonObject 分层容错解析', () => {
  it('纯 JSON 对象直解', () => {
    expect(parseJsonObject('{"observations":[]}', '测试')).toEqual({ observations: [] })
  })

  it('完整 Markdown 围栏包裹', () => {
    const raw = '```json\n{"observations":[{"sectionId":"s1"}]}\n```'
    expect(parseJsonObject(raw, '测试')).toEqual({ observations: [{ sectionId: 's1' }] })
  })

  it('寒暄前缀 + JSON（生产实测失败样本：已收到《黑暗血时代》…）', () => {
    const raw = [
      '已收到《黑暗血时代》的前两个分包，我这就为您进行语义抽取。',
      '',
      '{"observations":[{"sectionId":"s1","metric":"pacing.rhythm","value":"短句为主","confidence":0.8,"evidence":["夜色"]}]}',
    ].join('\n')
    expect(parseJsonObject(raw, '测试')).toMatchObject({
      observations: [{ sectionId: 's1', metric: 'pacing.rhythm' }],
    })
  })

  it('JSON 后跟尾部说明文字', () => {
    const raw = '{"observations":[]}\n\n以上就是全部分析结果，如需调整请告诉我。'
    expect(parseJsonObject(raw, '测试')).toEqual({ observations: [] })
  })

  it('正文里混入零散围栏标记（前缀寒暄时常见）', () => {
    const raw = '好的，结果如下：\n```json\n{"observations":[]}\n```\n希望有帮助。'
    expect(parseJsonObject(raw, '测试')).toEqual({ observations: [] })
  })

  it('字符串值内的控制符被转义后可解', () => {
    const raw = '{"observations":[{"value":"第一行\n第二行"}]}'.replace('\\n', '\n')
    const parsed = parseJsonObject(raw, '测试')
    expect((parsed.observations as Array<{ value: string }>)[0].value).toBe('第一行\n第二行')
  })

  it('尾逗号被修复后可解', () => {
    const raw = '{"observations":[{"sectionId":"s1",}],}'
    expect(parseJsonObject(raw, '测试')).toEqual({ observations: [{ sectionId: 's1' }] })
  })

  it('嵌套对象的平衡扫描不被字符串中的花括号干扰', () => {
    const raw = '说明：{"spirit":{"summary":"用{}表示集合"},"rules":[]} 以上。'
    expect(parseJsonObject(raw, '测试')).toMatchObject({
      spirit: { summary: '用{}表示集合' },
    })
  })

  it('顶层是数组仍判失败', () => {
    expect(() => parseJsonObject('[{"a":1}]', '测试')).toThrow(/JSON 对象/)
  })

  it('完全无法解析时硬失败，错误信息携带原文开头便于定位', () => {
    const raw = '已收到《黑暗血时代》，我会尽快给出结论，请稍候。'
    try {
      parseJsonObject(raw, '参考分包语义抽取')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('参考分包语义抽取')
      expect((error as Error).message).toContain('已收到《黑暗血时代》')
    }
  })

  it('只有前半个对象（括号不平衡）不误提取', () => {
    const raw = '分析中：{"observations":[{"sectionId":"s1"}'
    expect(() => parseJsonObject(raw, '测试')).toThrow(/JSON 对象/)
  })
})
