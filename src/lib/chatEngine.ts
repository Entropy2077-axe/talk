import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import { parseAiResponse, typingDelayMs } from './aiProtocol'
import { buildSystemPrompt, AVAILABLE_LINK_APPS } from './prompt'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateMemory } from './memory'
import { describeCurrentTime, ageFromBirthday } from './time'
import { describeCurrentSchedule, describeUpcomingScheduleText, pruneExpiredOverrides } from './schedule'
import { knowledgeDigestText, processKnowledgeQueries } from './knowledgeBase'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { useChatUiStore } from '../store/useChatUiStore'
import type { AiBubble, AppSettings, Contact, Message, ScheduleOverride, Sticker } from '../types'

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

function clearPending(conversationId: string) {
  timersByConversation.get(conversationId)?.forEach(clearTimeout)
  timersByConversation.set(conversationId, [])
  abortByConversation.get(conversationId)?.abort()
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

  runAiTurn(conversationId, contact, settings, stickers, streamId)
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

async function runAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
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

    const systemPrompt = buildSystemPrompt({
      stylePrompt: settings.globalSystemPrompt,
      persona: contact.systemPrompt,
      relationshipType: contact.relationshipType,
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
        if (m.type === 'sticker') return { role: m.role, content: `[发了一个表情: ${m.content}]` }
        if (m.type === 'link') return { role: m.role, content: `[分享了一个链接: ${m.content}]` }
        if (m.type === 'commission') return { role: m.role, content: `[发布了委托: ${m.content}]` }
        if (m.type === 'gift') return { role: m.role, content: `[送出了礼物: ${m.content}]` }
        if (m.type === 'scheduleChange') return { role: m.role, content: `[达成新的日程约定: ${m.content}]` }
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
    processKnowledgeQueries(knowledgeQueries, settings)
    revealBubbles(conversationId, contact, settings, bubbles, streamId)
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
        useChatEngineStore.getState().patch(conversationId, { aiTyping: false })
        maybeUpdateMemory(contact.id, conversationId, settings)
      }
    }, cumulative)
    timers.push(timer)
  })
  timersByConversation.set(conversationId, timers)
}
