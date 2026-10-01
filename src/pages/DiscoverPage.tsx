import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { SearchOverlay } from '../components/SearchOverlay'
import { UnreadBadge } from '../components/UnreadBadge'
import { UiIcon } from '../components/UiIcon'
import { useSettingsStore } from '../store/useSettingsStore'
import { discoverGroups, readDiscoverExpanded, saveDiscoverExpanded } from '../lib/discoverNavigation'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { db } from '../db/db'
import { momentsUnreadCount } from '../lib/momentsUnread'

export function DiscoverPage() {
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  const experienceMode = useSettingsStore((s) => s.experienceMode)
  const [expanded, setExpanded] = useState(readDiscoverExpanded)
  const momentsLastReadAt = useSettingsStore((s) => s.momentsLastReadAt)
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? []
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? []
  const momentsUnread = momentsUnreadCount({ lastReadAt: momentsLastReadAt, moments, socialEvents })

  const groups = useMemo(() => {
    return discoverGroups({ enabledModules, experienceMode })
  }, [enabledModules, experienceMode])

  function toggleGroup(id: string) {
    const next = { ...expanded, [id]: expanded[id] === false }
    setExpanded(next)
    saveDiscoverExpanded(next)
  }

  return (
    <div className="relative min-h-full bg-[var(--ui-bg)] pb-5">
      <TopBar title="发现" showSearch onSearchClick={() => setSearching(true)} />
      {groups.map((group) => <section key={group.id}>
      {group.id === 'social' ? <h2 className="ui-section-label">{group.name}</h2> :
        <button type="button" className="ui-section-label flex w-full items-center justify-between text-left" aria-expanded={expanded[group.id] !== false} aria-controls={`discover-${group.id}`} onClick={() => toggleGroup(group.id)}>
          <span>{group.name}</span>{expanded[group.id] === false ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </button>}
      <div id={`discover-${group.id}`} className="ui-list-card" hidden={group.id !== 'social' && expanded[group.id] === false}>
        {group.entries.map((entry) => (
          <button
            key={entry.to + entry.label}
            onClick={() => navigate(entry.to)}
            className="ui-list-row"
          >
            <div className="flex items-center gap-3">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--ui-special-soft)] text-lg">
                <UiIcon name={entry.icon} size={19} />
                {entry.to === '/moments' && <UnreadBadge count={momentsUnread} className="absolute -top-1 -right-1" />}
              </div>
              <span className="text-[15px] text-gray-900">{entry.label}</span>
            </div>
            <ChevronRight size={18} />
          </button>
        ))}
      </div>
      </section>)}

      <section className="ui-list-card ui-section-spaced"><button type="button" className="ui-list-row w-full" onClick={() => navigate('/modules')}><span className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--ui-special-soft)]"><UiIcon name="▦" size={19} /></span><span className="text-[15px] text-[var(--ui-text)]">管理功能</span></span><ChevronRight size={18} /></button></section>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
