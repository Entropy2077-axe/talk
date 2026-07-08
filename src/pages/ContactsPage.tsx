import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { SearchOverlay } from '../components/SearchOverlay'
import { displayName } from '../lib/contact'
import { createStrawmanContact } from '../lib/strawman'
import { useSettingsStore } from '../store/useSettingsStore'

const EMPTY_ARRAY: never[] = []

export function ContactsPage() {
  const [searching, setSearching] = useState(false)
  const [creatingStrawman, setCreatingStrawman] = useState(false)
  const [strawmanError, setStrawmanError] = useState('')
  const [strawmanSourceId, setStrawmanSourceId] = useState<string | null>(null)
  const navigate = useNavigate()
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const contactsRaw = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const contacts = useMemo(
    () => [...contactsRaw].sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh')),
    [contactsRaw],
  )

  async function handleCreateStrawman(sourceId: string) {
    setStrawmanSourceId(sourceId)
    setStrawmanError('')
    try {
      const result = await createStrawmanContact(sourceId)
      setCreatingStrawman(false)
      navigate(`/contact/${result.id}`)
    } catch (err) {
      setStrawmanError(err instanceof Error ? err.message : String(err))
    } finally {
      setStrawmanSourceId(null)
    }
  }

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

        {adminModeEnabled && (
          <button
            onClick={() => {
              setStrawmanError('')
              setCreatingStrawman(true)
            }}
            disabled={contacts.length === 0}
            className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left active:bg-gray-50 disabled:opacity-40"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M8 7.5a4 4 0 1 1 8 0v.5a4 4 0 0 1-8 0v-.5Z" stroke="currentColor" strokeWidth="1.8" />
                <path d="M5 21a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M18 5.5h3M19.5 4v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] text-gray-900">创建稻草人</p>
              <p className="truncate text-xs text-gray-400">复制已有联系人的全部实验数据</p>
            </div>
          </button>
        )}

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

      {creatingStrawman && (
        <div className="absolute inset-0 z-30 flex items-end bg-black/30">
          <div className="max-h-[80%] w-full overflow-hidden rounded-t-2xl bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-gray-900">选择稻草人来源</h2>
                <p className="mt-0.5 text-xs text-gray-400">会复制联系人、记忆、会话和朋友圈等数据</p>
              </div>
              <button
                onClick={() => setCreatingStrawman(false)}
                className="rounded-full px-2 py-1 text-sm text-gray-400 active:bg-gray-50"
              >
                关闭
              </button>
            </div>
            {strawmanError && <p className="border-b border-red-100 px-4 py-2 text-xs text-red-500">{strawmanError}</p>}
            <div className="max-h-[calc(var(--app-height)*0.65)] overflow-y-auto">
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => handleCreateStrawman(contact.id)}
                  disabled={strawmanSourceId !== null}
                  className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left active:bg-gray-50 disabled:opacity-50"
                >
                  <Avatar avatar={contact.avatar} color={contact.avatarColor} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] text-gray-900">{displayName(contact)}</p>
                    <p className="truncate text-xs text-gray-400">
                      {strawmanSourceId === contact.id ? '正在复制...' : `${contact.name}-稻草人-xx`}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
