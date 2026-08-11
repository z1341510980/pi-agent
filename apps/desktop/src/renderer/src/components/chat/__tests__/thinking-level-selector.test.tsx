/**
 * ThinkingLevelSelector 渲染逻辑测试
 *
 * 核心契约：
 * - 可选项 = supportedReasoningEfforts ∪ (allowDisableThinking ? {'off'} : ∅)
 * - 可选项 < 2 时返回 null（不渲染），避免单选项仍显示切换器
 * - 'auto' 选项始终显示（清除显式设置）
 * - 选 'auto' 时 onChange(null)，选档位时 onChange(level)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ThinkingLevelSelector } from '../thinking-level-selector'

// 多个 render 在同一 describe 内共享 DOM，必须手动 cleanup 避免「multiple elements」误报
afterEach(() => cleanup())

describe('ThinkingLevelSelector：渲染条件', () => {
  it('可选项 < 2 时不渲染', () => {
    const { container } = render(
      <ThinkingLevelSelector
        value={null}
        supportedReasoningEfforts={['medium']}
        onChange={() => {}}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('空 supportedReasoningEfforts 且 allowDisableThinking=false → 不渲染', () => {
    const { container } = render(
      <ThinkingLevelSelector
        value={null}
        onChange={() => {}}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("只有 allowDisableThinking=true（1 个 'off'） → 不渲染（< 2 项）", () => {
    const { container } = render(
      <ThinkingLevelSelector
        value={null}
        allowDisableThinking
        onChange={() => {}}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('allowDisableThinking + 至少 1 档 supportedReasoningEfforts → 渲染', () => {
    render(
      <ThinkingLevelSelector
        value={null}
        allowDisableThinking
        supportedReasoningEfforts={['medium', 'high']}
        onChange={() => {}}
      />
    )
    // trigger 应可见
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('纯 supportedReasoningEfforts（≥ 2 项） → 渲染', () => {
    render(
      <ThinkingLevelSelector
        value={null}
        supportedReasoningEfforts={['low', 'medium', 'high']}
        onChange={() => {}}
      />
    )
    expect(screen.getByRole('combobox')).toBeTruthy()
  })
})

describe('ThinkingLevelSelector：displayLabel', () => {
  it('value=null + defaultReasoningEffort="auto" → 显示「自动」', () => {
    render(
      <ThinkingLevelSelector
        value={null}
        supportedReasoningEfforts={['low', 'medium']}
        defaultReasoningEffort="auto"
        onChange={() => {}}
      />
    )
    expect(screen.getByText('自动')).toBeTruthy()
  })

  it('value=null + defaultReasoningEffort="high" → 显示「高」', () => {
    render(
      <ThinkingLevelSelector
        value={null}
        supportedReasoningEfforts={['medium', 'high']}
        defaultReasoningEffort="high"
        onChange={() => {}}
      />
    )
    expect(screen.getByText('高')).toBeTruthy()
  })

  it('value="low" + defaultReasoningEffort="high" → 显示「低」（value 优先）', () => {
    render(
      <ThinkingLevelSelector
        value="low"
        supportedReasoningEfforts={['low', 'high']}
        defaultReasoningEffort="high"
        onChange={() => {}}
      />
    )
    expect(screen.getByText('低')).toBeTruthy()
  })
})