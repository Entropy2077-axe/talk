import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { UiIcon } from './UiIcon'
import { settingsEntries, type SettingsEntry } from '../lib/settingsNavigation'
import { useSettingsStore } from '../store/useSettingsStore'

export function SettingsLinks({ entries }: { entries: SettingsEntry[] }) {
  const navigate = useNavigate()
  return <div className="ui-list-card ui-section-spaced">
    {entries.map((entry) => <button type="button" key={entry.to} className="ui-list-row w-full text-left" onClick={() => navigate(entry.to)}>
      <span className="flex min-w-0 items-center gap-3">
        <UiIcon name={entry.icon} size={20} className="shrink-0 text-[var(--ui-text-2)]" />
        <span className="min-w-0"><span className="block text-[15px] text-[var(--ui-text)]">{entry.label}</span><span className="mt-0.5 block text-xs text-[var(--ui-text-3)]">{entry.note}</span></span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-[var(--ui-text-3)]" />
    </button>)}
  </div>
}

export function SettingsMenu() {
  const settings = useSettingsStore()
  return <SettingsLinks entries={settingsEntries(settings)} />
}
