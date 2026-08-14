import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { TopBar } from '../components/TopBar'
import { SearchOverlay } from '../components/SearchOverlay'
import { UnreadBadge } from '../components/UnreadBadge'
import { UiIcon } from '../components/UiIcon'
import { useSettingsStore } from '../store/useSettingsStore'
import { ALL_MODULES } from '../features'
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

      {adminModeEnabled && (
        <section>
          <h2 className="ui-section-label">管理员工具</h2>
          <button
            type="button"
            onClick={() => navigate('/ai-test-cards')}
            className="ui-list-row mx-4 w-[calc(100%-2rem)] rounded-[var(--ui-radius-card)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow)]"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--ui-special-soft)]"><UiIcon name="🧪" size={19} /></span>
              <span><span className="block text-[15px] text-gray-900">AI 自动测试</span><span className="mt-0.5 block text-[11px] text-gray-400">后台运行并人工评测真实回复</span></span>
            </span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </section>
      )}

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
