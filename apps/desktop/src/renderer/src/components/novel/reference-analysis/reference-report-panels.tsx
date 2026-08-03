import type { ReactElement } from 'react'
import type { ReferenceLocalAnalysisReport, ReferenceQualityReport } from '@/api/novel-client'

export function ReferenceQualityPanel({
  report
}: {
  report: ReferenceQualityReport
}): ReactElement {
  const candidates = report.excludedCandidates
  return (
    <div className="h-full overflow-y-auto">
      <section className="grid gap-x-6 gap-y-3 border-b border-border px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="编码"
          value={`${report.encoding.toUpperCase()} · ${Math.round(report.encodingConfidence * 100)}%`}
        />
        <Metric label="章节边界" value={`${Math.round(report.chapterBoundaryConfidence * 100)}%`} />
        <Metric label="控制字符" value={String(report.controlCharacterCount)} />
        <Metric label="重复页眉/页脚" value={String(report.duplicateHeaderFooterCount)} />
      </section>
      <section className="border-b border-border px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold text-text">标准化变更</h3>
        {report.normalizationChanges.length === 0 ? (
          <p className="text-xs text-muted-foreground">未发生标准化变更</p>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text">
            {report.normalizationChanges.map((change) => (
              <span key={change.type}>
                <span className="text-muted-foreground">{change.type}</span> {change.count}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="border-b border-border px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold text-text">乱码与低置信度边界</h3>
        {report.mojibakeWarnings.length === 0 && report.lowConfidenceSectionIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">未发现乱码，章节边界无需额外警告</p>
        ) : (
          <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
            {report.mojibakeWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            {report.lowConfidenceSectionIds.length > 0 && (
              <p>{report.lowConfidenceSectionIds.length} 个章节边界需要人工确认</p>
            )}
          </div>
        )}
      </section>
      <section className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold text-text">清理与排除候选</h3>
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">未发现候选</p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {candidates.map((candidate, index) => (
              <div
                key={`${candidate.start}:${index}`}
                className="grid grid-cols-[100px_1fr] gap-3 py-2 text-xs"
              >
                <span className="font-mono text-muted-foreground">
                  {candidate.start}-{candidate.end}
                </span>
                <div>
                  <p className="text-text">{candidate.preview}</p>
                  <p className="text-[11px] text-muted-foreground">{candidate.reason}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export function ReferenceLocalReportPanel({
  report
}: {
  report: ReferenceLocalAnalysisReport
}): ReactElement {
  return (
    <div className="h-full overflow-y-auto">
      <section className="grid gap-x-6 gap-y-3 border-b border-border px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="句子"
          value={`${report.sentenceLengths.count} · 均长 ${report.sentenceLengths.average}`}
        />
        <Metric
          label="段落"
          value={`${report.paragraphLengths.count} · 均长 ${report.paragraphLengths.average}`}
        />
        <Metric label="对话字符占比" value={formatPercent(report.dialogue.ratio)} />
        <Metric
          label="纳入文本占比"
          value={formatPercent(report.dataQuality.includedCharacterRatio)}
        />
      </section>
      <section className="grid border-b border-border lg:grid-cols-2 lg:divide-x lg:divide-border">
        <div className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold text-text">句长分布</h3>
          <FrequencyRows
            entries={Object.entries(report.sentenceLengths.buckets).map(([value, count]) => ({
              value,
              count,
              ratio: count / Math.max(1, report.sentenceLengths.count)
            }))}
          />
        </div>
        <div className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold text-text">感官词信号</h3>
          <FrequencyRows
            entries={Object.entries(report.sensoryVocabulary).map(([value, count]) => ({
              value,
              count,
              ratio:
                count /
                Math.max(
                  1,
                  Object.values(report.sensoryVocabulary).reduce((sum, item) => sum + item, 0)
                )
            }))}
          />
        </div>
      </section>
      <section className="grid border-b border-border lg:grid-cols-2 lg:divide-x lg:divide-border">
        <div className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold text-text">叙事人称信号</h3>
          <FrequencyRows
            entries={[
              {
                value: '第一人称',
                count: report.narrativePersonSignals.firstPerson,
                ratio:
                  report.narrativePersonSignals.firstPerson /
                  Math.max(
                    1,
                    report.narrativePersonSignals.firstPerson +
                      report.narrativePersonSignals.thirdPerson
                  )
              },
              {
                value: '第三人称',
                count: report.narrativePersonSignals.thirdPerson,
                ratio:
                  report.narrativePersonSignals.thirdPerson /
                  Math.max(
                    1,
                    report.narrativePersonSignals.firstPerson +
                      report.narrativePersonSignals.thirdPerson
                  )
              }
            ]}
          />
        </div>
        <div className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold text-text">高频四字表达</h3>
          {report.highFrequencyExpressions.length === 0 ? (
            <p className="text-xs text-muted-foreground">未发现重复三次以上的四字表达</p>
          ) : (
            <FrequencyRows entries={report.highFrequencyExpressions.slice(0, 12)} />
          )}
        </div>
      </section>
      <section className="grid border-b border-border lg:grid-cols-2 lg:divide-x lg:divide-border">
        <div className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold text-text">高频词汇</h3>
          <div className="flex flex-wrap gap-1.5">
            {report.vocabulary.slice(0, 30).map((item) => (
              <span
                key={item.value}
                className="border-b border-border px-1.5 py-1 text-xs text-text"
              >
                {item.value} <span className="text-muted-foreground">{item.count}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold text-text">标点频率</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {report.punctuation.map((item) => (
              <span key={item.value} className="text-xs text-text">
                <span className="text-base">{item.value}</span> {item.count}
              </span>
            ))}
          </div>
        </div>
      </section>
      <section className="border-b border-border px-5 py-4">
        <h3 className="mb-3 text-xs font-semibold text-text">章节长度</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">章节</th>
                <th className="pb-2 font-medium">字符</th>
                <th className="pb-2 font-medium">句子</th>
                <th className="pb-2 font-medium">段落</th>
                <th className="pb-2 font-medium">对话占比</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.chapterLengths.map((chapter) => (
                <tr key={chapter.sectionId}>
                  <td className="py-2 text-text">{chapter.title}</td>
                  <td className="py-2 tabular-nums">{chapter.characterCount}</td>
                  <td className="py-2 tabular-nums">{chapter.sentenceCount}</td>
                  <td className="py-2 tabular-nums">{chapter.paragraphCount}</td>
                  <td className="py-2 tabular-nums">{formatPercent(chapter.dialogueRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="grid border-b border-border lg:grid-cols-2 lg:divide-x lg:divide-border">
        <div className="px-5 py-4">
          <h3 className="mb-2 text-xs font-semibold text-text">开头形态</h3>
          <ShapeSummary shape={report.openingShape} />
        </div>
        <div className="px-5 py-4">
          <h3 className="mb-2 text-xs font-semibold text-text">结尾形态</h3>
          <ShapeSummary shape={report.endingShape} />
        </div>
      </section>
      <section className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold text-text">本地语言气质观察</h3>
        <div className="space-y-1 text-xs leading-relaxed text-text">
          {report.languageToneObservations.map((observation) => (
            <p key={observation}>{observation}</p>
          ))}
        </div>
        {report.dataQuality.warnings.length > 0 && (
          <div className="mt-3 border-l-2 border-amber-500 pl-3 text-xs text-amber-700 dark:text-amber-300">
            {report.dataQuality.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-text tabular-nums">{value}</p>
    </div>
  )
}

function FrequencyRows({
  entries
}: {
  entries: Array<{ value: string; count: number; ratio: number }>
}): ReactElement {
  const max = Math.max(1, ...entries.map((entry) => entry.count))
  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div
          key={entry.value}
          className="grid grid-cols-[72px_1fr_48px] items-center gap-2 text-xs"
        >
          <span className="text-muted-foreground">{entry.value}</span>
          <div className="h-1.5 bg-muted">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.max(2, (entry.count / max) * 100)}%` }}
            />
          </div>
          <span className="text-right tabular-nums text-text">{entry.count}</span>
        </div>
      ))}
    </div>
  )
}

function ShapeSummary({
  shape
}: {
  shape: ReferenceLocalAnalysisReport['openingShape']
}): ReactElement {
  return (
    <p className="text-xs text-text">
      {shape.sentenceLength.count} 句 · 平均句长 {shape.sentenceLength.average} · 对话{' '}
      {formatPercent(shape.dialogueRatio)}
    </p>
  )
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
