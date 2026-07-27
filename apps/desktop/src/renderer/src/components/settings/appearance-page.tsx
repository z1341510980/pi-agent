import { useState } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { BUILTIN_THEMES } from '@/utils/theme/builtin-themes'
import { validateCss } from '@/utils/theme/custom-css-processor'
import { FontSizeStepper } from './font-size-stepper'
import { useFontSizes } from '@/hooks/ui/use-font-sizes'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/i18n'

export function AppearancePage() {
  const { t } = useTranslation()
  const { activeThemeId, setActiveTheme, customThemes, addCustomTheme } = useThemeStore()
  useFontSizes() // 触发 useEffect 同步 CSS 变量

  const [customCss, setCustomCss] = useState('')
  const [customName, setCustomName] = useState('')
  const [cssError, setCssError] = useState<string | null>(null)

  const allThemes = [...BUILTIN_THEMES, ...customThemes]

  const handleApplyCustomCss = () => {
    const validation = validateCss(customCss)
    if (!validation.valid) {
      setCssError(validation.error ?? 'CSS 无效')
      toast({ title: t('settings.appearance.validateCss'), description: validation.error, variant: 'destructive' })
      return
    }
    setCssError(null)
    addCustomTheme({
      id: `custom-${Date.now()}`,
      name: customName || `自定义 ${customThemes.length + 1}`,
      appearance: 'dark',
      css: customCss,
      builtin: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    toast({ title: t('common.saved') })
  }

  return (
    <div className="space-y-6 p-6">
      <section>
        <h2 className="mb-3 text-lg font-medium">{t('settings.appearance.presetThemes')}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {allThemes.map(theme => (
            <Card
              key={theme.id}
              className={`cursor-pointer p-3 transition hover:shadow-md ${activeThemeId === theme.id ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setActiveTheme(theme.id)}
            >
              <div className="mb-2 h-16 rounded-md" style={{ background: `var(--color-app-bg, #fff)` }} />
              <p className="text-sm font-medium">{theme.name}</p>
              <p className="text-xs text-muted-foreground">{theme.appearance}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">{t('settings.fontSize.body')}</h2>
        <Card className="p-4">
          <FontSizeStepper fontKey="display" label={t('settings.fontSize.display')} />
          <FontSizeStepper fontKey="heading" label={t('settings.fontSize.heading')} />
          <FontSizeStepper fontKey="body" label={t('settings.fontSize.body')} />
          <FontSizeStepper fontKey="caption" label={t('settings.fontSize.caption')} />
          <FontSizeStepper fontKey="micro" label={t('settings.fontSize.micro')} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">{t('settings.appearance.customCss')}</h2>
        <Card className="p-4 space-y-3">
          <Input
            placeholder={t('settings.appearance.customTheme')}
            value={customName}
            onChange={e => setCustomName(e.target.value)}
          />
          <textarea
            className="w-full min-h-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            placeholder=":root { --color-primary: #ff0000; }"
            value={customCss}
            onChange={e => setCustomCss(e.target.value)}
          />
          {cssError && <p className="text-sm text-destructive">{cssError}</p>}
          <Button onClick={handleApplyCustomCss} disabled={!customCss.trim()}>
            {t('common.save')}
          </Button>
        </Card>
      </section>
    </div>
  )
}
