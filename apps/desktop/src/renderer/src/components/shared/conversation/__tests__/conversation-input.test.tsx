import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConversationInput } from '../conversation-input'

describe('ConversationInput', () => {
  afterEach(cleanup)

  it('运行中允许发送时，Enter 发送内容而不是中断任务', () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()

    render(
      <ConversationInput
        onSend={onSend}
        onAbort={onAbort}
        isRunning
        allowSendWhileRunning
      />,
    )

    const input = screen.getByLabelText('消息输入')
    fireEvent.change(input, { target: { value: '请加强人物动机' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('请加强人物动机')
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('运行中允许发送时，同时保留显式停止按钮', () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()

    render(
      <ConversationInput
        onSend={onSend}
        onAbort={onAbort}
        isRunning
        allowSendWhileRunning
      />,
    )

    expect(screen.getByLabelText('发送')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('停止'))

    expect(onAbort).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('默认运行模式仍由 Enter 中断当前任务', () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()

    render(<ConversationInput onSend={onSend} onAbort={onAbort} isRunning />)
    fireEvent.keyDown(screen.getByLabelText('消息输入'), { key: 'Enter', code: 'Enter' })

    expect(onAbort).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
  })
})
