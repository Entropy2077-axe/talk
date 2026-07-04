import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { Avatar } from './Avatar'
import { excerptAround, highlightSegments, truncateName } from '../lib/search'
import { formatListTime } from '../lib/time'

interface SearchOverlayProps {
  onClose: () => void
}

export function SearchOverlay({ onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const messages = useLiveQuery(() => db.messages.toArray(), []) ?? []

  const q = query.trim()

  const matchedContacts = useMemo(() => {
    if (!q) return []
    const convByContact = new Map(conversations.map((c) => [c.contactId, c]))
    return contacts
      .filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
      .map((c) => ({ contact: c, conv: convByContact.get(c.id) }))
      .sort((a, b) => (b.conv?.updatedAt ?? 0) - (a.conv?.updatedAt ?? 0))
  }, [q, contacts, conversations])

  const matchedMessages = useMemo(() => {
    if (!q) return []
    const convById = new Map(conversations.map((c) => [c.id, c]))
    const contactById = new Map(contacts.map((c) => [c.id, c]))
    return messages
      .filter((m) => m.type === 'text' && m.content.toLowerCase().includes(q.toLowerCase()))
      .map((m) => {
        const conv = convById.get(m.conversationId)
        const contact = conv ? contactById.get(conv.contactId) : undefined
        return { message: m, contactName: contact?.name ?? '未知' }
      })
      .sort((a, b) => b.message.createdAt - a.message.createdAt)
      .slice(0, 50)
  }, [q, messages, conversations, contacts])

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-100 px-3">
        <div className="flex flex-1 items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="#9ca3af" strokeWidth="1.8" />
            <path d="M20 20l-4-4" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索联系人、聊天记录"
            className="w-full bg-transparent text-sm outline-none placeholder:text-gray-400"
          />
        </div>
        <button onClick={onClose} className="shrink-0 text-sm text-gray-500">
          取消
        </button>
      </div>

      {q && (
        <div className="flex-1 overflow-y-auto">
          <section>
            <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-gray-400">联系人</h3>
            {matchedContacts.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-400">没有找到匹配的联系人</p>
            ) : (
              matchedContacts.map(({ contact }) => (
                <button
                  key={contact.id}
                  onClick={() => {
                    onClose()
                    navigate(`/contact/${contact.id}`)
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left active:bg-gray-50"
                >
                  <Avatar avatar={contact.avatar} color={contact.avatarColor} size={38} />
                  <span className="text-[15px] text-gray-900">
                    {highlightSegments(contact.name, q).map((seg, i) => (
                      <span key={i} className={seg.matched ? 'text-[#aa3bff]' : ''}>
                        {seg.text}
                      </span>
                    ))}
                  </span>
                </button>
              ))
            )}
          </section>

          <section className="mt-2 border-t border-gray-100">
            <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-gray-400">聊天记录</h3>
            {matchedMessages.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-400">没有找到匹配的聊天记录</p>
            ) : (
              matchedMessages.map(({ message, contactName }) => (
                <button
                  key={message.id}
                  onClick={() => {
                    onClose()
                    navigate(`/chat/${message.conversationId}?highlight=${message.id}`)
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left active:bg-gray-50"
                >
                  <span className="flex-1 truncate text-sm text-gray-700">
                    {highlightSegments(excerptAround(message.content, q), q).map((seg, i) => (
                      <span key={i} className={seg.matched ? 'text-[#aa3bff]' : ''}>
                        {seg.text}
                      </span>
                    ))}
                  </span>
                  <span className="shrink-0 text-xs text-gray-400">
                    {truncateName(contactName)}
                  </span>
                  <span className="shrink-0 text-[11px] text-gray-300">
                    {formatListTime(message.createdAt)}
                  </span>
                </button>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  )
}
