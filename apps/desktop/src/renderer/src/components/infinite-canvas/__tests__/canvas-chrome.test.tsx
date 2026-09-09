import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CanvasToolbar, type CanvasToolbarProps } from '../canvas-chrome'
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
