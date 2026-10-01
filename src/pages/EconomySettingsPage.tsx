
import { TopBar } from '../components/TopBar'
import { ToggleSwitch } from '../components/ToggleSwitch'

import { useSettingsStore } from '../store/useSettingsStore'

export function EconomySettingsPage() {

  const { currencyIconMode, customCurrencyEmoji, worldEconomyIsolated, setSettings } = useSettingsStore()
  const currencyMode = currencyIconMode ?? 'coin'

  return <div className="ui-page"><TopBar title="货币与世界资产" showBack /><div className="ui-page-scroll pb-5"><section className="ui-section-card ui-section-spaced">
    <h2 className="mb-2 text-xs font-medium text-[var(--ui-text-3)]">货币图标</h2>
    <div className="grid grid-cols-4 gap-2">
      {[
        { mode: 'coin' as const, label: '🪙', text: '金币' },
        { mode: 'emoji' as const, label: customCurrencyEmoji || '💎', text: 'emoji' },
        { mode: 'yen' as const, label: '¥', text: '人民币' },
        { mode: 'dollar' as const, label: '$', text: '美元' },
      ].map((item) => (
        <button
          key={item.mode}
          onClick={() => setSettings({ currencyIconMode: item.mode })}
          className={`rounded-lg border px-2 py-2 text-center ${currencyMode === item.mode ? 'border-[var(--ui-action)] bg-[var(--ui-action)] text-[var(--ui-on-action)]' : 'border-[var(--ui-border)] bg-[var(--ui-surface)] text-[var(--ui-text-2)]'
            }`}
        >
          <span className="block text-lg">{item.label}</span>
          <span className="text-[11px]">{item.text}</span>
        </button>
      ))}
    </div>
    {currencyMode === 'emoji' && (
      <input
        value={customCurrencyEmoji ?? ''}
        onChange={(e) => setSettings({ customCurrencyEmoji: e.target.value.slice(0, 4) })}
        placeholder="输入一个表情"
        className="mt-2 w-full rounded-lg border border-[var(--ui-border)] px-3 py-2 text-sm"
      />
    )}
  </section><section className="ui-section-card ui-section-spaced">
      <h2 className="mb-2 text-xs font-medium text-[var(--ui-text-3)]">世界经济与资产</h2>
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-sm text-[var(--ui-text)]">各世界独立保存经济与资产</p><p className="mt-1 text-[11px] leading-relaxed text-[var(--ui-text-3)]">关闭时，用户余额、仓库、职业和商城记录在所有世界间共用；开启后随世界备份切换。首次开启时，旧世界会沿用当前共享状态作为初始值。</p></div>
        <ToggleSwitch checked={worldEconomyIsolated === true} onChange={(checked) => setSettings({ worldEconomyIsolated: checked })} ariaLabel="各世界独立保存经济与资产" />
      </div>
    </section></div></div>
}
