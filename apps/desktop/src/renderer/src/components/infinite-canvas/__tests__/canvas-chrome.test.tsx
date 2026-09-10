import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CanvasToolbar, MediaSettingsNoticeCard, type CanvasToolbarProps } from '../canvas-chrome'
import { canvasThemes } from '../canvas-theme'

afterEach(cleanup)

const baseProps = (): CanvasToolbarProps => ({
  theme: canvasThemes.light,
  selectedCount: 0,
  canvasTool: 'select',
  canUndo: false,
  canRedo: false,
  settings: { backgroundMode: 'dots', showImageInfo: true },
  onCanvasToolChange: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onAddText: vi.fn(),
  onAddImage: vi.fn(),
  onAddVideo: vi.fn(),
  onAddAudio: vi.fn(),
  onAddConfig: vi.fn(),
  onAddGroup: vi.fn(),
  onAddExtensionNode: vi.fn(),
  onUpload: vi.fn(),
  onDelete: vi.fn(),
  onClear: vi.fn(),
  onSettingsChange: vi.fn()
})

describe('CanvasToolbar batch download action', () => {
  it('shows the selected count when a batch download callback is provided', () => {
    render(<CanvasToolbar {...baseProps()} selectedCount={3} onBatchDownload={vi.fn()} />)

    expect(screen.getByRole('button', { name: '批量下载选中 (3)' })).toBeTruthy()
  })

  it('calls the batch download callback when clicked', () => {
    const onBatchDownload = vi.fn()
    render(<CanvasToolbar {...baseProps()} selectedCount={2} onBatchDownload={onBatchDownload} />)

    fireEvent.click(screen.getByRole('button', { name: '批量下载选中 (2)' }))

    expect(onBatchDownload).toHaveBeenCalledTimes(1)
  })

  it('hides the batch download action when nothing is selected', () => {
    render(<CanvasToolbar {...baseProps()} onBatchDownload={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /批量下载选中/ })).toBeNull()
  })

  it('places batch download after generation logs and before delete', () => {
    render(
      <CanvasToolbar
        {...baseProps()}
        selectedCount={1}
        onBatchDownload={vi.fn()}
        onOpenMediaLogs={vi.fn()}
      />
    )

    const logsButton = screen.getByRole('button', { name: '生成日志' })
    const batchDownloadButton = screen.getByRole('button', { name: '批量下载选中 (1)' })
    const deleteButton = screen.getByRole('button', { name: '删除选中 (1)' })

    expect(logsButton.nextElementSibling).toBe(batchDownloadButton)
    expect(batchDownloadButton.nextElementSibling).toBe(deleteButton)
  })

  it('shows a disabled downloading action while the archive is being prepared', () => {
    render(
      <CanvasToolbar
        {...baseProps()}
        selectedCount={2}
        onBatchDownload={vi.fn()}
        batchDownloading
      />
    )

    const button = screen.getByRole('button', { name: '正在打包下载' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})

describe('CanvasToolbar media settings entry', () => {
  it('triggers onOpenMediaSettings when the media settings dock button is clicked', () => {
    const onOpenMediaSettings = vi.fn()
    render(<CanvasToolbar {...baseProps()} onOpenMediaSettings={onOpenMediaSettings} />)

    fireEvent.click(screen.getByRole('button', { name: '媒体生成配置' }))

    expect(onOpenMediaSettings).toHaveBeenCalledTimes(1)
  })

  it('hides the media settings entry when no callback is provided', () => {
    render(<CanvasToolbar {...baseProps()} />)

    expect(screen.queryByRole('button', { name: '媒体生成配置' })).toBeNull()
  })
})

describe('MediaSettingsNoticeCard', () => {
  it('shows the relocation notice and closes via the close button', () => {
    const onClose = vi.fn()
    render(<MediaSettingsNoticeCard theme={canvasThemes.light} onClose={onClose} />)

    expect(screen.getByText('媒体生成 Provider 已移至 设置 → 插件设置 → 媒体生成 配置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开设置' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers the host navigation escape hatch when a channel is provided', () => {
    const onClose = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <MediaSettingsNoticeCard
        theme={canvasThemes.light}
        onOpenSettings={onOpenSettings}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})
