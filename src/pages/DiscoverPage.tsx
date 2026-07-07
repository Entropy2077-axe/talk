import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { SearchOverlay } from '../components/SearchOverlay'
import { UnreadBadge } from '../components/UnreadBadge'
import { useSettingsStore } from '../store/useSettingsStore'
import { db } from '../db/db'
import { momentsUnreadCount } from '../lib/momentsUnread'

const BASE_ENTRIES = [
  { to: '/moments', icon: '📸', label: '朋友圈' },
  { to: '/shop', icon: '🛍️', label: '商城' },
  { to: '/warehouse', icon: '📦', label: '仓库' },
  { to: '/relationships', icon: '🕸️', label: '关系网' },
  { to: '/world-settings', icon: '🌐', label: '世界设定' },
]

export function DiscoverPage() {
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const momentsLastReadAt = useSettingsStore((s) => s.momentsLastReadAt)
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? []
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? []
  const momentsUnread = momentsUnreadCount({ lastReadAt: momentsLastReadAt, moments, socialEvents })
  const entries = adminModeEnabled ? [...BASE_ENTRIES, { to: '/sky-eye', icon: '🔭', label: '天眼' }] : BASE_ENTRIES
  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar title="发现" showSearch onSearchClick={() => setSearching(true)} />

      <div className="mx-4 mt-3 space-y-2">
        {entries.map((entry) => (
          <button
            key={entry.to}
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
