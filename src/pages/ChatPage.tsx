import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { MessageBubble } from '../components/MessageBubble'
import { SearchOverlay } from '../components/SearchOverlay'
import { useSettingsStore } from '../store/useSettingsStore'
import { useChatUiStore } from '../store/useChatUiStore'
import { DEFAULT_RUNTIME_STATE, sendMessage, useChatEngineStore } from '../lib/chatEngine'
import { sendGroupMessage } from '../lib/groupChatEngine'
import { displayName } from '../lib/contact'
import type { Contact, Message } from '../types'

export function ChatPage() {
  const { conversationId } = useParams()
  const [searchParams] = useSearchParams()
  const highlightId = searchParams.get('highlight')
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const setActiveConversation = useChatUiStore((s) => s.setActiveConversation)

  const conversation = useLiveQuery(
    () => (conversationId ? db.conversations.get(conversationId) : undefined),
    [conversationId],
  )
  const isGroupConv = !!conversation?.groupId
  const contact = useLiveQuery(
    () => (conversation && !conversation.groupId ? db.contacts.get(conversation.contactId!) : undefined),
    [conversation],
  )
  const group = useLiveQuery(
    () => (conversation?.groupId ? db.groups.get(conversation.groupId) : undefined),
    [conversation],
  )
  const groupMembersRaw = useLiveQuery(
    () => (group ? db.contacts.bulkGet(group.memberContactIds) : []),
    [group],
  )
  const groupMembers = useMemo(() => (groupMembersRaw ?? []).filter((c): c is Contact => !!c), [groupMembersRaw])
  const memberById = useMemo(() => new Map(groupMembers.map((c) => [c.id, c])), [groupMembers])

  const messages =
    useLiveQuery(
      () =>
        conversationId
          ? db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
          : Promise.resolve([] as Message[]),
      [conversationId],
    ) ?? []
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const stickerByName = new Map(stickers.map((s) => [s.name, s.dataUrl]))

  // The AI-turn state (typing indicator / error) lives in a module-level
  // store, not local state — it keeps running in the background even when
  // this page unmounts, so it must be read reactively from there instead.
  const { aiTyping, error } = useChatEngineStore(
    (s) => s.states[conversationId ?? ''] ?? DEFAULT_RUNTIME_STATE,
  )

  const [input, setInput] = useState('')
  const [toast, setToast] = useState('')
  const [searching, setSearching] = useState(false)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [flashId, setFlashId] = useState<string | null>(highlightId)

  // Registers this conversation as "currently open" so background replies
  // don't pop a notification for the chat the user is already looking at.
  useEffect(() => {
    if (!conversationId) return
    setActiveConversation(conversationId)
    return () => setActiveConversation(null)
  }, [conversationId, setActiveConversation])

  // Marks everything as read whenever this chat is open — runs on mount
  // (clears existing unread) and again each time a new message streams in
  // while the user is still looking at it (keeps it cleared in real time).
  useEffect(() => {
    if (!conversationId || messages.length === 0) return
    db.conversations.update(conversationId, { lastReadAt: Date.now() })
  }, [conversationId, messages.length])

  // useLayoutEffect (not useEffect) so the jump-to-bottom happens before the
  // browser paints — otherwise opening a long conversation briefly flashes
  // the middle/top of the history before snapping to the bottom. `contact`
  // and `group` are in the deps deliberately: `messages` resolves from its
  // own independent useLiveQuery and can settle *before* contact/group does,
  // and the scroll container only actually mounts (guards passed) once
  // contact/group resolves too — without these in the deps, that final
  // unlocking render doesn't re-fire the effect (messages.length already
  // stopped changing by then) and the ref never gets scrolled at all.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversationId, messages.length, aiTyping, contact, group])

  useEffect(() => {
    if (!highlightId || messages.length === 0) return
    const el = bubbleRefs.current.get(highlightId)
    el?.scrollIntoView({ block: 'center' })
    const t = setTimeout(() => setFlashId(null), 2000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, messages.length])

  async function handleSend() {
    const text = input.trim()
    if (!text || !conversationId) return
    if (isGroupConv) {
      if (!group) return
      setInput('')
      await sendGroupMessage(conversationId, group, groupMembers, settings, stickers, text)
      return
    }
    if (!contact) return
    setInput('')
    await sendMessage(conversationId, contact, settings, stickers, text)
  }

  if (conversation === undefined) return null
  if (conversation === null) {
    return (
      <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
        <TopBar title="对话" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
      </div>
    )
  }
  if (isGroupConv) {
    if (group === undefined) return null
    if (group === null) {
      return (
        <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
          <TopBar title="群聊" showBack />
          <p className="px-4 py-10 text-center text-sm text-gray-400">该群聊已被解散</p>
        </div>
      )
    }
  } else {
    if (contact === undefined) return null
    if (contact === null) {
      return (
        <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
          <TopBar title="对话" showBack />
          <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
        </div>
      )
    }
  }

  const headerTitle = isGroupConv ? group!.name : displayName(contact!)
  const headerInfoPath = isGroupConv ? `/group/${group!.id}` : `/contact/${contact!.id}`
  const chatBackgroundStyle =
    settings.chatBackground && settings.chatBackground.startsWith('data:')
      ? { backgroundImage: `url(${settings.chatBackground})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : settings.chatBackground
        ? { backgroundColor: settings.chatBackground }
        : undefined

  return (
    <div className="relative flex h-[var(--app-height)] flex-col overflow-hidden bg-[#ededed]">
      <TopBar
        title={headerTitle}
        showBack
        showSearch
        onSearchClick={() => setSearching(true)}
        right={
          <button
            onClick={() => navigate(headerInfoPath)}
            className="flex h-9 w-9 items-center justify-center text-gray-500"
            aria-label={isGroupConv ? '群聊信息' : '联系人名片'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 11v5M12 8v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        }
      />

      <div ref={scrollContainerRef} data-testid="chat-scroll" className="flex-1 overflow-y-auto pt-2" style={chatBackgroundStyle}>
        {messages.map((m) => {
          const speaker =
            isGroupConv && m.role === 'assistant' && m.speakerContactId ? memberById.get(m.speakerContactId) : undefined
          const bubbleName = isGroupConv ? (speaker ? displayName(speaker) : group!.name) : displayName(contact!)
          const bubbleAvatar = isGroupConv ? (speaker ? speaker.avatar : group!.avatar) : contact!.avatar
          const bubbleAvatarColor = isGroupConv ? (speaker ? speaker.avatarColor : group!.avatarColor) : contact!.avatarColor
          return (
            <MessageBubble
              key={m.id}
              ref={(el) => {
                if (el) bubbleRefs.current.set(m.id, el)
              }}
              message={m}
              contactName={bubbleName}
              contactAvatar={bubbleAvatar}
              contactAvatarColor={bubbleAvatarColor}
              userAvatar={settings.userAvatar}
              stickerUrl={m.type === 'sticker' ? stickerByName.get(m.content) : undefined}
              highlighted={flashId === m.id}
              adminMode={!!settings.adminModeEnabled}
              onLinkClick={() => setToast('小程序功能正在开发中')}
            />
          )
        })}
        {aiTyping && (
          <div className="flex items-center gap-2 px-3 py-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl" />
            <div className="flex gap-1 rounded-2xl bg-white px-4 py-3">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
            </div>
          </div>
        )}
      </div>

      {error && <p className="bg-red-50 px-4 py-1.5 text-xs text-red-500">{error}</p>}
      {toast && (
        <p className="bg-gray-100 px-4 py-1.5 text-center text-xs text-gray-500" onAnimationEnd={() => setToast('')}>
          {toast}
        </p>
      )}

      <div className="flex shrink-0 items-end gap-2 border-t border-gray-200 bg-white p-2 pb-[env(safe-area-inset-bottom)]">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={aiTyping ? '对方正在输入 你可以直接插话打断' : '发消息…'}
          rows={1}
          className="max-h-24 flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-[14.5px] outline-none"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="shrink-0 rounded-xl bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          发送
        </button>
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  )
}
