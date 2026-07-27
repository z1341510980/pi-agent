import { cn } from '@/lib/utils'

export function CodeViewer({ code, language, className }: { code: string; language?: string; className?: string }) {
  return (
    <pre className={cn('p-4 text-xs overflow-auto', className)}>
      <code className={`language-${language ?? 'text'}`}>{code}</code>
    </pre>
  )
}
