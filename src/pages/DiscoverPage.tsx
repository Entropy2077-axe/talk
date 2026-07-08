import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { SearchOverlay } from '../components/SearchOverlay'
import { UnreadBadge } from '../components/UnreadBadge'
import { useSettingsStore } from '../store/useSettingsStore'
import { ALL_MODULES } from '../features'
import { db } from '../db/db'
import { momentsUnreadCount } from '../lib/momentsUnread'

// Only 朋友圈 is always present — everything else is a toggleable module.
const BASE_ENTRIES = [
  { to: '/moments', icon: '📸', label: '朋友圈' },
]

export function DiscoverPage() {
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const momentsLastReadAt = useSettingsStore((s) => s.momentsLastReadAt)
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? []
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? []
  const momentsUnread = momentsUnreadCount({ lastReadAt: momentsLastReadAt, moments, socialEvents })

  const moduleEntries = useMemo(() => {
    const seen = new Set<string>()
    const entries: { to: string; icon: string; label: string }[] = []
    for (const m of ALL_MODULES) {
      if (!enabledModules.includes(m.id)) continue
      for (const e of m.discoverEntries ?? []) {
        const key = e.to + e.label
        if (seen.has(key)) continue
        seen.add(key)
        entries.push(e)
      }
    }
    return entries
  }, [enabledModules])

  const adminEntry = adminModeEnabled
    ? [{ to: '/sky-eye', icon: '🔭', label: '天眼' }]
    : []

  const entries = [
    ...BASE_ENTRIES,
    ...moduleEntries,
    ...adminEntry,
  ]

  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar title="发现" showSearch onSearchClick={() => setSearching(true)} />

      <div className="mx-4 mt-3 space-y-2">
        {entries.map((entry) => (
          <button
            key={entry.to + entry.label}
            onClick={() => navigate(entry.to)}
            className="flex w-full items-center justify-between rounded-xl bg-white px-4 py-3.5 text-left active:bg-gray-50"
          >
            <div className="flex items-center gap-3">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[#aa3bff]/10 text-lg">
                {entry.icon}
                {entry.to === '/moments' && <UnreadBadge count={momentsUnread} className="absolute -top-1 -right-1" />}
              </div>
              <span className="text-[15px] text-gray-900">{entry.label}</span>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M9 5l7 7-7 7" stroke="#c7c7cc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ))}
      </div>

      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-gray-400">更多小程序敬请期待</p>
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
