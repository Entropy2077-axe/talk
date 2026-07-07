import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { MessageBubble } from '../components/MessageBubble'
import { SearchOverlay } from '../components/SearchOverlay'
import { ActionSheet } from '../components/ActionSheet'
import { useSettingsStore } from '../store/useSettingsStore'
import { useChatUiStore } from '../store/useChatUiStore'
import { DEFAULT_RUNTIME_STATE, regenerateAiTurn, sendMessage, useChatEngineStore } from '../lib/chatEngine'
import { regenerateGroupAiTurn, sendGroupMessage } from '../lib/groupChatEngine'
import { displayName } from '../lib/contact'
import { applyMessageFeedback } from '../lib/messageFeedback'
import { buildGroupStatusLine, buildPrivateStatusLine } from '../lib/contactStatus'
import type { Contact, Message } from '../types'

const EMPTY_MESSAGES: Message[] = []

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
    ) ?? EMPTY_MESSAGES
  const stickers = useLiveQuery(() => db.stickers.toArray(), []) ?? []
  const stickerByName = new Map(stickers.map((s) => [s.name, s.dataUrl]))
  const statusLine =
    useLiveQuery(
      () => {
        if (isGroupConv) return groupMembers.length > 0 ? buildGroupStatusLine(groupMembers) : Promise.resolve('')
        return contact ? buildPrivateStatusLine(contact) : Promise.resolve('')
      },
      [isGroupConv, contact, groupMembers],
    ) ?? ''

  // The AI-turn state (typing indicator / error) lives in a module-level
  // store, not local state — it keeps running in the background even when
  // this page unmounts, so it must be read reactively from there instead.
  const { aiTyping, error } = useChatEngineStore(
    (s) => s.states[conversationId ?? ''] ?? DEFAULT_RUNTIME_STATE,
  )

  const [input, setInput] = useState('')
  const [toast, setToast] = useState('')
  const [searching, setSearching] = useState(false)
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([])
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [flashId, setFlashId] = useState<string | null>(highlightId)
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const replyToMessage = replyToId ? messageById.get(replyToId) : undefined
  const menuMessage = menuMessageId ? messageById.get(menuMessageId) : undefined

  const mentionQuery = useMemo(() => {
    if (!isGroupConv) return null
    const match = input.match(/(?:^|\s)@([^\s@]*)$/)
    return match ? match[1].toLowerCase() : null
  }, [input, isGroupConv])

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    return groupMembers
      .filter((member) => displayName(member).toLowerCase().includes(mentionQuery))
      .slice(0, 6)
  }, [groupMembers, mentionQuery])

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
      const typedMentionIds = groupMembers
        .filter((member) => text.includes(`@${displayName(member)}`))
        .map((member) => member.id)
      const mentionIds = Array.from(new Set([...selectedMentionIds, ...typedMentionIds]))
      setInput('')
      setSelectedMentionIds([])
      setReplyToId(null)
      await sendGroupMessage(conversationId, group, groupMembers, settings, stickers, text, mentionIds, replyToId ?? undefined)
      return
    }
    if (!contact) return
    setInput('')
    await sendMessage(conversationId, contact, settings, stickers, text)
  }

  function insertMention(member: Contact) {
    const name = displayName(member)
    setInput((prev) => {
      const next = prev.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
        const prefix = match.startsWith(' ') ? ' ' : ''
        return `${prefix}@${name} `
      })
      return next === prev ? `${prev}@${name} ` : next
    })
    setSelectedMentionIds((prev) => Array.from(new Set([...prev, member.id])))
  }

  function labelForMessage(message: Message): string {
    if (message.role === 'user') return settings.userNickname || '我'
    const speaker =
      isGroupConv && message.speakerContactId ? memberById.get(message.speakerContactId) : isGroupConv ? undefined : contact!
    return speaker ? displayName(speaker) : isGroupConv ? group!.name : displayName(contact!)
  }

  function previewForReply(message: Message): string {
    const content = message.type === 'sticker' ? `[表情: ${message.content}]` : message.content
    return `${labelForMessage(message)}: ${content.slice(0, 42)}${content.length > 42 ? '...' : ''}`
  }

  function feedbackContactFor(message: Message): Contact | undefined {
    if (message.role !== 'assistant') return undefined
    if (isGroupConv) return message.speakerContactId ? memberById.get(message.speakerContactId) : undefined
    return contact ?? undefined
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard?.writeText(message.content)
      setToast('已复制')
    } catch {
      setToast('复制失败')
    }
  }

  async function deleteMessage(message: Message) {
    await db.messages.delete(message.id)
    if (replyToId === message.id) setReplyToId(null)
  }

  async function sendFeedback(message: Message, kind: 'unlike' | 'avoid') {
    if (!conversationId) return
    const target = feedbackContactFor(message)
    if (!target) return
    await applyMessageFeedback({ contact: target, message, kind, conversationId })
    setToast(kind === 'unlike' ? '已记住：这不像TA' : '已记住：以后避开这种说法')
  }

  async function regenerateTurn(message: Message) {
    if (!conversationId || !message.debugAiTurnId) return
    if (isGroupConv) {
      if (!group) return
      await regenerateGroupAiTurn(conversationId, group, groupMembers, settings, stickers, message.debugAiTurnId)
    } else {
      if (!contact) return
      await regenerateAiTurn(conversationId, contact, settings, stickers, message.debugAiTurnId)
    }
    setToast('已重新生成这一轮')
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
      {statusLine && (
        <button
          onClick={() => navigate(headerInfoPath)}
          className="shrink-0 border-b border-gray-100 bg-white px-4 py-1.5 text-center text-[11px] text-gray-400"
        >
          <span className="block truncate">{statusLine}</span>
        </button>
      )}

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
              mentionNames={(m.mentions ?? []).map((id) => memberById.get(id)).filter((c): c is Contact => !!c).map(displayName)}
              replyPreview={m.replyToMessageId ? previewForReply(messageById.get(m.replyToMessageId) ?? m) : undefined}
              highlighted={flashId === m.id}
              adminMode={!!settings.adminModeEnabled}
              onReply={isGroupConv ? () => setReplyToId(m.id) : undefined}
              onLongPress={() => setMenuMessageId(m.id)}
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

      <div className="shrink-0 border-t border-gray-200 bg-white p-2 pb-[env(safe-area-inset-bottom)]">
        {replyToMessage && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs text-gray-500">
            <span className="min-w-0 flex-1 truncate">回复 {previewForReply(replyToMessage)}</span>
            <button onClick={() => setReplyToId(null)} className="shrink-0 text-gray-400">
              取消
            </button>
          </div>
        )}
        {mentionCandidates.length > 0 && (
          <div className="mb-2 max-h-44 overflow-y-auto rounded-xl border border-gray-100 bg-white shadow-sm">
            {mentionCandidates.map((member) => (
              <button
                key={member.id}
                onClick={() => insertMention(member)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left active:bg-gray-50"
              >
                <span className="text-sm text-gray-800">@{displayName(member)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
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
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
      {menuMessage && (
        <ActionSheet
          onClose={() => setMenuMessageId(null)}
          options={[
            { label: '复制', onSelect: () => void copyMessage(menuMessage) },
            ...(feedbackContactFor(menuMessage)
              ? [
                  ...(menuMessage.debugAiTurnId
                    ? [{ label: '重新生成这一轮', onSelect: () => void regenerateTurn(menuMessage) }]
                    : []),
                  { label: '这不像TA', onSelect: () => void sendFeedback(menuMessage, 'unlike') },
                  { label: '以后别这样说', onSelect: () => void sendFeedback(menuMessage, 'avoid') },
                ]
              : []),
            ...(isGroupConv ? [{ label: '回复', onSelect: () => setReplyToId(menuMessage.id) }] : []),
            { label: '删除这条消息', onSelect: () => void deleteMessage(menuMessage), danger: true },
          ]}
        />
      )}
    </div>
  )
}
