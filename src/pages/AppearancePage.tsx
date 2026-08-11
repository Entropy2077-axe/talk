import { TopBar } from '../components/TopBar'
import { UI_THEMES } from '../lib/uiTheme'
import { useSettingsStore } from '../store/useSettingsStore'
import { Check, Moon, Sun } from 'lucide-react'

export function AppearancePage() {
  const uiTheme = useSettingsStore((state) => state.uiTheme ?? 'sage')
  const themeMode = useSettingsStore((state) => state.themeMode ?? 'light')
  const setSettings = useSettingsStore((state) => state.setSettings)

  return (
    <div className="appearance-page ui-page">
      <TopBar title="软件风格切换" showBack />
      <div className="appearance-scroll ui-page-scroll px-4 py-5">
        <div className="mx-auto mb-4 max-w-3xl"><p className="ui-page-kicker">外观与阅读体验</p><h1 className="ui-page-title">选择适合你的界面气质</h1><p className="ui-page-summary">风格会统一改变颜色、字体、圆角与质感，不会移动功能入口或改变操作方式。</p></div>
        <section className="appearance-panel mx-auto max-w-3xl rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] p-4 shadow-[var(--ui-shadow)]">
          <div className="mb-3">
            <h2 className="text-[15px] font-semibold text-gray-900">明暗模式</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">每套风格都包含完整的浅色与深色方案。</p>
          </div>
          <div className="appearance-mode-switch grid grid-cols-2 gap-2 bg-gray-100 p-1">
            {(['light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={themeMode === mode}
                onClick={() => setSettings({ themeMode: mode })}
                className={`appearance-mode-option px-3 py-2 text-sm ${themeMode === mode ? 'is-active bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >
                <span className="flex items-center justify-center gap-1.5">{mode === 'light' ? <Sun size={15} /> : <Moon size={15} />}{mode === 'light' ? '浅色' : '深色'}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="mx-auto mt-5 max-w-3xl">
          <div className="mb-3 px-1">
            <h2 className="text-[15px] font-semibold text-gray-900">界面风格</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">只改变颜色、字体、圆角与质感，不重新安排功能和页面结构。</p>
          </div>
          <div className="appearance-theme-grid grid gap-3 md:grid-cols-2">
            {UI_THEMES.map((theme) => (
              <ThemeChoice
                key={theme.id}
                theme={theme}
                selected={uiTheme === theme.id}
                onSelect={() => setSettings({ uiTheme: theme.id })}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ThemeChoice({
  theme,
  selected,
  onSelect,
}: {
  theme: (typeof UI_THEMES)[number]
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-preview-theme={theme.id}
      onClick={onSelect}
      className={`appearance-theme-card w-full border bg-white p-4 text-left ${selected ? 'is-selected' : 'border-gray-200'}`}
    >
      <span className="flex items-start gap-3">
        <span data-ui-scope="special" className="appearance-mini-preview" aria-hidden="true">
          <span className="appearance-mini-rail" />
          <span className="appearance-mini-content">
            <span className="appearance-mini-line wide" />
            <span className="appearance-mini-line" />
            <span className="appearance-mini-bubble" />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span>
              <strong className="appearance-theme-font-preview block text-[15px] text-gray-900">{theme.name}</strong>
              <small className="appearance-theme-font-preview mt-0.5 block text-xs text-gray-500">{theme.tagline} · 字体 Aa 123</small>
            </span>
            <span className={`appearance-check grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs ${selected ? '' : 'border border-gray-200 text-transparent'}`}><Check size={14} /></span>
          </span>
          <span className="mt-3 block text-xs leading-5 text-gray-500">{theme.description}</span>
          <span className="mt-3 flex gap-1.5" aria-hidden="true">
            {theme.swatches.map((color) => <span key={color} className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ backgroundColor: color }} />)}
          </span>
        </span>
      </span>
    </button>
  )
}
