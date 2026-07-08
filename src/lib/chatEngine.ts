import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import { extractJsonObject, parseAiResponse, typingDelayMs } from './aiProtocol'
import { formatSpeechSamplesForScene, buildRawChatPrompt, buildJsonConversionPrompt } from './prompt'
import { isModuleEnabled } from '../features'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateMemory, recentMemoriesText } from './memory'
import { activeIntentPrompt, activeIntents, markIntentsUsed } from './intent'
import { describeCurrentTime, ageFromBirthday } from './time'
import { describeCurrentSchedule, describeUpcomingScheduleText, pruneExpiredOverrides } from './schedule'
import { processKnowledgeQueries } from './knowledgeBase'
import { evaluateInitialWarmth, relationshipLine } from './relationship'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { validatePrivateTurn, optimizePrivateTurn } from './responseQuality'
import { recentSocialEventsText } from './socialEvents'
import { useChatUiStore } from '../store/useChatUiStore'
import { enqueueSelfIterationTask } from './selfIteration'
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
/** How long a mood lasts before expiring back to neutral. */
// Mood expiry is now a user-configurable setting (see ProactiveSettingsPage → mood settings).
// The default is 30 min, stored in AppSettings.moodExpiryMs.
const streamByConversation = new Map<string, string>()
const timersByConversation = new Map<string, ReturnType<typeof setTimeout>[]>()
const abortByConversation = new Map<string, AbortController>()

function getActiveMood(contact: Contact, now: number): string | undefined {
  if (!contact.mood || !contact.mood.text) return undefined
  if (now > contact.mood.expiresAt) return undefined
  return contact.mood.text
}

function clearPending(conversationId: string) {
  timersByConversation.get(conversationId)?.forEach(clearTimeout)
  timersByConversation.set(conversationId, [])
  abortByConversation.get(conversationId)?.abort()
}

export function formatStructuredHistoryEvent(
  message: Message,
  kind: MessageType,
): ChatMessage {
  const actor = message.role === 'assistant' ? 'contact' : 'user'
  const attrs =
    kind === 'link' && message.link
      ? [
          ['type', kind],
          ['actor', actor],
          ['label', message.link.label],
          ['app', message.link.app],
          ['data', JSON.stringify(message.link.data ?? {})],
        ]
      : kind === 'gift' && message.gift
        ? [
            ['type', kind],
            ['actor', actor],
            ['name', message.gift.name],
            ['icon', message.gift.icon],
          ]
        : kind === 'scheduleChange' && message.scheduleChange
          ? [
              ['type', kind],
              ['actor', actor],
              ['summary', message.scheduleChange.summary],
              ['date', message.scheduleChange.date],
            ]
          : [
              ['type', kind],
              ['actor', actor],
              ['content', message.content],
            ]

  const content = `<<HISTORY_EVENT ${attrs
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`)
    .join(' ')}>>`

  return {
    role: message.role,
    content,
  }
}

function parseAiTurnDebugPayload(opts: {
  rawText: string
  jsonRaw: string
  finalRaw: string
  bubbles: AiBubble[]
  knowledgeQueries: string[]
  mood?: string
  thought?: string
  validator: { enabled: boolean; mode: AppSettings['validatorMode']; repaired: boolean; optimized: boolean; reason?: string }
  injectedIntents: ReturnType<typeof activeIntents>
}): unknown {
  const { finalRaw, jsonRaw, rawText, bubbles, knowledgeQueries, mood, thought, validator, injectedIntents } = opts
  const trimmed = finalRaw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenceMatch ? fenceMatch[1].trim() : trimmed
  let conversionParsed: unknown = null
  try {
    conversionParsed = JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (extracted) {
      try {
        conversionParsed = JSON.parse(extracted)
      } catch {
        // fall through
      }
    }
  }
  return {
    rawText,
    jsonRaw,
    finalRaw,
    conversionParsed,
    parsedBubbles: bubbles,
    validator,
    mood,
    thought,
    knowledgeQueries,
    injectedIntents,
    memoryUpdate: null,
  }
}

function formatRecentConversationForReview(messages: Message[], contact: Contact): string {
  return messages
    .slice(-10)
    .map((m) => {
      const speaker = m.role === 'user' ? 'User' : displayName(contact)
      if (m.type !== 'text') return `${speaker}: [${m.type}: ${m.content}]`
      return `${speaker}: ${m.content}`
    })
    .join('\n')
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
 * warehouse) and then want a
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

export async function regenerateAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  aiTurnId: string,
): Promise<void> {
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置 API Key，请先去“我 / 设置”里填写' })
    return
  }

  const streamId = uuid()
  streamByConversation.set(conversationId, streamId)
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { error: '' })

  const turnMessages = await db.messages
    .where('conversationId')
    .equals(conversationId)
    .filter((message) => message.debugAiTurnId === aiTurnId)
    .toArray()
  if (turnMessages.length > 0) await db.messages.bulkDelete(turnMessages.map((message) => message.id))
  await db.aiTurns.delete(aiTurnId)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  await runAiTurn(conversationId, contact, settings, stickers, streamId)
}

async function runAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  _triggeringUserText = '',
): Promise<void> {
  const engine = useChatEngineStore.getState()
  const now = Date.now()
  const activeMood = isModuleEnabled('mood') ? getActiveMood(contact, now) : undefined
  engine.patch(conversationId, { aiTyping: true, error: '' })
  console.log(`[chat] 开始生成回复 对方=${displayName(contact)} conversationId=${conversationId}`)
  try {
    const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')

    // Cold-start warmth evaluation: 好感度 is enabled but this contact
    // was created while the module was off → evaluate once from chat history.
    if (isModuleEnabled('relationship') && contact.warmth === undefined) {
      await evaluateInitialWarmth(contact, conversationId, settings)
      // Re-read the contact so the newly-set warmth is available below.
      const fresh = await db.contacts.get(contact.id)
      if (fresh) contact = fresh
    }

    // Notable things that happened outside the chat itself (e.g. the user
    // liked this contact's moment) get mentioned once then cleared, rather
    // than sitting there forever or requiring a proactive-message system.
    const pendingEvents = contact.pendingEvents ?? []
    if (pendingEvents.length > 0) await db.contacts.update(contact.id, { pendingEvents: [] })
    const socialEventsText = await recentSocialEventsText([contact.id], 4)
    const recentEventsText = [pendingEvents.join('；'), socialEventsText].filter(Boolean).join('\n')
    const injectedIntents = isModuleEnabled('intent') ? activeIntents(contact, now) : []
    const injectedIntentText = activeIntentPrompt(injectedIntents)

    // ---- Step 1: build context sections (no JSON protocol) ----
    const scheduleText = describeUpcomingScheduleText(contact, new Date())
    const recentMemories = await recentMemoriesText(contact.id)
    const contextSections = buildRawChatPrompt({
      name: contact.name,
      persona: contact.systemPrompt,
      stylePrompt: settings.globalSystemPrompt,
      selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
      selfIterationContactText: isModuleEnabled('selfIteration') ? contact.selfIterationPrompt : undefined,
      relationshipBase: isModuleEnabled('relationship') ? (contact.relationshipBase || '朋友') : '朋友',
      personalityTrait: isModuleEnabled('personalityTraits') ? contact.personalityTrait : undefined,
      worldviewText: isModuleEnabled('worldview') ? (settings.worldview || undefined) : undefined,
      latestUserText: _triggeringUserText,
      recentContext: [
        `【你和对方的关系】${relationshipLine(
          isModuleEnabled('relationship') ? (contact.relationshipBase || '朋友') : '朋友',
          isModuleEnabled('relationship') ? (contact.relationshipDynamic || '') : '',
          isModuleEnabled('relationship') ? (contact.warmth ?? 0) : 0,
        )}`,
        `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`,
        `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`,
        `【当前情境】现在: ${describeCurrentTime(new Date())}。对方: ${buildUserProfileText(settings)}。${activeMood ? `你的心情: ${activeMood}。` : ''}【日程】${describeCurrentSchedule(contact, new Date()) ? `\n当前: ${describeCurrentSchedule(contact, new Date())}` : '\n当前: 暂无安排'}${scheduleText ? `\n接下来:\n${scheduleText}` : '\n接下来: 暂无安排'}${activeUpcomingPlansText(contact, new Date()) ? `\n约定: ${activeUpcomingPlansText(contact, new Date())}` : ''}${recentEventsText ? `\n最近: ${recentEventsText}` : ''}`,
        formatSpeechSamplesForScene(contact.speechSamples, 'private', 3)
          ? `【说话样例】\n${formatSpeechSamplesForScene(contact.speechSamples, 'private', 3)}`
          : '',
      ].filter(Boolean).join('\n\n'),
      activeIntentText: injectedIntentText,
      stickerNames: stickers.map((s) => s.name),
      mbti: contact.mbti || undefined,
      recentMemoriesText: recentMemories || undefined,
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: contextSections },
      ...recentHistory.map((m): ChatMessage => {
        if (m.type === 'sticker') return formatStructuredHistoryEvent(m, 'sticker')
        if (m.type === 'link') return formatStructuredHistoryEvent(m, 'link')
        if (m.type === 'gift') return formatStructuredHistoryEvent(m, 'gift')
        if (m.type === 'scheduleChange') return formatStructuredHistoryEvent(m, 'scheduleChange')
        return { role: m.role, content: m.content }
      }),
    ])

    const controller = new AbortController()
    abortByConversation.set(conversationId, controller)

    // ---- Step 1: main model generates raw text (no JSON) ----
    const rawText = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: chatMessages,
      signal: controller.signal,
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    console.log(`[chat] 主模型回复(${rawText.length}字): ${rawText.slice(0, 100)}...`)

    // ---- Step 2: utility model converts raw text to JSON ----
    const conversionPrompt = buildJsonConversionPrompt(rawText)
    const jsonRaw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel,
      messages: [
        { role: 'system', content: conversionPrompt },
      ],
      jsonMode: true,
      signal: controller.signal,
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    console.log(`[chat] 多功能模型转换JSON: ${jsonRaw.slice(0, 200)}`)
    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parseAiResponse(finalRaw)
    const validatorDebug = {
      enabled: isModuleEnabled('validator'),
      mode: settings.validatorMode,
      repaired: false,
      optimized: false,
      reason: undefined as string | undefined,
    }

    // Validator module — two modes, both skipped when the module is off.
    if (validatorDebug.enabled && bubbles.length > 0) {
      if (settings.validatorMode === 'quality') {
        // Mode 1: quality check via utility model, rewrite on failure.
        const checked = await validatePrivateTurn({
          settings,
          contact,
          latestUserText: _triggeringUserText,
          recentConversationText: formatRecentConversationForReview(recentHistory, contact),
          raw: finalRaw,
          bubbles,
          signal: controller.signal,
        })
        if (streamByConversation.get(conversationId) !== streamId) return
        if (checked.repaired) {
          console.warn(`[chat] 校验器重写 对方=${displayName(contact)} 原因=${checked.reason ?? 'unknown'}`)
          validatorDebug.repaired = true
          validatorDebug.reason = checked.reason
          finalRaw = checked.raw
          ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parseAiResponse(finalRaw))
        }
      } else {
        // Mode 2: force-optimize — re-feed to main model for improvement.
        const optimized = await optimizePrivateTurn({
          settings,
          contact,
          latestUserText: _triggeringUserText,
          raw: finalRaw,
          bubbles,
          signal: controller.signal,
        })
        if (streamByConversation.get(conversationId) !== streamId) return
        if (optimized) {
          console.log(`[chat] 校验器优化 对方=${displayName(contact)}`)
          validatorDebug.optimized = true
          finalRaw = optimized
          ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parseAiResponse(finalRaw))
        }
      }
    }
    console.log(`[chat] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 mood=${turnMood || '无'} thought=${turnThought ? '有(' + turnThought.length + '字)' : '无'} 对方=${displayName(contact)}`)
    if (bubbles.length === 0) {
      console.warn(`[chat] 本轮没有正常回复 对方=${displayName(contact)} JSON内容: ${jsonRaw.slice(0, 200)}`)
      engine.patch(conversationId, { error: '对方这次没有正常回复 可以再发一条试试', aiTyping: false })
      return
    }
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw: finalRaw,
      parsed: parseAiTurnDebugPayload({
        rawText,
        jsonRaw,
        finalRaw,
        bubbles,
        knowledgeQueries,
        mood: turnMood,
        thought: turnThought,
        validator: validatorDebug,
        injectedIntents,
      }),
      knowledgeQueries,
      createdAt: Date.now(),
    })
    if (isModuleEnabled('knowledgeBase')) processKnowledgeQueries(knowledgeQueries, settings)
    revealBubbles(
      conversationId,
      contact,
      settings,
      bubbles,
      streamId,
      aiTurnId,
      _triggeringUserText,
      turnMood,
      turnThought,
      finalRaw,
      injectedIntents.map((intent) => intent.id),
    )
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
  _triggeringUserText: string,
  turnMood?: string,
  turnThought?: string,
  finalRaw?: string,
  injectedIntentIds: string[] = [],
): void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let cumulative = 0
  bubbles.forEach((bubble, i) => {
    cumulative += typingDelayMs(bubble)
    const timer = setTimeout(async () => {
      if (streamByConversation.get(conversationId) !== streamId) return

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
      else if (bubble.type === 'scheduleChange') content = bubble.summary
      else content = bubble.label

      const msg: Message = {
        id: uuid(),
        conversationId,
        role: 'assistant',
        type: bubble.type,
        content,
        link: bubble.type === 'link' ? { app: bubble.app, label: bubble.label, data: bubble.data } : undefined,
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
        debugRawAiResponse: i === bubbles.length - 1 ? (finalRaw || '') : undefined,
        thought: turnThought && i === bubbles.length - 1 ? turnThought : undefined,
        createdAt: Date.now(),
      }
      if (turnThought) {
        console.log(`[chat] 想法已存入消息: ${turnThought}`)
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
        if (injectedIntentIds.length > 0) {
          await markIntentsUsed(contact.id, injectedIntentIds)
        }
        const memoryUpdate = await maybeUpdateMemory(contact.id, conversationId, settings)
        if (memoryUpdate) {
          const turn = await db.aiTurns.get(aiTurnId)
          const parsed =
            turn?.parsed && typeof turn.parsed === 'object'
              ? { ...(turn.parsed as Record<string, unknown>), memoryUpdate }
              : { memoryUpdate }
          await db.aiTurns.update(aiTurnId, { parsed })
        }
        if (turnMood) {
          await db.contacts.update(contact.id, {
            mood: { text: turnMood, expiresAt: Date.now() + settings.moodExpiryMs },
          })
        }
        if (_triggeringUserText && isModuleEnabled('selfIteration')) {
          enqueueSelfIterationTask({
            conversationId,
            contactId: contact.id,
            contactName: contact.name,
            latestUserText: _triggeringUserText,
            latestAssistantText: bubbles
              .map((b) => (b.type === 'text' ? b.content : `[${b.type}] ${'name' in b ? b.name : 'label' in b ? b.label : b.summary}`))
              .join('\n'),
          })
        }
      }
    }, cumulative)
    timers.push(timer)
  })
  timersByConversation.set(conversationId, timers)
}


