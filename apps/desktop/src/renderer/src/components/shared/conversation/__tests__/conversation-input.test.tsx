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

  it('空闲态（showStart）输入了文本时 Enter 发送文本，不直接开始', () => {
    const onSend = vi.fn()
    const onStart = vi.fn()

    render(
      <ConversationInput onSend={onSend} onAbort={vi.fn()} showStart onStart={onStart} />,
    )
    const input = screen.getByLabelText('消息输入')
    fireEvent.change(input, { target: { value: '/写 11' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('/写 11')
    expect(onStart).not.toHaveBeenCalled()
    // 发送后清空输入
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('空闲态（showStart）输入为空时 Enter 仍直接开始', () => {
    const onSend = vi.fn()
    const onStart = vi.fn()

    render(
      <ConversationInput onSend={onSend} onAbort={vi.fn()} showStart onStart={onStart} />,
    )
    fireEvent.keyDown(screen.getByLabelText('消息输入'), { key: 'Enter', code: 'Enter' })

    expect(onStart).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('空闲态（showStart）点击开始按钮：有文本先发送，无文本直接开始', () => {
    const onSend = vi.fn()
    const onStart = vi.fn()

    const { rerender } = render(
      <ConversationInput onSend={onSend} onAbort={vi.fn()} showStart onStart={onStart} />,
    )
    // 有文本 → 命令解析路径
    fireEvent.change(screen.getByLabelText('消息输入'), { target: { value: '/群聊 3' } })
    fireEvent.click(screen.getByRole('button', { name: '开始' }))
    expect(onSend).toHaveBeenCalledWith('/群聊 3')
    expect(onStart).not.toHaveBeenCalled()

    // 无文本 → 直接开始
    rerender(
      <ConversationInput onSend={onSend} onAbort={vi.fn()} showStart onStart={onStart} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '开始' }))
    expect(onStart).toHaveBeenCalledOnce()
  })
})
