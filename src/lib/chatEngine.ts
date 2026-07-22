import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import {
  extractJsonObject,
  parseAiResponse,
  parseRawPrivateDraft,
  rawPrivateDraftNeedsUtility,
  serializePrivateTurn,
  typingDelayMs,
} from './aiProtocol'
import { formatSpeechSamplesForScene, buildRawChatPrompt, buildJsonConversionPrompt, customPersonalityTraitsLine } from './prompt'
import { retrieveWorldbookTrace } from './worldbook'
import { isModuleEnabled } from '../features'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateMemory, recentMemoriesText, socialMemoriesText } from './memory'
import { activeIntentPrompt, activeIntents, markIntentsUsed } from './intent'
import { describeCurrentTime, ageFromBirthday } from './time'
import { describeCurrentSchedule, describeUpcomingScheduleText, pruneExpiredOverrides } from './schedule'
import { resolveKnowledgeQueries } from './knowledgeBase'
import { evaluateInitialWarmth, relationshipLine } from './relationship'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { reviewTurnLogic } from './turnLogicReviewer'
import { recentSocialEventsText } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { useChatUiStore } from '../store/useChatUiStore'
import { enqueueSelfIterationTask } from './selfIteration'
import { USER_WALLET_ID, balanceOf, reserveRedPacket, transferFunds } from './finance'
import { searchPexelsPhoto } from './photoSearch'
import { generateRemoteImage, searchRemoteStickers, trackRemoteStickerSend, type RemoteStickerResult } from './remoteMedia'
import { isImageProviderReady, isStickerProviderReady } from './mediaProviders'
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
  typingLabel?: string
}

// Exported as a stable reference — selectors that fall back to this for a
// conversation with no state yet must never construct a fresh object
// literal on the fly (e.g. `s.states[id] ?? { aiTyping: false, error: '' }`),
// since a new reference every call trips React's useSyncExternalStore
// infinite-loop detection and crashes the page.
export const DEFAULT_RUNTIME_STATE: ConversationRuntimeState = { aiTyping: false, error: '', typingLabel: undefined }

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
      : message.finance && ['transfer','redPacket','loanRequest','loanResult','repayment'].includes(kind)
        ? [['type', kind], ['actor', actor], ['amount', message.finance.amount], ['note', message.finance.note ?? ''], ['loanId', message.finance.loanId ?? ''], ['status', message.finance.status ?? '']]
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
  mainPrompt: string
  conversionPrompt: string
  rawText: string
  jsonRaw: string
  finalRaw: string
  bubbles: AiBubble[]
  knowledgeQueries: string[]
  mood?: string
  thought?: string
  qualityCheck: { enabled: boolean; repaired: boolean; reason?: string; detectedInvalid?: boolean }
  injectedIntents: ReturnType<typeof activeIntents>
  promptTrace?: import('../types').PromptTrace
}): unknown {
  const { mainPrompt, conversionPrompt, finalRaw, jsonRaw, rawText, bubbles, knowledgeQueries, mood, thought, qualityCheck, injectedIntents, promptTrace } = opts
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
    mainPrompt,
    conversionPrompt,
    rawText,
    jsonRaw,
    finalRaw,
    conversionParsed,
    parsedBubbles: bubbles,
    qualityCheck,
    mood,
    thought,
    knowledgeQueries,
    injectedIntents,
    memoryUpdate: null,
    promptTrace,
  }
}

/** Admin-only safe stop: cancels network work and unrevealed bubbles for one conversation. */
export function stopAiTurn(conversationId: string): void {
  streamByConversation.set(conversationId, uuid())
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '已由管理员停止本轮生成' })
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
  if (isModuleEnabled('career') && settings.userOccupation) parts.push(`职业: ${settings.userOccupation} 月薪: ${settings.userMonthlySalary}`)
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
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: displayName(contact) })

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
  proactiveContext = '',
): Promise<void> {
  const streamId = uuid()
  streamByConversation.set(conversationId, streamId)
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: displayName(contact) })
  await runAiTurn(conversationId, contact, settings, stickers, streamId, '', proactiveContext)
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
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: displayName(contact) })

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
  proactiveContext = '',
): Promise<void> {
  const engine = useChatEngineStore.getState()
  const turnStartedAt = performance.now()
  const now = Date.now()
  const activeMood = getActiveMood(contact, now)
  engine.patch(conversationId, { aiTyping: true, error: '', typingLabel: displayName(contact) })
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
    const financeContext = isModuleEnabled('career')
      ? `\n【经济状况】你的可用余额：${await balanceOf(contact.id)}；对方可用余额：${await balanceOf(USER_WALLET_ID)}。未结清借款：${(await db.loans.filter(l => l.status === 'active' && (l.lenderId === contact.id || l.borrowerId === contact.id)).toArray()).map(l => `${l.borrowerId === contact.id ? '你欠对方' : '对方欠你'}${l.outstanding}`).join('；') || '无'}。所有金钱动作必须量力而行，不得凭空造钱。`
      : ''
    const socialMemories = await socialMemoriesText(contact.id)
    const sharedOriginalContext = await recentSharedOriginalContext([contact.id], settings.userNickname, {
      maxMessages: 50,
      maxChars: 8_000,
      excludeConversationId: conversationId,
    })
    const lifeEventText = isModuleEnabled('lifeSimulation')
      ? (await db.lifeEvents.where('contactId').equals(contact.id).reverse().sortBy('occurredAt')).slice(0, 4).map((event) => event.summary).join('；')
      : ''
    const worldbookTrace = isModuleEnabled('worldview') ? await retrieveWorldbookTrace([
      _triggeringUserText, proactiveContext, contact.name, contact.systemPrompt, contact.memoryFacts,
      history.slice(-8).map((m) => m.content).join(' '),
    ].filter(Boolean).join('\n')) : { text: '', matches: [] }
    const worldbookText = worldbookTrace.text
    const relationshipText = `【你和对方的关系】${relationshipLine(
      isModuleEnabled('relationship') ? (contact.relationshipBase || '朋友') : '朋友',
      isModuleEnabled('relationship') ? (contact.relationshipDynamic || '') : '',
      isModuleEnabled('relationship') ? (contact.warmth ?? 0) : 0,
    )}`
    const userMemoryText = `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`
    const habitText = `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`
    const situationText = `【当前情境】现在: ${describeCurrentTime(new Date())}。对方: ${buildUserProfileText(settings)}。${activeMood ? `你的心情: ${activeMood}。` : ''}【日程】${describeCurrentSchedule(contact, new Date()) ? `\n当前: ${describeCurrentSchedule(contact, new Date())}` : '\n当前: 暂无安排'}${scheduleText ? `\n接下来:\n${scheduleText}` : '\n接下来: 暂无安排'}${activeUpcomingPlansText(contact, new Date()) ? `\n约定: ${activeUpcomingPlansText(contact, new Date())}` : ''}${recentEventsText ? `\n最近: ${recentEventsText}` : ''}`
    const contextSections = buildRawChatPrompt({
      name: contact.name,
      persona: `${contact.systemPrompt}${customPersonalityTraitsLine(contact.customPersonalityTraits, contact.warmth ?? 0)}${isModuleEnabled('career') && contact.occupation ? `\n当前职业：${contact.occupation}，现实月薪：${contact.monthlySalary ?? 0}。工作会真实影响你的作息和日常话题。` : ''}${financeContext}`,
      personaConstraints: contact.personaConstraints,
      personaProfile: contact.personaProfile,
      stylePrompt: settings.globalSystemPrompt,
      selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
      selfIterationContactText: isModuleEnabled('selfIteration') ? contact.selfIterationPrompt : undefined,
      relationshipBase: isModuleEnabled('relationship') ? (contact.relationshipBase || '朋友') : '朋友',
      personalityTrait: isModuleEnabled('personalityTraits') ? contact.personalityTrait : undefined,
      personalityWarmth: isModuleEnabled('relationship') ? (contact.warmth ?? 0) : undefined,
      worldviewText: worldbookText || undefined,
      latestUserText: _triggeringUserText,
      recentContext: [
        relationshipText,
        userMemoryText,
        habitText,
        situationText,
        lifeEventText ? `【近期生活】${lifeEventText}` : '',
        proactiveContext,
      ].filter(Boolean).join('\n\n'),
      activeIntentText: injectedIntentText,
      stickerNames: stickers.map((s) => s.name),
      remoteStickerSearchEnabled: isStickerProviderReady(settings),
      imageGenerationEnabled: isImageProviderReady(settings),
      imageSearchEnabled: !!settings.pexelsApiKey,
      mbti: contact.mbti || undefined,
      recentMemoriesText: recentMemories || undefined,
      speechSamplesText: formatSpeechSamplesForScene(contact.speechSamples, 'private', 3) || undefined,
      sharedHistory: contact.sharedHistory,
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const controller = new AbortController()
    abortByConversation.set(conversationId, controller)
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: [contextSections, socialMemories, sharedOriginalContext].filter(Boolean).join('\n\n') },
      ...recentHistory.map((m): ChatMessage => {
        if (m.type === 'sticker') return formatStructuredHistoryEvent(m, 'sticker')
        if (m.type === 'link') return formatStructuredHistoryEvent(m, 'link')
        if (m.type === 'gift') return formatStructuredHistoryEvent(m, 'gift')
        if (m.type === 'scheduleChange') return formatStructuredHistoryEvent(m, 'scheduleChange')
        if (['transfer','redPacket','loanRequest','loanResult','repayment'].includes(m.type)) return formatStructuredHistoryEvent(m, m.type)
        return { role: m.role, content: m.content }
      }),
    ])
    console.info(`[chat-perf] context-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)}`)

    // ---- Step 1: main model generates raw text (no JSON) ----
    let rawText = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: chatMessages,
      signal: controller.signal,
      purpose: proactiveContext ? 'proactive' : 'chat',
      automatic: !!proactiveContext,
      thinking: 'disabled',
      temperature: 0.9,
      maxTokens: proactiveContext ? 700 : 800,
      trace: { turnId: streamId, stage: 'first_chat', conversationId },
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    console.log(`[chat] 主模型回复(${rawText.length}字): ${rawText.slice(0, 100)}...`)

    // ---- Step 2: parse ordinary drafts locally; use the utility model only
    // when the main model did not follow the explicit line protocol. ----
    console.info(`[chat-perf] model-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)}`)
    const localTurn = parseRawPrivateDraft(rawText, activeMood)
    let conversionPrompt = '本轮使用本地草稿解析，无额外模型调用。'
    let jsonRaw = serializePrivateTurn(localTurn)
    let parsedTurn = localTurn
    if (rawPrivateDraftNeedsUtility(rawText, localTurn)) {
      conversionPrompt = buildJsonConversionPrompt(rawText)
      jsonRaw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.utilityModel,
        messages: [{ role: 'system', content: conversionPrompt }],
        jsonMode: true,
        signal: controller.signal,
        purpose: proactiveContext ? 'proactive' : 'chat',
        automatic: !!proactiveContext,
        thinking: 'disabled',
        temperature: 0.1,
        maxTokens: 900,
        trace: { turnId: streamId, stage: 'other', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      const converted = parseAiResponse(jsonRaw)
      if (converted.bubbles.length > 0) parsedTurn = converted
      else jsonRaw = serializePrivateTurn(localTurn)
      console.log(`[chat] 草稿格式不完整，已用多功能模型转换JSON: ${jsonRaw.slice(0, 200)}`)
    } else {
      console.log(`[chat] 本地解析完成，跳过多功能模型转换`)
    }
    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parsedTurn
    const initiallyRequestedKnowledge = [...knowledgeQueries]
    const qualityCheckDebug = {
      enabled: true,
      repaired: false,
      reason: undefined as string | undefined,
      detectedInvalid: false,
    }

    const runLogicReview = (stage: 'first_quality' | 'second_quality') => reviewTurnLogic({
      settings,
      latestUserText: _triggeringUserText,
      draftText: rawText,
      personaFacts: [
        `角色=${displayName(contact)}`,
        `人设=${contact.systemPrompt.slice(0, 1400)}`,
        contact.personaConstraints ? `硬约束=${contact.personaConstraints.slice(0, 700)}` : '',
        contact.personalityTrait ? `人格特质=${contact.personalityTrait}` : '',
        contact.sharedHistory ? `与用户共同过往（关系硬锚点）=${contact.sharedHistory.slice(0, 900)}` : '',
        worldbookText ? `本轮命中世界书=${worldbookText.slice(0, 1000)}` : '',
        sharedOriginalContext ? `相关跨场景事实=${sharedOriginalContext.slice(-1000)}` : '',
      ].filter(Boolean).join('\n'),
      recentContext: formatRecentConversationForReview(recentHistory.slice(-4), contact),
      signal: controller.signal,
      trace: { turnId: streamId, stage, conversationId },
    })
    let logicReview = bubbles.length > 0 ? await runLogicReview('first_quality') : undefined
    if (streamByConversation.get(conversationId) !== streamId) return
    if (logicReview && !logicReview.valid) {
      qualityCheckDebug.detectedInvalid = true
      qualityCheckDebug.reason = logicReview.reason
      console.warn(`[chat] 逻辑自检要求主模型重写 对方=${displayName(contact)} 原因=${logicReview.reason}`)
      rawText = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: coalesceConsecutiveRoles([
          ...chatMessages,
          { role: 'assistant', content: rawText },
          { role: 'user', content: `上一版回复存在客观逻辑错误：${logicReview.reason}\n请依据原始上下文重写完整回复。仍只输出规定的角色纯文本格式，不要解释错误，不要输出JSON。` },
        ]),
        signal: controller.signal,
        purpose: proactiveContext ? 'proactive' : 'chat',
        automatic: !!proactiveContext,
        thinking: 'disabled',
        maxTokens: proactiveContext ? 700 : 800,
        temperature: 0.75,
        trace: { turnId: streamId, stage: 'second_chat', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      const rewrittenLocal = parseRawPrivateDraft(rawText, activeMood)
      parsedTurn = rewrittenLocal
      jsonRaw = serializePrivateTurn(rewrittenLocal)
      if (rawPrivateDraftNeedsUtility(rawText, rewrittenLocal)) {
        conversionPrompt = buildJsonConversionPrompt(rawText)
        jsonRaw = await chatCompletion({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.utilityModel,
          messages: [{ role: 'system', content: conversionPrompt }],
          jsonMode: true,
          signal: controller.signal,
          purpose: proactiveContext ? 'proactive' : 'chat',
          automatic: !!proactiveContext,
          thinking: 'disabled',
          temperature: 0.1,
          maxTokens: 900,
          trace: { turnId: streamId, stage: 'other', conversationId },
        })
        const converted = parseAiResponse(jsonRaw)
        if (converted.bubbles.length > 0) parsedTurn = converted
      }
      finalRaw = jsonRaw
      ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parsedTurn)
      qualityCheckDebug.repaired = true
      logicReview = bubbles.length > 0 ? await runLogicReview('second_quality') : undefined
      if (logicReview && !logicReview.valid) {
        throw new Error(`主模型重写后仍未通过逻辑自检：${logicReview.reason || '未知原因'}`)
      }
    }
    console.info(`[chat-perf] review-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)} repaired=${qualityCheckDebug.repaired ? 'yes' : 'no'}`)
    knowledgeQueries = Array.from(new Set([...initiallyRequestedKnowledge, ...knowledgeQueries])).slice(0, 2)
    if (isModuleEnabled('knowledgeBase') && knowledgeQueries.length > 0) {
      const knowledge = await resolveKnowledgeQueries(knowledgeQueries, settings)
      if (knowledge.text) {
        const review = qualityCheckDebug.repaired || qualityCheckDebug.detectedInvalid
          ? `\n【上一版审查未通过】${qualityCheckDebug.reason || '逻辑或角色一致性有问题'}。重新回答时必须同时修正这个问题。`
          : ''
        const enrichedMessages = chatMessages.map((message, index) => index === 0
          ? { ...message, content: `${message.content}\n\n【针对陌生词汇的搜索结果】\n${knowledge.text}${review}\n你刚才对陌生词汇自然表示了疑问。现在根据可靠搜索结果重新回答用户，语气要自然，不要写成搜索报告，也不要提审查流程。` }
          : message)
        rawText = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, messages: enrichedMessages, signal: controller.signal, purpose: proactiveContext ? 'proactive' : 'chat', automatic: !!proactiveContext, thinking: 'disabled', temperature: 0.9, maxTokens: proactiveContext ? 700 : 800, trace: { turnId: streamId, stage: 'second_chat', conversationId } })
        const enrichedLocalTurn = parseRawPrivateDraft(rawText, turnMood || activeMood)
        if (rawPrivateDraftNeedsUtility(rawText, enrichedLocalTurn)) {
          conversionPrompt = buildJsonConversionPrompt(rawText)
          jsonRaw = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.utilityModel, messages: [{ role: 'system', content: conversionPrompt }], jsonMode: true, signal: controller.signal, purpose: proactiveContext ? 'proactive' : 'chat', automatic: !!proactiveContext, thinking: 'disabled', temperature: 0.1, maxTokens: 900, trace: { turnId: streamId, stage: 'other', conversationId } })
          finalRaw = jsonRaw
          ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parseAiResponse(finalRaw))
        } else {
          conversionPrompt = '联网补全后的回复使用本地草稿解析，无额外模型调用。'
          jsonRaw = serializePrivateTurn(enrichedLocalTurn)
          finalRaw = jsonRaw
          ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = enrichedLocalTurn)
        }
      }
    }
    console.log(`[chat] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 mood=${turnMood || '无'} thought=${turnThought ? '有(' + turnThought.length + '字)' : '无'} 对方=${displayName(contact)}`)
    if (bubbles.length === 0) {
      console.warn(`[chat] 本轮没有正常回复 对方=${displayName(contact)} JSON内容: ${jsonRaw.slice(0, 200)}`)
      engine.patch(conversationId, { error: proactiveContext ? '' : '对方这次没有正常回复 可以再发一条试试', aiTyping: false, typingLabel: undefined })
      return
    }
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw: finalRaw,
      parsed: parseAiTurnDebugPayload({
        mainPrompt: [contextSections, socialMemories].filter(Boolean).join('\n\n'),
        conversionPrompt,
        rawText,
        jsonRaw,
        finalRaw,
        bubbles,
        knowledgeQueries,
        mood: turnMood,
        thought: turnThought,
        qualityCheck: qualityCheckDebug,
        injectedIntents,
        promptTrace: { sections: [{ label: '世界书', content: worldbookText }, { label: '结构化记忆', content: recentMemories }, { label: '特质规则', content: contact.customPersonalityTraits?.map((trait) => `${trait.name}: ${trait.meaning}`).join('\n') || contact.personalityTrait || '' }, { label: '关系与心情', content: relationshipText }, { label: '日程与当前情境', content: situationText }, { label: '主动话题', content: proactiveContext }].filter((section) => section.content), worldbookMatches: worldbookTrace.matches.map((match) => ({ id: match.entry.id, title: match.entry.title, score: match.score, chars: match.entry.content.length })), memorySummary: recentMemories, traitSummary: contact.customPersonalityTraits?.map((trait) => trait.name).join('、') || contact.personalityTrait, proactiveSource: proactiveContext || undefined },
      }),
      knowledgeQueries,
      createdAt: Date.now(),
    })
    revealBubbles(
      conversationId,
      contact,
      settings,
      stickers,
      bubbles,
      streamId,
      aiTurnId,
      _triggeringUserText,
      turnMood,
      turnThought,
      finalRaw,
      injectedIntents.map((intent) => intent.id),
    )
    console.info(`[chat-perf] first-bubble-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)}`)
    } catch (err) {
    if (streamByConversation.get(conversationId) !== streamId) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[chat] 生成回复出错 对方=${displayName(contact)}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false, typingLabel: undefined })
  }
}

function revealBubbles(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
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
  let sequence = Promise.resolve()
  bubbles.forEach((bubble, i) => {
    sequence = sequence.then(() => new Promise<void>((resolve) => {
      // Generation and quality review already made the user wait. Show the
      // first completed bubble immediately; pace follow-ups only after the
      // previous bubble (including remote media work) has actually landed.
      const timer = setTimeout(async () => {
        try {
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
          priority: 'special',
          createdAt: Date.now(),
        }
        // A new special arrangement replaces the previous one for that day;
        // the generated weekly schedule remains the low-priority fallback.
        await db.contacts.update(contact.id, { scheduleOverrides: [...pruned.filter((item) => item.date !== override.date), override] })
      }
      let imagePayload: Message['image']
      let imageFailed = false
      if (bubble.type === 'image' && isImageProviderReady(settings)) {
        try {
          const generated = await generateRemoteImage(settings, bubble.query)
          if (generated) imagePayload = { url: generated.url, caption: bubble.caption, query: bubble.query, provider: generated.provider }
        } catch (err) {
          console.warn('[photo] 图片生成接口失败', err)
          imageFailed = true
        }
      }
      if (bubble.type === 'image' && !imagePayload && !imageFailed) {
        if (!settings.pexelsApiKey) imageFailed = true
        else try { const photo=await searchPexelsPhoto(settings.pexelsApiKey,bubble.query,'landscape'); if(!photo)imageFailed=true; else imagePayload={url:photo.url,caption:bubble.caption,photographer:photo.photographer,photographerUrl:photo.photographerUrl,query:bubble.query} } catch(err){console.warn('[photo] 聊天图片发送失败',err);imageFailed=true}
      }

      let remoteSticker: RemoteStickerResult | undefined
      let stickerFailed = false
      if (bubble.type === 'sticker' && !stickers.some((sticker) => sticker.name === bubble.name)) {
        if (!isStickerProviderReady(settings)) {
          stickerFailed = true
        } else {
        try {
            remoteSticker = (await searchRemoteStickers(settings, bubble.name))[0]
            if (!remoteSticker) stickerFailed = true
        } catch (err) {
          console.warn('[sticker] 远程表情包获取失败', err)
            stickerFailed = true
          }
        }
      }

      let finance: Message['finance']
      if (bubble.type === 'transfer') {
        try { const tx = await transferFunds({ from: contact.id, to: USER_WALLET_ID, amount: bubble.amount, kind: 'transfer', note: bubble.note, idempotencyKey: `ai:${streamId}:${i}` }); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.note, status: 'completed' } } catch (err) { console.warn('[finance] AI转账被拒绝', err); return }
      } else if (bubble.type === 'redPacket') {
        try { const tx = await reserveRedPacket(contact.id, bubble.amount, bubble.note); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.note, status: 'pending' } } catch (err) { console.warn('[finance] AI红包被拒绝', err); return }
      } else if (bubble.type === 'loanRequest') {
        const loanId = uuid(); await db.loans.add({ id: loanId, lenderId: USER_WALLET_ID, borrowerId: contact.id, principal: bubble.amount, outstanding: bubble.amount, note: bubble.note, status: 'pending', createdAt: Date.now() }); finance = { loanId, amount: bubble.amount, note: bubble.note, status: 'pending' }
      } else if (bubble.type === 'loanDecision' && bubble.loanId) {
        const loan = await db.loans.get(bubble.loanId)
        if (!loan || loan.status !== 'pending' || loan.borrowerId !== USER_WALLET_ID || loan.lenderId !== contact.id) return
        if (bubble.decision === 'accept') { try { await transferFunds({ from: contact.id, to: USER_WALLET_ID, amount: loan.principal, kind: 'loan', note: loan.note, idempotencyKey: `loan:${loan.id}` }); await db.loans.update(loan.id,{status:'active',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,note:loan.note,status:'accepted'} } catch { await db.loans.update(loan.id,{status:'rejected',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,status:'rejected'} } } else { await db.loans.update(loan.id,{status:'rejected',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,status:'rejected'} }
      } else if (bubble.type === 'giftPurchase') {
        if (!bubble.name) return
        try { const tx = await transferFunds({ from: contact.id, amount: bubble.amount, kind: 'purchase', note: `送给用户：${bubble.name}`, idempotencyKey: `ai-gift:${streamId}:${i}` }); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.description, status: 'completed' } } catch (err) { console.warn('[finance] AI购买礼物被拒绝', err); return }
      }

      let content: string
      if (bubble.type === 'text') content = bubble.content
      else if (bubble.type === 'sticker') content = stickerFailed ? '表情没找到…' : bubble.name
      else if (bubble.type === 'image') content = imageFailed ? '图片没发出来…' : bubble.caption || '[图片]'
      else if (bubble.type === 'scheduleChange') content = bubble.summary
      else if (bubble.type === 'link') content = bubble.label
      else if (bubble.type === 'giftPurchase') content = bubble.name || '礼物'
      else content = bubble.note || (bubble.type === 'loanDecision' ? '借款决定' : '资金互动')

      const msg: Message = {
        id: uuid(),
        conversationId,
        role: 'assistant',
        type: bubble.type === 'loanDecision'
          ? 'loanResult'
          : bubble.type === 'giftPurchase'
            ? 'gift'
            : (bubble.type === 'image' && imageFailed) || (bubble.type === 'sticker' && stickerFailed)
              ? 'text'
              : bubble.type,
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
        finance,
        gift: bubble.type === 'giftPurchase' ? { name: bubble.name || '礼物', icon: bubble.icon || '🎁', description: bubble.description } : undefined,
        sticker: remoteSticker ? { url: remoteSticker.url, provider: remoteSticker.provider } : undefined,
        image: imagePayload,
        debugAiTurnId: aiTurnId,
        debugParsedBubble: bubble,
        debugRawAiResponse: i === bubbles.length - 1 ? (finalRaw || '') : undefined,
        thought: turnThought && i === bubbles.length - 1 ? turnThought : undefined,
        createdAt: Date.now(),
      }
      if (turnThought && i === bubbles.length - 1) {
        console.log(`[chat] 想法已存入消息: ${turnThought}`)
      }
      await db.messages.add(msg)
      if (remoteSticker) void trackRemoteStickerSend(remoteSticker)
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
        useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined })
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
              .map((b) => (b.type === 'text' ? b.content : `[${b.type}] ${'name' in b ? b.name : 'label' in b ? b.label : 'summary' in b ? b.summary : 'query' in b ? b.query : b.note ?? b.amount}`))
              .join('\n'),
          })
        }
          }
        } catch (error) {
          console.error('[chat] 气泡写入失败', error)
        } finally {
          resolve()
        }
      }, i > 0 ? typingDelayMs(bubble) : 0)
      timers.push(timer)
    }))
  })
  timersByConversation.set(conversationId, timers)
  void sequence
}


