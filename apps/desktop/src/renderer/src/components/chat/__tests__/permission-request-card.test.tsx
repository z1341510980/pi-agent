import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionRequestCard } from '../permission-request-card'
import type { ConfirmationRequestPayload } from '@/hooks/use-websocket'

/**
 * 审批卡片的行为契约。重点在两处容易做错的地方：
 * 1. 危险工具必须显式警告，且不能有任何"顺手就批准"的默认动作
 * 2. 响应在飞的时候切换到下一条请求，迟到的回调不能把新请求标成已回答
 */

afterEach(cleanup)

function makeRequest(patch: Partial<ConfirmationRequestPayload> = {}): ConfirmationRequestPayload {
  return {
    id: 'req-1',
    threadId: 't-1',
    toolCallId: 'call-1',
    toolName: 'read_file',
    args: { path: 'src/index.ts' },
    reason: '需要读取入口文件',
    createdAt: Date.now(),
    ...patch,
  }
}

describe('PermissionRequestCard', () => {
  it('展示工具名、原因与最关键的那个参数', () => {
    render(
      <PermissionRequestCard request={makeRequest()} queuedCount={0} onRespond={vi.fn()} />,
    )

    expect(screen.getByText('read_file')).not.toBeNull()
    expect(screen.getByText('需要读取入口文件')).not.toBeNull()
    // path 被提到标题行，不必展开完整参数
    expect(screen.getByText('src/index.ts')).not.toBeNull()
  })

  it('bash 判为危险并给出不可逆警告', () => {
    render(
      <PermissionRequestCard
        request={makeRequest({ toolName: 'bash', args: { command: 'rm -rf build' } })}
        queuedCount={0}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('危险')).not.toBeNull()
    expect(screen.getByText(/不可逆的副作用/)).not.toBeNull()
    expect(screen.getByText('rm -rf build')).not.toBeNull()
  })

  it('write 判为中等风险', () => {
    render(
      <PermissionRequestCard
        request={makeRequest({ toolName: 'write_file' })}
        queuedCount={0}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('中等')).not.toBeNull()
  })

  it('未知工具判为低风险且不显示危险警告', () => {
    render(
      <PermissionRequestCard
        request={makeRequest({ toolName: 'list_dir' })}
        queuedCount={0}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('低风险')).not.toBeNull()
    expect(screen.queryByText(/不可逆的副作用/)).toBeNull()
  })

  it('批准与拒绝分别回传 true / false', () => {
    const onRespond = vi.fn()
    const { unmount } = render(
      <PermissionRequestCard request={makeRequest()} queuedCount={0} onRespond={onRespond} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /批准执行/ }))
    expect(onRespond).toHaveBeenCalledWith('req-1', true)
    unmount()

    const onRespond2 = vi.fn()
    render(
      <PermissionRequestCard request={makeRequest()} queuedCount={0} onRespond={onRespond2} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }))
    expect(onRespond2).toHaveBeenCalledWith('req-1', false)
  })

  it('响应中禁用按钮，避免重复提交', () => {
    const onRespond = vi.fn()
    render(
      <PermissionRequestCard request={makeRequest()} queuedCount={0} onRespond={onRespond} />,
    )

    const approve = screen.getByRole('button', { name: /批准执行/ })
    fireEvent.click(approve)
    fireEvent.click(approve)

    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('切换到下一条请求时重置响应态（迟到回调不影响新请求）', () => {
    const onRespond = vi.fn()
    const { rerender } = render(
      <PermissionRequestCard request={makeRequest()} queuedCount={1} onRespond={onRespond} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /批准执行/ }))
    expect(onRespond).toHaveBeenCalledTimes(1)

    // 这条被处理掉，卡片换成下一条
    rerender(
      <PermissionRequestCard
        request={makeRequest({ id: 'req-2', toolName: 'bash', args: { command: 'ls' } })}
        queuedCount={0}
        onRespond={onRespond}
      />,
    )

    // 新请求的按钮必须可用
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }))
    expect(onRespond).toHaveBeenLastCalledWith('req-2', false)
  })

  it('多条待审时显示剩余数量', () => {
    render(
      <PermissionRequestCard request={makeRequest()} queuedCount={3} onRespond={vi.fn()} />,
    )

    expect(screen.getByText('还有 3 条待审')).not.toBeNull()
  })

  it('完整参数默认折叠，点击后展开', () => {
    render(
      <PermissionRequestCard
        request={makeRequest({ args: { path: 'a.ts', encoding: 'utf-8' } })}
        queuedCount={0}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.queryByText(/encoding: utf-8/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /完整参数/ }))
    expect(screen.getByText(/encoding: utf-8/)).not.toBeNull()
  })

  it('超长参数被截断，避免一个大 diff 把卡片撑到几屏高', () => {
    render(
      <PermissionRequestCard
        request={makeRequest({ toolName: 'write_file', args: { content: 'x'.repeat(2000) } })}
        queuedCount={0}
        onRespond={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /完整参数/ }))
    expect(screen.getByText(/已截断/)).not.toBeNull()
  })

  it('没有可提取的关键参数时不渲染标题行下的那一行', () => {
    render(
      <PermissionRequestCard
        request={makeRequest({ args: { flag: true }, reason: '' })}
        queuedCount={0}
        onRespond={vi.fn()}
      />,
    )

    // 只有折叠的完整参数入口，没有 target 行
    expect(screen.getByRole('button', { name: /完整参数/ })).not.toBeNull()
  })
})
