import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { TopBar } from '../components/TopBar'
import { MessageBubble } from '../components/MessageBubble'
import { useSettingsStore } from '../store/useSettingsStore'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from '../lib/deepseek'
import { parseAiResponse, typingDelayMs } from '../lib/aiProtocol'
import { buildSystemPrompt, AVAILABLE_LINK_APPS } from '../lib/prompt'
import { CONTEXT_WINDOW_SIZE, maybeUpdateMemory } from '../lib/memory'
import { displayName } from '../lib/contact'
import { describeCurrentTime, ageFromBirthday } from '../lib/time'
import { locationLabel } from '../lib/locations'
import { buildScheduleContextText, resolveExpectedLocation, upcomingTasks } from '../lib/schedule'
import type { AiBubble, Message, ScheduleTask } from '../types'

export function ChatPage() {
  const { conversationId } = useParams()
  const [searchParams] = useSearchParams()
  const highlightId = searchParams.get('highlight')
  const navigate = useNavigate()
  const settings = useSettingsStore()

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
  const stickerByName = useMemo(() => new Map(stickers.map((s) => [s.name, s.dataUrl])), [stickers])
  const locations = useLiveQuery(() => db.locations.toArray(), []) ?? []
  const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations])
  const tasks =
    useLiveQuery(
      () =>
        contact ? db.tasks.where('contactId').equals(contact.id).toArray() : Promise.resolve([] as ScheduleTask[]),
      [contact],
    ) ?? []

  const [input, setInput] = useState('')
  const [aiTyping, setAiTyping] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const streamRef = useRef<string | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [flashId, setFlashId] = useState<string | null>(highlightId)

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

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout)
      abortRef.current?.abort()
    }
  }, [])

  function clearPending() {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
    abortRef.current?.abort()
  }

  function buildUserProfileText(): string {
    const parts: string[] = [`昵称: ${settings.userNickname || '未设置'}`]
    if (settings.userGender) parts.push(`性别: ${settings.userGender}`)
    const age = ageFromBirthday(settings.userBirthday)
    if (age !== null) parts.push(`年龄: ${age}岁`)
    if (settings.userBio) parts.push(`简介: ${settings.userBio}`)
    const userLoc = locationById.get(settings.userLocationId)
    if (userLoc) parts.push(`对方现在所在的位置: ${locationLabel(userLoc)}`)
    return parts.join(' · ')
  }

  async function runAiTurn(streamId: string) {
    if (!conversationId || !contact) return
    setAiTyping(true)
    setError('')
    try {
      const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')

      const now = new Date()
      const expected = resolveExpectedLocation(contact.dailySchedule, tasks, now)
      const scheduleContextText = buildScheduleContextText({
        expected,
        expectedLocationLabel: expected ? locationLabel(locationById.get(expected.locationId)) : '',
        currentLocationLabel: locationLabel(locationById.get(contact.currentLocationId)),
        upcoming: upcomingTasks(tasks, now, 3).map((t) => ({
          text: `${t.date} ${t.startTime}-${t.endTime} 在${locationLabel(locationById.get(t.locationId))} ${t.label}`,
        })),
      })

      const systemPrompt = buildSystemPrompt({
        stylePrompt: settings.globalSystemPrompt,
        persona: contact.systemPrompt,
        memoryFacts: contact.memoryFacts,
        memoryStyle: contact.memoryStyle,
        stickerNames: stickers.map((s) => s.name),
        linkApps: AVAILABLE_LINK_APPS,
        locationOptions: locations.map((l) => ({ id: l.id, label: locationLabel(l) })),
        currentTimeText: describeCurrentTime(now),
        userProfileText: buildUserProfileText(),
        scheduleContextText,
      })
      // Only the most recent messages go verbatim into the request — older
      // context is represented purely through the memory summary above, so
      // token usage stays bounded no matter how long the conversation gets.
      const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
      // Each AI turn is stored as several separate assistant bubbles, so the
      // raw mapping below produces runs of consecutive "assistant" messages
      // with no interleaved "user" turn — coalesce them back into one
      // message per real turn (see coalesceConsecutiveRoles for why this
      // matters: it visibly degraded reply quality from the 2nd turn on).
      const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
        { role: 'system', content: systemPrompt },
        ...recentHistory.map((m): ChatMessage => {
          if (m.type === 'sticker') return { role: m.role, content: `[发了一个表情: ${m.content}]` }
          if (m.type === 'link') return { role: m.role, content: `[分享了一个链接: ${m.content}]` }
          if (m.type === 'location') return { role: m.role, content: `[更新了位置: ${m.content}]` }
          if (m.type === 'schedule_task') return { role: m.role, content: `[约定了安排: ${m.content}]` }
          return { role: m.role, content: m.content }
        }),
      ])

      const controller = new AbortController()
      abortRef.current = controller
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: chatMessages,
        signal: controller.signal,
      })

      if (streamRef.current !== streamId) return
      const bubbles = parseAiResponse(raw)
      if (bubbles.length === 0) {
        setError('对方这次没有正常回复 可以再发一条试试')
        setAiTyping(false)
        return
      }
      revealBubbles(bubbles, streamId)
    } catch (err) {
      if (streamRef.current !== streamId) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
      setAiTyping(false)
    }
  }

  function revealBubbles(bubbles: AiBubble[], streamId: string) {
    if (bubbles.length === 0) {
      setAiTyping(false)
      return
    }
    let cumulative = 0
    bubbles.forEach((bubble, i) => {
      cumulative += typingDelayMs(bubble)
      const timer = setTimeout(async () => {
        if (streamRef.current !== streamId || !conversationId || !contact) return

        let content = ''
        if (bubble.type === 'text') content = bubble.content
        else if (bubble.type === 'sticker') content = bubble.name
        else content = bubble.label

        const msg: Message = {
          id: uuid(),
          conversationId,
          role: 'assistant',
          type: bubble.type,
          content,
          link: bubble.type === 'link' ? { app: bubble.app, label: bubble.label, data: bubble.data } : undefined,
          location: bubble.type === 'location' ? { locationId: bubble.locationId } : undefined,
          scheduleTask:
            bubble.type === 'schedule_task'
              ? {
                  date: bubble.date,
                  startTime: bubble.startTime,
                  endTime: bubble.endTime,
                  locationId: bubble.locationId,
                }
              : undefined,
          createdAt: Date.now(),
        }
        await db.messages.add(msg)
        await db.conversations.update(conversationId, { updatedAt: Date.now() })

        if (bubble.type === 'location') {
          await db.contacts.update(contact.id, { currentLocationId: bubble.locationId })
        } else if (bubble.type === 'schedule_task') {
          await db.tasks.add({
            id: uuid(),
            contactId: contact.id,
            date: bubble.date,
            startTime: bubble.startTime,
            endTime: bubble.endTime,
            locationId: bubble.locationId,
            label: bubble.label,
            createdAt: Date.now(),
            source: 'ai',
          })
        }

        if (i === bubbles.length - 1) {
          setAiTyping(false)
          maybeUpdateMemory(contact.id, conversationId, settings)
        }
      }, cumulative)
      timersRef.current.push(timer)
    })
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || !conversationId) return
    if (!settings.apiKey) {
      setError('还没有配置API Key 请先去"我-设置"里填写')
      return
    }

    const streamId = uuid()
    streamRef.current = streamId
    clearPending()
    setInput('')
    setError('')

    const msg: Message = {
      id: uuid(),
      conversationId,
      role: 'user',
      type: 'text',
      content: text,
      createdAt: Date.now(),
    }
    await db.messages.add(msg)
    await db.conversations.update(conversationId, { updatedAt: Date.now() })

    runAiTurn(streamId)
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
            locationById={locationById}
            highlighted={flashId === m.id}
            onLinkClick={() => setToast('小程序功能正在开发中')}
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
