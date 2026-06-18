import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getApi } from '@/api'
import { UsageOverview, type UsageSummary } from '@/components/usage/usage-overview'
import { UsageCharts } from '@/components/usage/usage-charts'
import { UsageTable } from '@/components/usage/usage-table'

export interface UsagePanelProps {
  isOnline: boolean
}

export function UsagePanel({ isOnline }: UsagePanelProps): ReactElement {
  const summaryQuery = useQuery({
    queryKey: ['usage-summary'],
    queryFn: () => getApi<UsageSummary>('/api/usage/summary'),
    refetchInterval: 30_000,
    enabled: isOnline
  })

  return (
    <section className="grid gap-3.5 min-h-0 overflow-auto p-4 align-content-start">
      <UsageOverview summary={summaryQuery.data} isLoading={summaryQuery.isLoading} />
      <UsageCharts summary={summaryQuery.data} isLoading={summaryQuery.isLoading} />
      <UsageTable limit={10} />
    </section>
  )
}
