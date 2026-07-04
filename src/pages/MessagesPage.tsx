import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { SearchOverlay } from '../components/SearchOverlay'
import { ActionSheet } from '../components/ActionSheet'
import { useLongPress } from '../hooks/useLongPress'
import { formatListTime } from '../lib/time'
import { displayName } from '../lib/contact'
import type { Message } from '../types'

export function MessagesPage() {
  const [searching, setSearching] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const navigate = useNavigate()

  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? []
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? []
  const messages = useLiveQuery(() => db.messages.toArray(), []) ?? []

  const rows = useMemo(() => {
    const contactById = new Map(contacts.map((c) => [c.id, c]))
    const lastMsgByConv = new Map<string, Message>()
    for (const m of messages) {
      const prev = lastMsgByConv.get(m.conversationId)
      if (!prev || m.createdAt > prev.createdAt) lastMsgByConv.set(m.conversationId, m)
    }
    return conversations
      .map((conv) => ({
        conv,
        contact: contactById.get(conv.contactId),
        lastMessage: lastMsgByConv.get(conv.id),
      }))
      .filter((r) => r.contact)
      .sort((a, b) => {
        if (a.conv.pinned !== b.conv.pinned) return a.conv.pinned ? -1 : 1
        return b.conv.updatedAt - a.conv.updatedAt
      })
  }, [conversations, contacts, messages])

  function lastMessagePreview(m?: Message) {
    if (!m) return '暂无消息'
    if (m.type === 'sticker') return '[表情]'
    if (m.type === 'link') return `[链接] ${m.content}`
    return m.content
  }

  const menuConv = rows.find((r) => r.conv.id === menuFor)?.conv

  return (
    <div className="relative flex min-h-full flex-col">
      <TopBar title="消息" showSearch onSearchClick={() => setSearching(true)} />
      <div className="flex-1">
        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-gray-400">
            还没有会话 去"联系人"页添加一个联系人开始聊天吧
          </p>
        )}
        {rows.map(({ conv, contact, lastMessage }) => (
          <ConversationRow
            key={conv.id}
            pinned={conv.pinned}
            avatar={contact!.avatar}
            avatarColor={contact!.avatarColor}
            name={displayName(contact!)}
            preview={lastMessagePreview(lastMessage)}
            time={formatListTime(conv.updatedAt)}
            onClick={() => navigate(`/chat/${conv.id}`)}
            onLongPress={() => setMenuFor(conv.id)}
          />
        ))}
      </div>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}

      {menuConv && (
        <ActionSheet
          onClose={() => setMenuFor(null)}
          options={[
            {
              label: menuConv.pinned ? '取消置顶' : '置顶会话',
              onSelect: () => db.conversations.update(menuConv.id, { pinned: !menuConv.pinned }),
            },
          ]}
        />
      )}
    </div>
  )
}

function ConversationRow(props: {
  pinned: boolean
  avatar: string
  avatarColor: string
  name: string
  preview: string
  time: string
  onClick: () => void
  onLongPress: () => void
}) {
  const longPress = useLongPress(props.onLongPress)
  return (
    <div
      {...longPress}
      onClick={props.onClick}
      className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 select-none ${
        props.pinned ? 'bg-gray-100' : 'bg-white active:bg-gray-50'
      }`}
    >
      <Avatar avatar={props.avatar} color={props.avatarColor} size={48} />
      <div className="min-w-0 flex-1 border-b border-gray-100 pb-2.5 pt-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-medium text-gray-900">{props.name}</span>
          <span className="shrink-0 text-[11px] text-gray-400">{props.time}</span>
        </div>
        <p className="mt-0.5 truncate text-[13px] text-gray-400">{props.preview}</p>
      </div>
    </div>
  )
}
