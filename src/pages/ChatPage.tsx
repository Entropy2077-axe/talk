import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { MessageBubble } from '../components/MessageBubble'
import { useSettingsStore } from '../store/useSettingsStore'
import { useChatUiStore } from '../store/useChatUiStore'
import { DEFAULT_RUNTIME_STATE, sendMessage, useChatEngineStore } from '../lib/chatEngine'
import { displayName } from '../lib/contact'
import type { Message } from '../types'

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
  const contact = useLiveQuery(
    () => (conversation ? db.contacts.get(conversation.contactId) : undefined),
    [conversation],
  )
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

  const bottomRef = useRef<HTMLDivElement>(null)
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [flashId, setFlashId] = useState<string | null>(highlightId)

  // Registers this conversation as "currently open" so background replies
  // don't pop a notification for the chat the user is already looking at.
  useEffect(() => {
    if (!conversationId) return
    setActiveConversation(conversationId)
    return () => setActiveConversation(null)
  }, [conversationId, setActiveConversation])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, aiTyping])

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
    if (!text || !conversationId || !contact) return
    setInput('')
    await sendMessage(conversationId, contact, settings, stickers, text)
  }

  async function handleCommissionRespond(commissionId: string, accept: boolean) {
    if (!conversationId || !contact) return
    const commission = await db.commissions.get(commissionId)
    if (!commission || commission.status !== 'pending') return
    await db.commissions.update(commissionId, { status: accept ? 'accepted' : 'declined', respondedAt: Date.now() })
    if (accept) {
      await db.todos.add({
        id: uuid(),
        title: commission.title,
        note: commission.description,
        done: false,
        createdAt: Date.now(),
        source: 'commission',
        commissionId,
      })
    }
    await sendMessage(conversationId, contact, settings, stickers, accept ? `好 这个我接了` : `这个我接不了 抱歉`)
  }

  if (conversation === undefined || contact === undefined) return null
  if (conversation === null || contact === null) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-[#ededed]">
        <TopBar title="对话" showBack />
        <p className="px-4 py-10 text-center text-sm text-gray-400">会话不存在</p>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#ededed]">
      <TopBar
        title={displayName(contact)}
        showBack
        right={
          <button
            onClick={() => navigate(`/contact/${contact.id}`)}
            className="flex h-9 w-9 items-center justify-center text-gray-500"
            aria-label="联系人名片"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 11v5M12 8v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto pt-2">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            ref={(el) => {
              if (el) bubbleRefs.current.set(m.id, el)
            }}
            message={m}
            contactName={displayName(contact)}
            contactAvatar={contact.avatar}
            contactAvatarColor={contact.avatarColor}
            userAvatar={settings.userAvatar}
            stickerUrl={m.type === 'sticker' ? stickerByName.get(m.content) : undefined}
            highlighted={flashId === m.id}
            onLinkClick={() => setToast('小程序功能正在开发中')}
            onCommissionRespond={handleCommissionRespond}
          />
        ))}
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
        <div ref={bottomRef} />
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
    </div>
  )
}
