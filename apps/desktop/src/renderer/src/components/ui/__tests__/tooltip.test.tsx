/**
 * Tooltip primitive
 *
 * 此前全靠原生 `title`：延迟不可控、键盘焦点不触发、贴边不翻转、放不了结构化内容。
 * 首个消费者是工作区指示器 —— 路径先被 shortenPath 砍成两级、又被 truncate 再截一次，
 * 完整路径原本无处可看。这里覆盖 hover / focus 两条触发路径与内容可达性。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'

afterEach(() => {
  cleanup()
})

function Harness() {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger>工作区</TooltipTrigger>
        <TooltipContent>D:/very/long/workspace/path</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

describe('Tooltip', () => {
  it('默认不渲染内容', () => {
    render(<Harness />)
    expect(screen.queryByText('D:/very/long/workspace/path')).toBeNull()
  })

  it('hover 后显示完整内容', async () => {
    render(<Harness />)

    // Radix 用 pointermove 判定 hover（并借 pointerType 排除触屏），非 pointerenter
    fireEvent.pointerMove(screen.getByText('工作区'), { pointerType: 'mouse' })

    await waitFor(() => {
      expect(screen.getAllByText('D:/very/long/workspace/path').length).toBeGreaterThan(0)
    })
  })

  it('键盘聚焦也触发（原生 title 做不到）', async () => {
    render(<Harness />)

    fireEvent.focus(screen.getByText('工作区'))

    await waitFor(() => {
      expect(screen.getAllByText('D:/very/long/workspace/path').length).toBeGreaterThan(0)
    })
  })

  it('trigger 通过 aria-describedby 关联提示内容', async () => {
    render(<Harness />)
    const trigger = screen.getByText('工作区')

    fireEvent.focus(trigger)

    await waitFor(() => {
      expect(trigger.getAttribute('aria-describedby')).toBeTruthy()
    })
  })
})
