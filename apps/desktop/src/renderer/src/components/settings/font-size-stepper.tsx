import { Minus, Plus, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFontSizes } from '@/hooks/ui/use-font-sizes'
import type { FontSizeKey } from '@/types/theme'
import { useTranslation } from '@/i18n'

interface FontSizeStepperProps {
  fontKey: FontSizeKey
  label: string
}

export function FontSizeStepper({ fontKey, label }: FontSizeStepperProps) {
  const { sizes, increment, decrement, resetFontSize, range } = useFontSizes()
  const { t } = useTranslation()
  const value = sizes[fontKey]

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => decrement(fontKey)}
          disabled={value <= range.min}
          aria-label={t('common.decrease')}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span
          className="min-w-[3ch] text-center text-sm tabular-nums"
          aria-label={t('settings.fontSize.current', { value })}
        >
          {value}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => increment(fontKey)}
          disabled={value >= range.max}
          aria-label={t('common.increase')}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => resetFontSize(fontKey)}
          aria-label={t('common.reset')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
