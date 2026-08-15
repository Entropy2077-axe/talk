import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { SearchOverlay } from '../components/SearchOverlay'
import { UnreadBadge } from '../components/UnreadBadge'
import { UiIcon } from '../components/UiIcon'
import { useSettingsStore } from '../store/useSettingsStore'
import { getEnabledDiscoverEntries } from '../features'
import { db } from '../db/db'
import { momentsUnreadCount } from '../lib/momentsUnread'

// Only 朋友圈 is always present — everything else is a toggleable module.
const BASE_ENTRIES = [
  { to: '/social-inbox', icon: '🔔', label: '互动收件箱' },
  { to: '/moments', icon: '📸', label: '朋友圈' },
  { to: '/relationships', icon: 'network', label: '关系网' },
]

export function DiscoverPage() {
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const enabledModules = useSettingsStore((s) => s.enabledModules)
  const experienceMode = useSettingsStore((s) => s.experienceMode)
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const momentsLastReadAt = useSettingsStore((s) => s.momentsLastReadAt)
  const moments = useLiveQuery(() => db.moments.toArray(), []) ?? []
  const socialEvents = useLiveQuery(() => db.socialEvents.toArray(), []) ?? []
  const momentsUnread = momentsUnreadCount({ lastReadAt: momentsLastReadAt, moments, socialEvents })

  const moduleEntries = useMemo(() => {
    return getEnabledDiscoverEntries({ enabledModules, experienceMode })
  }, [enabledModules, experienceMode])

  const adminEntry = adminModeEnabled
    ? [
        { to: '/sky-eye', icon: '🔭', label: '天眼' },
        { to: '/ai-test-cards', icon: '🧪', label: 'AI 自动测试' },
      ]
    : []

  const entries = [
    ...BASE_ENTRIES,
    ...moduleEntries,
    ...adminEntry,
  ]

  return (
    <div className="relative min-h-full bg-[var(--ui-bg)] pb-5">
      <TopBar title="发现" showSearch onSearchClick={() => setSearching(true)} />

      <section className="ui-page-intro">
        <p className="ui-page-kicker">功能与世界</p>
        <h1 className="ui-page-title">查看动态，进入当前启用的功能</h1>
        <p className="ui-page-summary">这里仅显示已经启用且可以使用的入口。</p>
      </section>
      <h2 className="ui-section-label">可用功能</h2>
      <div className="ui-list-card">
        {entries.map((entry) => (
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ))}
      </div>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
