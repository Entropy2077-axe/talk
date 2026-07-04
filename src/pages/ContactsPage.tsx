import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { SearchOverlay } from '../components/SearchOverlay'

export function ContactsPage() {
  const [searching, setSearching] = useState(false)
  const navigate = useNavigate()
  const contacts = useLiveQuery(() => db.contacts.orderBy('name').toArray(), []) ?? []

  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar
        title="联系人"
        showSearch
        onSearchClick={() => setSearching(true)}
        right={
          <button
            onClick={() => navigate('/contact/new')}
            aria-label="新建AI联系人"
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
          <span className="text-[15px] text-gray-900">新建AI</span>
        </button>

        {contacts.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-gray-400">
            还没有联系人 点击上方"新建AI"创建一个吧
          </p>
        ) : (
          contacts.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/contact/${c.id}`)}
              className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-2.5 text-left active:bg-gray-50"
            >
              <Avatar avatar={c.avatar} color={c.avatarColor} size={44} />
              <span className="text-[15px] text-gray-900">{c.name}</span>
            </button>
          ))
        )}
      </div>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
