import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VideoTaskQueue } from '../video-task-queue'
import type { CanvasVideoTask } from '@/api/infinite-canvas-client'
import type { CanvasTheme } from '../canvas-theme'

afterEach(cleanup)

const theme = {
  node: {
    panel: '#fff',
    fill: '#eee',
    text: '#111',
    muted: '#666',
    stroke: '#ddd',
    placeholder: '#999'
  },
  toolbar: {
    panel: '#fff',
    border: '#ddd',
    border2: '#ccc',
    item: '#333',
    itemHover: '#eee',
    activeBg: '#111',
    activeText: '#fff'
  },
  canvas: { background: '#fafafa' },
  connection: { default: '#ccc', label: '#666' }
} as unknown as CanvasTheme

function makeTask(overrides: Partial<CanvasVideoTask> = {}): CanvasVideoTask {
  return {
    id: 'task-1',
    nodeId: 'node-1',
    taskId: 'upstream-1',
    status: 'running',
    progress: null,
    error: null,
    model: 'video-model-a',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const nodeTitles = new Map([
  ['node-1', '节点一'],
  ['node-2', '节点二'],
  ['node-failed', '失败节点']
])

type QueueProps = Parameters<typeof VideoTaskQueue>[0]

function baseProps(overrides: Partial<QueueProps> = {}): QueueProps {
  return {
    theme,
    projectId: 'project-1',
    tasks: [] as CanvasVideoTask[],
    nodeTitles,
    onFocusNode: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    loading: false,
    ...overrides
  }
}

describe('VideoTaskQueue', () => {
  it('按状态渲染任务行（状态徽标 + 关联节点标题 + 错误文本），最新在前', () => {
    const tasks = [
      makeTask({
        id: 't-running',
        nodeId: 'node-1',
        status: 'running',
        progress: '45%',
        createdAt: 4
      }),
      makeTask({ id: 't-success', nodeId: 'node-2', status: 'success', createdAt: 3 }),
      makeTask({
        id: 't-failed',
        nodeId: 'node-failed',
        status: 'failed',
        error: '上游模型限流',
        createdAt: 2
      }),
      makeTask({
        id: 't-timeout',
        nodeId: null,
        status: 'timeout',
        error: '等待超时',
        createdAt: 1
      })
    ]
    render(<VideoTaskQueue {...baseProps({ tasks })} />)
    expect(screen.getByText('生成中 45%')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('已超时')).toBeTruthy()
    expect(screen.getByText('节点一')).toBeTruthy()
    expect(screen.getByText('节点二')).toBeTruthy()
    expect(screen.getByText('失败节点')).toBeTruthy()
    expect(screen.getByText('未关联节点')).toBeTruthy()
    expect(screen.getByText('上游模型限流')).toBeTruthy()
    expect(screen.getAllByText('video-model-a')).toHaveLength(4)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain('生成中')
    expect(rows[3].textContent).toContain('已超时')
  })

  it('点击「定位节点」回调该行的 nodeId', () => {
    const onFocusNode = vi.fn()
    render(
      <VideoTaskQueue
        {...baseProps({
          tasks: [makeTask({ id: 't-1', nodeId: 'node-1', status: 'success' })],
          onFocusNode
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '定位节点' }))
    expect(onFocusNode).toHaveBeenCalledTimes(1)
    expect(onFocusNode).toHaveBeenCalledWith('node-1')
  })

  it('仅 failed/timeout 行显示「重新获取」，点击回调该行 nodeId', () => {
    const onRetry = vi.fn()
    render(
      <VideoTaskQueue
        {...baseProps({
          tasks: [
            makeTask({ id: 't-ok', nodeId: 'node-1', status: 'success', createdAt: 2 }),
            makeTask({
              id: 't-fail',
              nodeId: 'node-failed',
              status: 'failed',
              error: 'x',
              createdAt: 1
            })
          ],
          onRetry
        })}
      />
    )
    expect(screen.getAllByRole('button', { name: '定位节点' })).toHaveLength(2)
    const retryButtons = screen.getAllByRole('button', { name: '重新获取' })
    expect(retryButtons).toHaveLength(1)
    fireEvent.click(retryButtons[0])
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith('node-failed')
  })

  it('空列表显示占位文案', () => {
    render(<VideoTaskQueue {...baseProps()} />)
    expect(screen.getByText('暂无视频生成任务')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('点击关闭按钮回调 onClose', () => {
    const onClose = vi.fn()
    render(<VideoTaskQueue {...baseProps({ onClose })} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
