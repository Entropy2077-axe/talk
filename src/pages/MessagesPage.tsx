import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { Avatar } from '../components/Avatar'
import { UnreadBadge } from '../components/UnreadBadge'
import { SearchOverlay } from '../components/SearchOverlay'
import { ActionSheet } from '../components/ActionSheet'
import { useLongPress } from '../hooks/useLongPress'
import { formatListTime } from '../lib/time'
import { displayName } from '../lib/contact'
import { previewForMessage } from '../lib/messagePreview'
import { useLastMessageByConversation, useUnreadByConversation } from '../lib/unread'
import { useSettingsStore } from '../store/useSettingsStore'
import { isAiTestId } from '../lib/aiTestIsolation'
import { ensureContactConversations } from '../lib/contactConversations'

const EMPTY_ARRAY: never[] = []

export function MessagesPage() {
  const [searching, setSearching] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const navigate = useNavigate()
  const locationEnabled = useSettingsStore((state) => state.enabledModules.includes('location'))

  const conversations = useLiveQuery(() => db.conversations.toArray(), []) ?? EMPTY_ARRAY
  const contacts = useLiveQuery(() => db.contacts.toArray(), []) ?? EMPTY_ARRAY
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? EMPTY_ARRAY
  const locations = useLiveQuery(() => db.locations.toArray(), []) ?? EMPTY_ARRAY
  const unreadByConversation = useUnreadByConversation()
  const lastMessageByConversation = useLastMessageByConversation()

  // The startup repair handles persisted data. Re-run after a live world
  // switch too, because this tab can stay mounted while Dexie replaces the
  // active world's contact rows.
  useEffect(() => { void ensureContactConversations() }, [contacts, conversations])

  const rows = useMemo(() => {
    const contactById = new Map(contacts.map((c) => [c.id, c]))
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const locationById = new Map(locations.map((location) => [location.id, location]))
    return conversations
      .filter((conversation) => !isAiTestId(conversation.id) && !isAiTestId(conversation.contactId) && !isAiTestId(conversation.groupId))
      .filter((conversation) => locationEnabled || !conversation.systemPinned)
      .map((conv) => {
        const lastMessage = lastMessageByConversation.get(conv.id)
        const unread = unreadByConversation.get(conv.id) ?? 0
        if (conv.groupId) {
          const group = groupById.get(conv.groupId)
          if (!group) return null
          const speaker =
            lastMessage?.role === 'assistant' && lastMessage.speakerContactId
              ? contactById.get(lastMessage.speakerContactId)
              : undefined
          return {
            conv,
            avatar: group.avatar,
            avatarColor: group.avatarColor,
            name: group.kind === 'location' ? `${group.name} · ${locationById.get(group.locationId ?? '')?.name ?? '未选择地点'}` : group.name,
            preview: previewForMessage(lastMessage, speaker ? displayName(speaker) : undefined),
            unread,
          }
        }
        const contact = conv.contactId ? contactById.get(conv.contactId) : undefined
        if (!contact) return null
        return {
          conv,
          avatar: contact.avatar,
          avatarColor: contact.avatarColor,
          name: displayName(contact),
          preview: previewForMessage(lastMessage),
          unread,
        }
      })
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => {
        if (!!a.conv.systemPinned !== !!b.conv.systemPinned) return a.conv.systemPinned ? -1 : 1
        if (a.conv.pinned !== b.conv.pinned) return a.conv.pinned ? -1 : 1
        return b.conv.updatedAt - a.conv.updatedAt
      })
  }, [conversations, contacts, groups, locations, locationEnabled, lastMessageByConversation, unreadByConversation])

  const openConversation = useCallback((id: string) => navigate(`/chat/${id}`), [navigate])
  const openConversationMenu = useCallback((id: string) => setMenuFor(id), [])

  const menuConv = rows.find((r) => r.conv.id === menuFor)?.conv

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar
        title="消息"
        showSearch
        onSearchClick={() => setSearching(true)}
        right={
          <button
            onClick={() => setShowAddMenu(true)}
            aria-label="添加"
            className="flex h-9 w-9 items-center justify-center text-gray-700"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <div className="ui-empty-state"><p className="text-sm text-[var(--ui-text-2)]">还没有会话</p><p className="mt-1 text-xs">认识联系人后，对话会集中显示在这里。</p><button type="button" onClick={() => navigate('/contacts')} className="ui-primary-action mt-4 px-4 py-2 text-sm">前往联系人</button></div>
        )}
        {rows.map(({ conv, avatar, avatarColor, name, preview, unread }) => (
          <ConversationRow
            key={conv.id}
            conversationId={conv.id}
            pinned={conv.pinned}
            avatar={avatar}
            avatarColor={avatarColor}
            name={name}
            preview={preview}
            unread={unread}
            time={formatListTime(conv.updatedAt)}
            onClick={openConversation}
            onLongPress={openConversationMenu}
          />
        ))}
      </div>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}

      {showAddMenu && (
        <ActionSheet
          onClose={() => setShowAddMenu(false)}
          options={[
            { label: '添加联系人', onSelect: () => navigate('/contact/new') },
            { label: '发起群聊', onSelect: () => navigate('/group/new') },
          ]}
        />
      )}

      {menuConv && !menuConv.systemPinned && (
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

const ConversationRow = memo(function ConversationRow(props: {
  conversationId: string
  pinned: boolean
  avatar: string
  avatarColor: string
  name: string
  preview: string
  unread: number
  time: string
  onClick: (id: string) => void
  onLongPress: (id: string) => void
}) {
  const longPress = useLongPress(() => props.onLongPress(props.conversationId))
  return (
    <div
      {...longPress}
      onClick={() => props.onClick(props.conversationId)}
      className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 select-none ${
        props.pinned ? 'bg-[var(--ui-surface-2)]' : 'bg-[var(--ui-surface)] active:bg-gray-50'
      }`}
    >
      <div className="relative shrink-0">
        <Avatar avatar={props.avatar} color={props.avatarColor} size={48} />
        <UnreadBadge count={props.unread} className="absolute -top-1 -right-1" />
      </div>
      <div className="min-w-0 flex-1 border-b border-gray-100 pb-2.5 pt-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="ui-font-display truncate text-[15px] font-medium text-gray-900">{props.name}</span>
          <span className="shrink-0 text-[11px] text-gray-400">{props.time}</span>
        </div>
        <p className="mt-0.5 truncate text-[13px] text-gray-400">{props.preview}</p>
      </div>
    </div>
  )
})
