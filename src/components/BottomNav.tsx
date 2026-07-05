import { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { UnreadBadge } from './UnreadBadge'
import { unreadCountFor } from '../lib/unread'

const TABS = [
  { to: '/', label: '消息', icon: MessageIcon },
  { to: '/contacts', label: '联系人', icon: ContactIcon },
  { to: '/todos', label: '待办', icon: TodoIcon },
  { to: '/discover', label: '发现', icon: DiscoverIcon },
  { to: '/me', label: '我', icon: MeIcon },
]

export function BottomNav() {
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const messages = useLiveQuery(() => db.messages.toArray(), []) ?? []

  const totalUnread = useMemo(() => {
    const messagesByConv = new Map<string, typeof messages>()
    for (const m of messages) {
      const arr = messagesByConv.get(m.conversationId) ?? []
      arr.push(m)
      messagesByConv.set(m.conversationId, arr)
    }
    return conversations.reduce(
      (sum, c) => sum + unreadCountFor(c.lastReadAt, messagesByConv.get(c.id) ?? []),
      0,
    )
  }, [conversations, messages])

  return (
    <nav className="flex shrink-0 border-t border-gray-100 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      {TABS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              isActive ? 'text-gray-900' : 'text-gray-400'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <div className="relative">
                <Icon active={isActive} />
                {to === '/' && <UnreadBadge count={totalUnread} className="absolute -top-1 -right-2" />}
              </div>
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

function MessageIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4.4 3.3A.6.6 0 0 1 3 19.8V6a1 1 0 0 1 1-1Z"
        stroke={active ? '#111827' : '#9ca3af'}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function ContactIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.2" stroke={active ? '#111827' : '#9ca3af'} strokeWidth="1.7" />
      <path
        d="M5 19c1.2-3.2 3.8-5 7-5s5.8 1.8 7 5"
        stroke={active ? '#111827' : '#9ca3af'}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}
function TodoIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="4.5" y="4" width="15" height="16" rx="2" stroke={active ? '#111827' : '#9ca3af'} strokeWidth="1.7" />
      <path
        d="M8 9.5l1.6 1.6L12.5 8"
        stroke={active ? '#111827' : '#9ca3af'}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.5 15h7" stroke={active ? '#111827' : '#9ca3af'} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
function DiscoverIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke={active ? '#111827' : '#9ca3af'} strokeWidth="1.7" />
      <path
        d="M15 9l-2 5-4 1.5L11 10l4-1Z"
        stroke={active ? '#111827' : '#9ca3af'}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function MeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.6" stroke={active ? '#111827' : '#9ca3af'} strokeWidth="1.7" />
      <path
        d="M4.5 20c1.4-4 4.3-6.2 7.5-6.2s6.1 2.2 7.5 6.2"
        stroke={active ? '#111827' : '#9ca3af'}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}
