import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import type {
  ReferencePreflightResult,
  ReferenceSection,
  ReferenceSourceDetail
} from '@repo/shared/novel'
import { ReferenceAnalysisWorkspace } from '../reference-analysis/reference-analysis-workspace'
import { ReferenceImportPanel } from '../reference-analysis/reference-import-panel'
import { ReferenceSectionList } from '../reference-analysis/reference-section-list'

const api = vi.hoisted(() => ({
  estimateReferenceAnalysis: vi.fn(),
  getReferenceLocalReport: vi.fn(),
  getReferenceQualityReport: vi.fn(),
  getReferenceTextPreview: vi.fn(),
  listReferenceProviders: vi.fn(),
  listReferenceSections: vi.fn(),
  listReferenceSources: vi.fn(),
  getWritingStyleProfile: vi.fn(),
  listWritingStyleExperts: vi.fn(),
  updateWritingStyleExpert: vi.fn(),
  deleteWritingStyleExpert: vi.fn(),
  listWritingStyleExpertVersions: vi.fn(),
  rollbackWritingStyleExpert: vi.fn(),
  getWritingStylePromptPreview: vi.fn(),
  saveWritingStyleProfile: vi.fn(),
  createWritingStyleExpert: vi.fn(),
  distillReferenceStyle: vi.fn(),
  parseReferenceSource: vi.fn(),
  preflightReferenceFile: vi.fn(),
  preflightReferencePaste: vi.fn(),
  updateReferenceImportOptions: vi.fn(),
  updateReferenceSection: vi.fn()
}))

vi.mock('@/api/novel-client', () => api)

const DRAFT: ReferencePreflightResult = {
  id: 'source-1',
  sourceDraftId: 'source-1',
  projectId: 'project-1',
  inputKind: 'paste',
  displayName: '节奏参考',
  fileFormat: 'txt',
  fileSize: 128,
  originalHash: 'original-hash',
  normalizedHash: 'normalized-hash',
  contentHash: 'normalized-hash',
  encoding: 'utf-8',
  detectedEncoding: 'utf-8',
  encodingConfidence: 1,
  language: 'zh-CN',
  rights: { confirmed: false },
  retentionPolicy: 'manual_delete',
  sourceTextState: 'draft',
  parseStatus: 'draft',
  parserVersion: '1',
  characterCount: 8,
  estimatedTokens: 4,
  chapterCount: 1,
  estimatedChapterCount: 1,
  sceneCount: 0,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
  version: 1,
  warnings: [],
  supported: true
}

const PARSED_SOURCE: ReferenceSourceDetail = {
  ...DRAFT,
  rights: { confirmed: true, confirmedAt: '2026-08-04T00:00:01.000Z' },
  sourceTextState: 'available',
  parseStatus: 'parsed',
  version: 3
}

const LOW_CONFIDENCE_SECTION: ReferenceSection = {
  id: 'section-1',
  sourceId: 'source-1',
  type: 'chapter',
  order: 0,
  title: '第一章',
  start: 0,
  end: 100,
  characterCount: 100,
  estimatedTokens: 50,
  boundaryConfidence: 0.45,
  contentHash: 'section-hash',
  included: true,
  warnings: ['章节标题格式不稳定'],
  version: 1
}

function renderWithQueryClient(element: ReactNode): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
  return queryClient
}

beforeEach(() => {
  api.listReferenceSources.mockResolvedValue([])
  api.getWritingStyleProfile.mockResolvedValue(null)
  api.listWritingStyleExperts.mockResolvedValue([])
  api.listReferenceProviders.mockResolvedValue([
    {
      id: 'provider-1',
      name: '本地配置',
      models: [{ id: 'model-1', name: '模型一', contextWindow: 32768 }]
    }
  ])
  api.preflightReferencePaste.mockResolvedValue(DRAFT)
  api.updateReferenceImportOptions.mockResolvedValue({
    source: { ...DRAFT, rights: { confirmed: true }, version: 2 },
    warnings: []
  })
  api.parseReferenceSource.mockResolvedValue({
    source: PARSED_SOURCE,
    parseStatus: 'parsed',
    qualityReportId: 'quality-1',
    chapterCount: 1,
    sceneCount: 0,
    nextPage: 'quality'
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('参考小说分析交互', () => {
  it('覆盖通用弹框的桌面 max-width，并展示四步导航', async () => {
    const queryClient = renderWithQueryClient(
      <ReferenceAnalysisWorkspace projectId="project-1" open onOpenChange={vi.fn()} />
    )

    await screen.findByText('当前项目还没有参考源')
    const dialog = screen.getByRole('dialog')

    expect(dialog.className).toContain('w-[min(1280px,calc(100vw-32px))]')
    expect(dialog.className).toContain('sm:max-w-none')
    expect(screen.getByRole('navigation', { name: '参考小说分析页面' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /质量与章节/ }).hasAttribute('disabled')).toBe(true)

    queryClient.clear()
  })

  it('在同一个工作台内切换文风基线和专家库', async () => {
    renderWithQueryClient(
      <ReferenceAnalysisWorkspace projectId="project-1" open onOpenChange={vi.fn()} />
    )

    await screen.findByText('当前项目还没有参考源')
    fireEvent.click(screen.getByRole('button', { name: '文风基线' }))
    expect(await screen.findByText('默认文风')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '文风专家' }))
    expect(await screen.findByText('独立文风专家库')).not.toBeNull()
    expect(screen.getByText('当前项目还没有独立文风专家。')).not.toBeNull()
  })

  it('完成粘贴文本预检、权利确认和本地解析纵向路径', async () => {
    const onParsed = vi.fn()
    const onSourceCreated = vi.fn()
    const queryClient = renderWithQueryClient(
      <ReferenceImportPanel
        projectId="project-1"
        onParsed={onParsed}
        onSourceCreated={onSourceCreated}
      />
    )

    const pasteTab = screen.getByRole('tab', { name: /粘贴文本/ })
    fireEvent.mouseDown(pasteTab, { button: 0, ctrlKey: false })
    fireEvent.click(pasteTab)
    fireEvent.change(screen.getByPlaceholderText('例如：叙事节奏参考'), {
      target: { value: '节奏参考' }
    })
    fireEvent.change(screen.getByPlaceholderText('粘贴完整文本'), {
      target: { value: '第一章\n正文内容' }
    })
    fireEvent.click(screen.getByRole('button', { name: '开始编码预检' }))

    await screen.findByText('预检通过')
    expect(api.preflightReferencePaste).toHaveBeenCalledWith('project-1', {
      displayName: '节奏参考',
      text: '第一章\n正文内容'
    })
    expect(onSourceCreated).toHaveBeenCalledWith(DRAFT)

    const parseButton = screen.getByRole('button', { name: '确认并生成本地报告' })
    expect(parseButton.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认有权分析此文本/ }))
    expect(parseButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(parseButton)

    await waitFor(() => expect(onParsed).toHaveBeenCalledWith(PARSED_SOURCE))
    expect(api.updateReferenceImportOptions).toHaveBeenCalledWith(
      'source-1',
      expect.objectContaining({ rightsConfirmed: true, cloudAnalysisConfirmed: false })
    )
    expect(api.parseReferenceSource).toHaveBeenCalledWith('source-1', 2)

    queryClient.clear()
  })

  it('默认聚焦低置信度章节，并保存展开行中的修改', async () => {
    const updatedSection = { ...LOW_CONFIDENCE_SECTION, title: '新的第一章', version: 2 }
    api.updateReferenceSection.mockResolvedValue({
      source: PARSED_SOURCE,
      section: updatedSection,
      sections: [updatedSection]
    })
    const onUpdated = vi.fn()

    render(
      <ReferenceSectionList
        sections={[LOW_CONFIDENCE_SECTION]}
        attentionSectionIds={['section-1']}
        onUpdated={onUpdated}
      />
    )

    expect(screen.getByRole('tab', { name: /需确认/ }).getAttribute('aria-selected')).toBe('true')
    const titleInput = screen.getByLabelText('章节标题')
    const saveButton = screen.getByRole('button', { name: '保存修改' })
    expect(saveButton.hasAttribute('disabled')).toBe(true)

    fireEvent.change(titleInput, { target: { value: '新的第一章' } })
    expect(screen.getByText('修改尚未保存')).not.toBeNull()
    expect(saveButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(saveButton)

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith([updatedSection]))
    expect(api.updateReferenceSection).toHaveBeenCalledWith(
      'section-1',
      expect.objectContaining({ title: '新的第一章', version: 1 })
    )
  })

  it('保存一行刷新章节列表时保留其他行的未保存输入', async () => {
    const secondSection: ReferenceSection = {
      ...LOW_CONFIDENCE_SECTION,
      id: 'section-2',
      order: 1,
      title: '第二章',
      start: 100,
      end: 200,
      contentHash: 'section-hash-2'
    }
    const updatedFirst = { ...LOW_CONFIDENCE_SECTION, title: '已保存第一章', version: 2 }
    api.updateReferenceSection.mockResolvedValue({
      source: PARSED_SOURCE,
      section: updatedFirst,
      sections: [updatedFirst, secondSection]
    })

    function StatefulSectionList(): ReactNode {
      const [sections, setSections] = useState([LOW_CONFIDENCE_SECTION, secondSection])
      return (
        <ReferenceSectionList
          sections={sections}
          attentionSectionIds={['section-1', 'section-2']}
          onUpdated={setSections}
        />
      )
    }

    render(<StatefulSectionList />)
    const titleInputs = screen.getAllByLabelText('章节标题') as HTMLInputElement[]
    const saveButtons = screen.getAllByRole('button', { name: '保存修改' })
    fireEvent.change(titleInputs[0], { target: { value: '已保存第一章' } })
    fireEvent.change(titleInputs[1], { target: { value: '尚未保存第二章' } })
    fireEvent.click(saveButtons[0])

    await waitFor(() => expect(api.updateReferenceSection).toHaveBeenCalledTimes(1))
    expect((screen.getAllByLabelText('章节标题')[1] as HTMLInputElement).value).toBe(
      '尚未保存第二章'
    )
  })
})
