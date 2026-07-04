import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { SearchOverlay } from '../components/SearchOverlay'
import { displayName } from '../lib/contact'

export function ContactsPage() {
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const contacts = useMemo(
    () => [...contactsRaw].sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh')),
    [contactsRaw],
  )

  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar
        title="联系人"
        showSearch
        onSearchClick={() => setSearching(true)}
        right={
          <button
            onClick={() => navigate('/contact/new')}
            aria-label="添加联系人"
            className="flex h-9 w-9 items-center justify-center text-gray-700"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        }
      />

      <div className="flex-1">
        <button
          onClick={() => navigate('/contact/new')}
          className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left active:bg-gray-50"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#aa3bff]/10 text-[#aa3bff]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <span className="text-[15px] text-gray-900">添加联系人</span>
        </button>

        {contacts.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-gray-400">
            还没有联系人 点击上方"添加联系人"认识一个新朋友吧
          </p>
        ) : (
          contacts.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/contact/${c.id}`)}
              className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-2.5 text-left active:bg-gray-50"
            >
              <Avatar avatar={c.avatar} color={c.avatarColor} size={44} />
              <span className="text-[15px] text-gray-900">{displayName(c)}</span>
            </button>
          ))
        )}
      </div>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
