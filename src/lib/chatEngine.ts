import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import { extractJsonObject, parseAiResponse, typingDelayMs } from './aiProtocol'
import { buildSystemPrompt, AVAILABLE_LINK_APPS } from './prompt'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateMemory } from './memory'
import { describeCurrentTime, ageFromBirthday } from './time'
import { describeCurrentSchedule, describeUpcomingScheduleText, pruneExpiredOverrides } from './schedule'
import { knowledgeDigestText, processKnowledgeQueries } from './knowledgeBase'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { useChatUiStore } from '../store/useChatUiStore'
import {
  applyRelationshipDelta,
  crossedRelationshipMilestones,
  inferRelationshipDeltaFromTurn,
  relationshipStatsText,
  relationshipUnlocks,
  relationshipUnlocksText,
} from './relationship'
import type { AiBubble, AppSettings, Contact, Message, MessageType, ScheduleOverride, Sticker } from '../types'

/**
 * Per-conversation AI-turn state, deliberately kept in a module-level
 * Zustand store rather than component state. ChatPage used to own this in
 * local refs/useState, which meant navigating away unmounted the component
 * and its cleanup effect aborted the in-flight request and cleared all
 * pending bubble-reveal timers — the conversation would just stop mid-reply
 * the moment you left the screen. Living here, generation keeps running
 * (and messages keep landing in IndexedDB) no matter which page is mounted;
 * ChatPage just subscribes to this store for its conversationId when open.
 */
interface ConversationRuntimeState {
  aiTyping: boolean
  error: string
}

// Exported as a stable reference — selectors that fall back to this for a
// conversation with no state yet must never construct a fresh object
// literal on the fly (e.g. `s.states[id] ?? { aiTyping: false, error: '' }`),
// since a new reference every call trips React's useSyncExternalStore
// infinite-loop detection and crashes the page.
export const DEFAULT_RUNTIME_STATE: ConversationRuntimeState = { aiTyping: false, error: '' }

interface ChatEngineStore {
  states: Record<string, ConversationRuntimeState>
  patch: (conversationId: string, patch: Partial<ConversationRuntimeState>) => void
}

export const useChatEngineStore = create<ChatEngineStore>((set) => ({
  states: {},
  patch: (conversationId, patch) =>
    set((s) => ({
      states: {
        ...s.states,
        [conversationId]: { ...(s.states[conversationId] ?? DEFAULT_RUNTIME_STATE), ...patch },
      },
    })),
}))

export function getConversationRuntimeState(conversationId: string): ConversationRuntimeState {
  return useChatEngineStore.getState().states[conversationId] ?? DEFAULT_RUNTIME_STATE
}

// Bookkeeping that doesn't need to be reactive — plain module-level maps,
// keyed by conversationId, so they survive regardless of component mounts.
const streamByConversation = new Map<string, string>()
const timersByConversation = new Map<string, ReturnType<typeof setTimeout>[]>()
const abortByConversation = new Map<string, AbortController>()
const COMMISSION_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000

function clearPending(conversationId: string) {
  timersByConversation.get(conversationId)?.forEach(clearTimeout)
  timersByConversation.set(conversationId, [])
  abortByConversation.get(conversationId)?.abort()
}

export function formatStructuredHistoryEvent(
  message: Message,
  kind: MessageType,
  commissionById = new Map<string, { reward: number }>(),
): ChatMessage {
  const actor = message.role === 'assistant' ? 'contact' : 'user'
  const commission = kind === 'commission' && message.commission ? commissionById.get(message.commission.commissionId) : undefined
  const payload =
    kind === 'commission' && message.commission
      ? {
          kind,
          actor,
          title: message.content,
          reward: commission?.reward,
          commissionId: message.commission.commissionId,
          summary: `发布了委托: ${message.content}${commission ? `（报酬${commission.reward}）` : ''}`,
        }
      : kind === 'link' && message.link
        ? { kind, actor, label: message.link.label, app: message.link.app, data: message.link.data }
        : kind === 'gift' && message.gift
          ? { kind, actor, name: message.gift.name, icon: message.gift.icon }
          : kind === 'scheduleChange' && message.scheduleChange
            ? { kind, actor, summary: message.scheduleChange.summary, date: message.scheduleChange.date }
            : { kind, actor, content: message.content }

  return {
    role: 'system',
    content: `HISTORY_EVENT ${JSON.stringify(payload)}`,
  }
}

function parseAiTurnDebugPayload(raw: string, bubbles: AiBubble[], knowledgeQueries: string[]): unknown {
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenceMatch ? fenceMatch[1].trim() : trimmed
  try {
    return JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (extracted) {
      try {
        return JSON.parse(extracted)
      } catch {
        // fall through
      }
    }
  }
  return { raw, parsedBubbles: bubbles, knowledgeQueries }
}

export function buildUserProfileText(settings: AppSettings): string {
  const parts: string[] = [`昵称: ${settings.userNickname || '未设置'}`]
  if (settings.userGender) parts.push(`性别: ${settings.userGender}`)
  const age = ageFromBirthday(settings.userBirthday)
  if (age !== null) parts.push(`年龄: ${age}岁`)
  if (settings.userBio) parts.push(`简介: ${settings.userBio}`)
  return parts.join(' · ')
}

/** Sends a user message and kicks off the AI's reply — safe to call whether or not ChatPage is currently mounted for this conversation. */
export async function sendMessage(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  text: string,
): Promise<void> {
  if (!text.trim()) return
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置API Key 请先去"我-设置"里填写' })
    return
  }

  const streamId = uuid()
  streamByConversation.set(conversationId, streamId)
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { error: '' })

  const msg: Message = {
    id: uuid(),
    conversationId,
    role: 'user',
    type: 'text',
    content: text.trim(),
    createdAt: Date.now(),
  }
  await db.messages.add(msg)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  runAiTurn(conversationId, contact, settings, stickers, streamId, text.trim())
}

/**
 * Kicks off a reply from whatever's already in the conversation history,
 * without inserting a new user-role message first — for background actions
 * that write their own message directly (gifting an item from the
 * warehouse, completing a commission from the todo list) and then want a
 * real reply out of it instead of just leaving a message sitting there
 * until the user happens to reopen that chat.
 */
export async function triggerAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
): Promise<void> {
  const streamId = uuid()
  streamByConversation.set(conversationId, streamId)
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { error: '' })
  await runAiTurn(conversationId, contact, settings, stickers, streamId)
}

export async function maybeRemindOverdueCommissions(): Promise<void> {
  const now = Date.now()
  const commissions = await db.commissions.toArray()
  const overdue = commissions.find((c) => {
    if (c.status !== 'pending' && c.status !== 'accepted') return false
    const anchor = c.respondedAt ?? c.createdAt
    const lastReminder = c.lastReminderAt ?? 0
    return now - anchor >= COMMISSION_REMINDER_DELAY_MS && now - lastReminder >= COMMISSION_REMINDER_DELAY_MS
  })
  if (!overdue) return

  const [contact, conv] = await Promise.all([
    db.contacts.get(overdue.contactId),
    db.conversations.where('contactId').equals(overdue.contactId).first(),
  ])
  if (!contact || !conv) return

  const msg: Message = {
    id: uuid(),
    conversationId: conv.id,
    role: 'assistant',
    type: 'text',
    content:
      overdue.status === 'accepted'
        ? `那个「${overdue.title}」怎么样啦 有空跟我说下进度`
        : `之前那个「${overdue.title}」你还接吗 不方便的话也跟我说一声`,
    createdAt: now,
  }
  await db.messages.add(msg)
  await db.commissions.update(overdue.id, { lastReminderAt: now })
  await db.conversations.update(conv.id, { updatedAt: now })

  if (useChatUiStore.getState().activeConversationId !== conv.id) {
    useChatUiStore.getState().showNotification({
      id: uuid(),
      conversationId: conv.id,
      contactName: displayName(contact),
      contactAvatar: contact.avatar,
      contactAvatarColor: contact.avatarColor,
      preview: previewForMessage(msg),
    })
  }
}

async function runAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  triggeringUserText = '',
): Promise<void> {
  const engine = useChatEngineStore.getState()
  engine.patch(conversationId, { aiTyping: true, error: '' })
  console.log(`[chat] 开始生成回复 对方=${displayName(contact)} conversationId=${conversationId}`)
  try {
    const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')

    // Notable things that happened outside the chat itself (e.g. the user
    // liked this contact's moment) get mentioned once then cleared, rather
    // than sitting there forever or requiring a proactive-message system.
    const pendingEvents = contact.pendingEvents ?? []
    if (pendingEvents.length > 0) await db.contacts.update(contact.id, { pendingEvents: [] })

    const knowledgeEntries = await db.knowledgeEntries.toArray()
    const commissions = await db.commissions.toArray()
    const commissionById = new Map(commissions.map((c) => [c.id, c]))
    const contactNetworkText = await buildContactNetworkText(contact.id)

    const systemPrompt = buildSystemPrompt({
      stylePrompt: settings.globalSystemPrompt,
      persona: contact.systemPrompt,
      relationshipType: contact.relationshipType,
      relationshipStatsText: relationshipStatsText(contact.relationship),
      relationshipUnlocksText: relationshipUnlocksText(contact.relationship),
      contactNetworkText,
      memoryFacts: contact.memoryFacts,
      memoryStyle: contact.memoryStyle,
      stickerNames: stickers.map((s) => s.name),
      linkApps: AVAILABLE_LINK_APPS,
      currentTimeText: describeCurrentTime(new Date()),
      userProfileText: buildUserProfileText(settings),
      recentEventsText: pendingEvents.length > 0 ? pendingEvents.join('；') : undefined,
      upcomingPlansText: activeUpcomingPlansText(contact, new Date()) || undefined,
      currentScheduleText: describeCurrentSchedule(contact, new Date()) || undefined,
      upcomingScheduleText: describeUpcomingScheduleText(contact, new Date()) || undefined,
      worldviewText: settings.worldview || undefined,
      knowledgeDigestText: knowledgeDigestText(knowledgeEntries) || undefined,
    })
    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: systemPrompt },
      ...recentHistory.map((m): ChatMessage => {
        if (m.type === 'sticker') return formatStructuredHistoryEvent(m, 'sticker', commissionById)
        if (m.type === 'link') return formatStructuredHistoryEvent(m, 'link', commissionById)
        if (m.type === 'commission') return formatStructuredHistoryEvent(m, 'commission', commissionById)
        if (m.type === 'gift') return formatStructuredHistoryEvent(m, 'gift', commissionById)
        if (m.type === 'scheduleChange') return formatStructuredHistoryEvent(m, 'scheduleChange', commissionById)
        return { role: m.role, content: m.content }
      }),
    ])

    const controller = new AbortController()
    abortByConversation.set(conversationId, controller)
    const raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: chatMessages,
      signal: controller.signal,
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    const { bubbles, knowledgeQueries } = parseAiResponse(raw)
    console.log(`[chat] 收到回复(${raw.length}字) 解析出${bubbles.length}条气泡 对方=${displayName(contact)}`)
    if (bubbles.length === 0) {
      console.warn(`[chat] 本轮没有正常回复 对方=${displayName(contact)} 原始内容: ${raw.slice(0, 200)}`)
      engine.patch(conversationId, { error: '对方这次没有正常回复 可以再发一条试试', aiTyping: false })
      return
    }
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw,
      parsed: parseAiTurnDebugPayload(raw, bubbles, knowledgeQueries),
      knowledgeQueries,
      createdAt: Date.now(),
    })
    processKnowledgeQueries(knowledgeQueries, settings)
    revealBubbles(conversationId, contact, settings, bubbles, streamId, aiTurnId, triggeringUserText)
  } catch (err) {
    if (streamByConversation.get(conversationId) !== streamId) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[chat] 生成回复出错 对方=${displayName(contact)}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false })
  }
}

function revealBubbles(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  bubbles: AiBubble[],
  streamId: string,
  aiTurnId: string,
  triggeringUserText: string,
): void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let cumulative = 0
  bubbles.forEach((bubble, i) => {
    cumulative += typingDelayMs(bubble)
    const timer = setTimeout(async () => {
      if (streamByConversation.get(conversationId) !== streamId) return

      let commissionId: string | undefined
      if (bubble.type === 'commission') {
        commissionId = uuid()
        await db.commissions.add({
          id: commissionId,
          contactId: contact.id,
          title: bubble.title,
          description: bubble.description,
          reward: bubble.reward,
          status: 'pending',
          createdAt: Date.now(),
        })
      }

      if (bubble.type === 'scheduleChange') {
        // Re-fetch rather than reusing the `contact` this whole turn was
        // handed — that snapshot predates this write, and stashing a stale
        // scheduleOverrides array here would silently drop the exception
        // (same staleness bug fixed in proactiveChat.ts's pendingEvents write).
        const fresh = await db.contacts.get(contact.id)
        const pruned = pruneExpiredOverrides(fresh?.scheduleOverrides ?? [], new Date())
        const override: ScheduleOverride = {
          id: uuid(),
          date: bubble.date,
          startHour: bubble.startHour,
          endHour: bubble.endHour,
          phoneAccess: bubble.phoneAccess,
          location: bubble.location,
          activity: bubble.activity,
          summary: bubble.summary,
          createdAt: Date.now(),
        }
        await db.contacts.update(contact.id, { scheduleOverrides: [...pruned, override] })
      }

      let content: string
      if (bubble.type === 'text') content = bubble.content
      else if (bubble.type === 'sticker') content = bubble.name
      else if (bubble.type === 'commission') content = bubble.title
      else if (bubble.type === 'scheduleChange') content = bubble.summary
      else content = bubble.label

      const msg: Message = {
        id: uuid(),
        conversationId,
        role: 'assistant',
        type: bubble.type,
        content,
        link: bubble.type === 'link' ? { app: bubble.app, label: bubble.label, data: bubble.data } : undefined,
        commission: commissionId ? { commissionId } : undefined,
        scheduleChange:
          bubble.type === 'scheduleChange'
            ? {
                date: bubble.date,
                startHour: bubble.startHour,
                endHour: bubble.endHour,
                phoneAccess: bubble.phoneAccess,
                location: bubble.location,
                activity: bubble.activity,
                summary: bubble.summary,
              }
            : undefined,
        debugAiTurnId: aiTurnId,
        debugParsedBubble: bubble,
        createdAt: Date.now(),
      }
      await db.messages.add(msg)
      await db.conversations.update(conversationId, { updatedAt: Date.now() })

      // Only pop a notification if the user isn't already looking at this
      // exact conversation right now.
      if (useChatUiStore.getState().activeConversationId !== conversationId) {
        useChatUiStore.getState().showNotification({
          id: uuid(),
          conversationId,
          contactName: displayName(contact),
          contactAvatar: contact.avatar,
          contactAvatarColor: contact.avatarColor,
          preview: previewForMessage(msg),
        })
      }

      if (i === bubbles.length - 1) {
        updateRelationshipAfterTurn(contact.id, triggeringUserText, bubbles)
        useChatEngineStore.getState().patch(conversationId, { aiTyping: false })
        maybeUpdateMemory(contact.id, conversationId, settings)
      }
    }, cumulative)
    timers.push(timer)
  })
  timersByConversation.set(conversationId, timers)
}

async function buildContactNetworkText(contactId: string): Promise<string> {
  const [links, contacts] = await Promise.all([db.contactRelations.toArray(), db.contacts.toArray()])
  const contactById = new Map(contacts.map((c) => [c.id, c]))
  const lines = links
    .filter((l) => l.fromContactId === contactId || l.toContactId === contactId)
    .map((l) => {
      const otherId = l.fromContactId === contactId ? l.toContactId : l.fromContactId
      const other = contactById.get(otherId)
      if (!other) return ''
      return `- 和 ${displayName(other)}: ${l.label}`
    })
    .filter(Boolean)
  return lines.length > 0 ? lines.join('\n') : ''
}

async function updateRelationshipAfterTurn(contactId: string, userText: string, bubbles: AiBubble[]): Promise<void> {
  const contact = await db.contacts.get(contactId)
  if (!contact) return
  const delta = inferRelationshipDeltaFromTurn(userText, bubbles)
  const next = applyRelationshipDelta(contact.relationship, delta)
  if (JSON.stringify(next) === JSON.stringify(contact.relationship)) return
  await db.contacts.update(contactId, { relationship: next })
  const milestones = crossedRelationshipMilestones(contact.relationship, next)
  if (milestones.length > 0) {
    const unlocks = relationshipUnlocks(next)
    useChatUiStore
      .getState()
      .showRelationshipNotice(`关系变化：${milestones.join('、')}${unlocks.length > 0 ? ` · 解锁 ${unlocks[0].split('：')[0]}` : ''}`)
  }
}
