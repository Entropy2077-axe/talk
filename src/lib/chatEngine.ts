import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletionText as chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import {
  parseJsonLoose,
  parseAiResponse,
  serializePrivateTurn,
  typingDelayMs,
} from './aiProtocol'
import { buildRawChatPrompt } from './prompt'
import { retrieveWorldbookTrace } from './worldbook'
import { isModuleEnabled } from '../features'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateMemory, recentMemoriesText, socialMemoriesText } from './memory'
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
import { promptModulesForContact } from './promptPresets'
import { USER_WALLET_ID, getBalance, reserveRedPacket, transferFunds } from './finance'
import { trackRemoteStickerSend } from './remoteMedia'
import { resolveBubbleMedia } from './bubbleMedia'
import { createTurnController, revealSequentially } from './conversationRuntime'
import { isImageProviderReady, isStickerProviderReady } from './mediaProviders'
import { featureActive, promptModuleEnabled } from './promptModules'
import { realisticReplyDelayMs } from './replyTiming'
import { ensureOfflineExperiences } from './experiences'
import { canUsePlayerHome, ensureLocationsInitialized, reassignUnknownContactLocation, syncContactLocationsAt } from './locations'
import { evaluateDirectSpecialTask, runActionCommittee, type ActionCommitteeDebug } from './actionCommittee'
import type { CreateSpecialTaskResult } from './agentTasks'
import { createScheduleInternalTask } from './internalTasks'
import { createMediaAsset, startMediaAsset } from './imageAssets'
import { buildDirectOutputInstruction, parseDirectOutputReview } from './directOutput'
import { generatePrivateAgentTurn } from './chatAgentTools'
import { traceTurnEvent } from './deepseek'
import type { AiBubble, AppSettings, Contact, InternalTask, Message, MessageType, ScheduleOverride, Sticker } from '../types'

function ensureImageHasText(bubbles: AiBubble[]): AiBubble[] {
  if (!bubbles.some((bubble) => bubble.type === 'image') || bubbles.some((bubble) => bubble.type === 'text')) return bubbles
  return [{ type: 'text', content: '给你看张图。' }, ...bubbles]
}

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

/** Equal IndexedDB index keys have no stable order, so timestamps must be monotonic per conversation. */
export async function nextMessageTimestamp(conversationId: string, requested = Date.now()): Promise<number> {
  const rows = await db.messages.where('conversationId').equals(conversationId).toArray()
  const latest = rows.reduce((value, message) => Math.max(value, message.createdAt), 0)
  return Math.max(requested, latest + 1)
}

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
const turns = createTurnController()

function getActiveMood(contact: Contact, now: number): string | undefined {
  if (!contact.mood || !contact.mood.text) return undefined
  if (now > contact.mood.expiresAt) return undefined
  return contact.mood.text
}

function scheduleAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  triggeringUserText = '',
  proactiveContext = '',
  offlineFrom?: number,
  turnNow?: number,
  regenerationInstruction = '',
): void {
  const delay = realisticReplyDelayMs(isModuleEnabled('realisticReplies'))
  if (delay === 0) {
    void runAiTurn(conversationId, contact, settings, stickers, streamId, triggeringUserText, proactiveContext, offlineFrom, turnNow, regenerationInstruction)
    return
  }
  const timer = setTimeout(() => {
    if (!turns.isCurrent(conversationId, streamId)) return
    void runAiTurn(conversationId, contact, settings, stickers, streamId, triggeringUserText, proactiveContext, offlineFrom, turnNow, regenerationInstruction)
  }, delay)
  turns.addTimer(conversationId, timer)
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
  injectedIntents: Array<{ id: string }>
  promptTrace?: import('../types').PromptTrace
  actionCommittee?: ActionCommitteeDebug & { toolResult?: CreateSpecialTaskResult }
}): unknown {
  const { mainPrompt, conversionPrompt, finalRaw, jsonRaw, rawText, bubbles, knowledgeQueries, mood, thought, qualityCheck, injectedIntents, promptTrace, actionCommittee } = opts
  const conversionParsed: unknown = parseJsonLoose(finalRaw)
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
    actionCommittee,
  }
}

/** Cancels network work and unrevealed bubbles for one conversation. */
export function stopAiTurn(conversationId: string): void {
  turns.begin(conversationId, uuid())
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '' })
}

export function resetAllChatTurns(): void {
  turns.resetAll()
  useChatEngineStore.setState({ states: {} })
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
  if (featureActive(settings, 'career') && settings.userOccupation) parts.push(`职业: ${settings.userOccupation} 月薪: ${settings.userMonthlySalary}`)
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
  turns.begin(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: displayName(contact) })

  const now = await nextMessageTimestamp(conversationId)
  const previousUserMessages = await db.messages.where('conversationId').equals(conversationId).toArray()
  const previousUserAt = previousUserMessages.filter((message) => message.role === 'user').reduce((latest, message) => Math.max(latest, message.createdAt), 0)
  const msg: Message = {
    id: uuid(),
    conversationId,
    role: 'user',
    type: 'text',
    content: text.trim(),
    createdAt: now,
  }
  await db.messages.add(msg)
  await db.conversations.update(conversationId, { updatedAt: now })

  scheduleAiTurn(conversationId, contact, settings, stickers, streamId, text.trim(), '', previousUserAt || undefined, now)
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
  turns.begin(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: displayName(contact) })
  scheduleAiTurn(conversationId, contact, settings, stickers, streamId, '', proactiveContext)
}

export async function regenerateAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  aiTurnId: string,
  regenerationInstruction = '',
): Promise<void> {
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置 API Key，请先去“我 / 设置”里填写' })
    return
  }

  const streamId = uuid()
  turns.begin(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: displayName(contact) })

  const turnMessages = await db.messages
    .where('conversationId')
    .equals(conversationId)
    .filter((message) => message.debugAiTurnId === aiTurnId)
    .toArray()
  if (turnMessages.length > 0) await db.messages.bulkDelete(turnMessages.map((message) => message.id))
  await db.aiTurns.delete(aiTurnId)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  scheduleAiTurn(conversationId, contact, settings, stickers, streamId, '', '', undefined, undefined, regenerationInstruction.trim())
}

async function runAiTurn(
  conversationId: string,
  contact: Contact,
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  _triggeringUserText = '',
  proactiveContext = '',
  offlineFrom?: number,
  turnNow?: number,
  regenerationInstruction = '',
): Promise<void> {
  const engine = useChatEngineStore.getState()
  let responseTimeout: ReturnType<typeof setTimeout> | undefined
  const turnStartedAt = performance.now()
  const now = turnNow ?? Date.now()
  const activeMood = getActiveMood(contact, now)
  engine.patch(conversationId, { aiTyping: true, error: '', typingLabel: displayName(contact) })
  const timeoutMs = Math.max(0, Math.min(10 * 60 * 1000, Math.round(settings.chatResponseTimeoutMs ?? 60 * 1000)))
  if (timeoutMs > 0) {
    responseTimeout = setTimeout(() => {
      if (!turns.isCurrent(conversationId, streamId)) return
      // Invalidate before aborting so queued bubbles are cancelled, while
      // messages already persisted in IndexedDB remain visible.
      turns.begin(conversationId, uuid())
      engine.patch(conversationId, { aiTyping: false, typingLabel: undefined, error: `回复等待超过 ${Math.round(timeoutMs / 1000)} 秒，已停止生成。` })
    }, timeoutMs)
  }
  console.log(`[chat] 开始生成回复 对方=${displayName(contact)} conversationId=${conversationId}`)
  try {
    const directOutput = isModuleEnabled('directOutput')
    const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    let absenceContext = ''
    if (!directOutput && offlineFrom && now - offlineFrom >= 60 * 60 * 1000) {
      try {
        const completed = await ensureOfflineExperiences({ contact, settings, from: offlineFrom, to: now })
        absenceContext = completed.absenceContext
        const refreshed = await db.contacts.get(contact.id)
        if (refreshed) contact = refreshed
      } catch (error) {
        console.warn('[experiences] 离线经历补全失败，本轮降级继续聊天', error)
        absenceContext = `【用户离线】对方距离上次回复约${Math.round((now - offlineFrom) / 360000) / 10}小时。结合关系和上次对话自然判断是否提及，不要机械报时，也不要默认对方故意忽视你。`
      }
    }

    const contactPromptModules = promptModulesForContact(contact, settings)
    const contactPromptSettings = { ...settings, promptModules: contactPromptModules }

    // Cold-start warmth evaluation: 好感度 is enabled but this contact
    // was created while the module was off → evaluate once from chat history.
    if (!directOutput && featureActive(contactPromptSettings, 'relationship') && contact.warmth === undefined) {
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
    const injectedIntents: Array<{ id: string }> = []

    // ---- Step 1: build context sections (no JSON protocol) ----
    const nowDate = new Date(now)
    const scheduleText = describeUpcomingScheduleText(contact, nowDate)
    let actionLocations: import('../types').LocationNode[] = []
    let locationActionContext = ''
    let locationFactsForReview = ''
    if (isModuleEnabled('location')) {
      await ensureLocationsInitialized()
      if (contact.locationSource === 'unknown') {
        await reassignUnknownContactLocation(contact, settings)
        const reassigned = await db.contacts.get(contact.id)
        if (reassigned) contact = reassigned
      }
      await syncContactLocationsAt(nowDate)
      const refreshedForTask = await db.contacts.get(contact.id)
      if (refreshedForTask) contact = refreshedForTask
      actionLocations = await db.locations.toArray()
      const currentLocation = actionLocations.find((location) => location.id === contact.currentLocationId)
      const leafLocations = actionLocations.filter((location) => !actionLocations.some((candidate) => candidate.parentId === location.id))
      const locationCatalog = leafLocations.map((location) => `${location.name}(${location.id})`).join('、')
      locationFactsForReview = `当前地点=${currentLocation?.name ?? '未知地点'}(${contact.currentLocationId ?? '未知'})\n可执行地点=${locationCatalog}`
      locationActionContext = `【地点与特殊任务】你当前位于：${currentLocation?.name ?? '未知地点'}（${contact.currentLocationId ?? '未知'}）。你可以按照自己的人设和意愿接受、拒绝，也可以主动提出行动。角色明确决定现在立刻前往某地并开始活动时，在 submit_turn.events 中加入 type=activity_now；未来安排只有日期、整点开始和结束时间、地点都明确且角色已经作出具体承诺时才加入 type=schedule。两种动作都不能代替自然聊天，整轮 events 必须至少包含一条 type=text。仅讨论可能性、拒绝、附带未满足条件或信息不全时不要执行动作。特殊任务一旦与某条默认任务重叠，那条默认任务会整项取消。以下列表是当前唯一可确认并执行的具体地点：${locationCatalog}。玩家提到列表外地点，或名称无法可靠对应列表时，不能假装去过、看过、知道它存在，也不能直接答应；请保持角色口吻自然询问位置或让对方进一步说明，不要提“系统”“目录”或地点ID。`
    }
    const memoryPromptOn = promptModuleEnabled(contactPromptSettings, 'memory')
    const [recentMemories, financeContext, socialMemories, sharedOriginalContext, worldbookTrace, existingContacts] = await Promise.all([
      memoryPromptOn ? recentMemoriesText(contact.id) : Promise.resolve(''),
      featureActive(contactPromptSettings, 'career')
        ? Promise.all([
            getBalance(contact.id),
            getBalance(USER_WALLET_ID),
            db.loans.filter(l => l.status === 'active' && (l.lenderId === contact.id || l.borrowerId === contact.id)).toArray(),
          ]).then(([contactBalance, userBalance, loans]) => `\n【经济状况】你的可用余额：${contactBalance}；对方可用余额：${userBalance}。未结清借款：${loans.map(l => `${l.borrowerId === contact.id ? '你欠对方' : '对方欠你'}${l.outstanding}`).join('；') || '无'}。所有金钱动作必须量力而行，不得凭空造钱。`)
        : Promise.resolve(''),
      memoryPromptOn ? socialMemoriesText(contact.id) : Promise.resolve(''),
      memoryPromptOn ? recentSharedOriginalContext([contact.id], settings.userNickname, {
        maxMessages: 50,
        maxChars: 8_000,
        excludeConversationId: conversationId,
      }) : Promise.resolve(''),
      featureActive(contactPromptSettings, 'worldview') ? retrieveWorldbookTrace([
        _triggeringUserText, proactiveContext, contact.name, contact.systemPrompt, contact.memoryFacts,
        history.slice(-8).map((m) => m.content).join(' '),
      ].filter(Boolean).join('\n'), { worldviewId: contactPromptSettings.activeWorldId || contactPromptSettings.defaultWorldviewId }) : Promise.resolve({ text: '', matches: [] }),
      db.contacts.toArray(),
    ])
    const worldbookText = worldbookTrace.text
    const unavailableRecommendationNames = Array.from(new Set(existingContacts.flatMap((candidate) => [
      candidate.name,
      candidate.realName,
      candidate.nickname,
      displayName(candidate),
    ]).map((name) => name?.trim()).filter((name): name is string => !!name))).slice(0, 200)
    const recommendationConstraint = unavailableRecommendationNames.length
      ? `【联系人推荐硬限制】以下姓名、真名或昵称已经属于用户现有联系人：${unavailableRecommendationNames.join('、')}。绝不能推荐其中任意一个名字，也不能把同名者说成“其实是另一个人”；同名在本应用中一律视为重复联系人。若想不到一个不在名单中的、自己确实认识且适合介绍的人，就正常聊天，不要调用 contact_recommendation。`
      : '【联系人推荐硬限制】只有确实认识、且尚未成为用户联系人的新人物才能推荐。'
    const contactAge = contact.birthday ? ageFromBirthday(contact.birthday) : null
    const runtimeAgeFact = contactAge === null ? '' : `\n【当前年龄硬事实】生日为${contact.birthday}，按当前日期计算为${contactAge}岁；若旧人设文本中的年龄不同，以这里为准。`
    const relationshipText = `【你和对方的关系】${relationshipLine(
      featureActive(contactPromptSettings, 'relationship') ? (contact.relationshipBase || '朋友') : '朋友',
      featureActive(contactPromptSettings, 'relationship') ? (contact.relationshipDynamic || '') : '',
      featureActive(contactPromptSettings, 'relationship') ? (contact.warmth ?? 0) : 0,
    )}`
    const userMemoryText = `【你对TA的了解】${contact.memoryFacts || '（刚开始聊）'}`
    const habitText = `【相处习惯】${contact.memoryStyle || '（还没有形成习惯）'}`
    const situationText = `【当前情境】现在: ${describeCurrentTime(nowDate)}。对方: ${buildUserProfileText(settings)}。${activeMood ? `你的心情: ${activeMood}。` : ''}【日程】${describeCurrentSchedule(contact, nowDate) ? `\n当前: ${describeCurrentSchedule(contact, nowDate)}` : '\n当前: 暂无安排'}${scheduleText ? `\n接下来:\n${scheduleText}` : '\n接下来: 暂无安排'}${memoryPromptOn && activeUpcomingPlansText(contact, nowDate) ? `\n约定: ${activeUpcomingPlansText(contact, nowDate)}` : ''}${recentEventsText ? `\n最近: ${recentEventsText}` : ''}`
    const contextSections = buildRawChatPrompt({
      name: contact.name,
      persona: `${contact.systemPrompt}${runtimeAgeFact}${featureActive(contactPromptSettings, 'career') && contact.occupation ? `\n当前职业：${contact.occupation}，现实月薪：${contact.monthlySalary ?? 0}。工作会真实影响你的作息和日常话题。` : ''}${financeContext}`,
      stylePrompt: settings.globalSystemPrompt,
      promptModules: contactPromptModules,
      relationshipBase: featureActive(contactPromptSettings, 'relationship') ? (contact.relationshipBase || '朋友') : '朋友',
      worldviewText: worldbookText || undefined,
      latestUserText: _triggeringUserText,
      recentContext: '',
      relationshipContext: relationshipText,
      memoryContext: [userMemoryText, habitText].join('\n\n'),
      situationContext: [
        situationText,
        absenceContext,
        proactiveContext,
      ].filter(Boolean).join('\n\n'),
      stickerNames: stickers.map((s) => s.name),
      remoteStickerSearchEnabled: isStickerProviderReady(settings),
      imageGenerationEnabled: isImageProviderReady(settings),
      imageSearchEnabled: !!settings.pexelsApiKey,
      recentMemoriesText: recentMemories || undefined,
    })
    if (!contextSections.trim()) throw new Error('对话核心提示词模块已屏蔽')

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const controller = new AbortController()
    turns.setAbortController(conversationId, controller)
    const regenerationPrompt = regenerationInstruction
      ? `【重要：本次重生成必须遵守的剧情指令】\n用户不认可上一版回复的发展。下方用户指令是本次重生成的首要内容要求：必须落实到实际回复和事件发展中，不可忽略、淡化、回避或改写成相反走向。`
      : ''
    const regenerationUserMessage = regenerationInstruction
      ? `【本次重生成：最高优先级剧情要求】\n请先在心中确认后再作答：你接下来生成的每条消息和事件发展，都必须严格符合以下要求：\n${regenerationInstruction}\n\n这是用户对上一版结果的明确修正。即使你原本会作出不同选择，也必须以此要求为准；不要解释、复述或提及这条要求，只需自然地把它演出来。`
      : ''
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: [contextSections, socialMemories, sharedOriginalContext, regenerationPrompt, directOutput ? buildDirectOutputInstruction(actionLocations) : ''].filter(Boolean).join('\n\n') },
      ...recentHistory.map((m): ChatMessage => {
        if (m.type === 'sticker') return formatStructuredHistoryEvent(m, 'sticker')
        if (m.type === 'link') return formatStructuredHistoryEvent(m, 'link')
        if (m.type === 'gift') return formatStructuredHistoryEvent(m, 'gift')
        if (m.type === 'scheduleChange') return formatStructuredHistoryEvent(m, 'scheduleChange')
        if (['transfer','redPacket','loanRequest','loanResult','repayment'].includes(m.type)) return formatStructuredHistoryEvent(m, m.type)
        return { role: m.role, content: m.content }
      }),
      ...(regenerationUserMessage ? [{ role: 'user' as const, content: regenerationUserMessage }] : []),
      { role: 'system', content: '【最终生成提醒】准备自然聊天内容，并按后续要求通过 submit_turn 原生函数提交；不要在用户可见正文中输出JSON、分析、标题、Markdown、工具名或协议。' },
    ])
    console.info(`[chat-perf] context-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)}`)

    // Native Agent turn: private chat forces one schema-bound submit_turn call
    // containing the complete ordered message/action sequence. Plain-text JSON
    // is deliberately not used as a compatibility fallback here.
    let rawText: string
    let localTurn
    if (directOutput) {
      rawText = await chatCompletion({
        apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model,
        messages: chatMessages, signal: controller.signal, purpose: proactiveContext ? 'proactive' : 'chat',
        automatic: !!proactiveContext, thinking: 'disabled', temperature: regenerationInstruction ? 0.55 : 0.9,
        maxTokens: 1200, jsonMode: true, trace: { turnId: streamId, stage: 'original_generation', conversationId },
      })
      localTurn = parseAiResponse(rawText)
    } else {
      const generated = await generatePrivateAgentTurn({
        apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, utilityModel: settings.utilityModel,
        messages: [...chatMessages, { role: 'system', content: `本轮必须通过唯一的 submit_turn 原生函数一次性提交完整回复。events 按实际发送顺序排列，可以自然地连续发送多段文字、多张图片或穿插消息与行动，不要固定成“一张图片配一句话”。image、activity_now、schedule、contact_recommendation、transfer、red_packet、loan_request、loan_decision、gift_purchase 等事件不能单独作为回复，但只要求整轮至少有一条 text，文字可以在行动前后；sticker 可以单独发送。contact_recommendation 仅在你以当前角色身份确实认识某人、此刻自然适合牵线时使用，禁止为了展示功能、活跃气氛或完成任务而调用。${recommendationConstraint} 填写真实想法和中文文字心情，心情禁止使用 emoji。不要在普通 content 中输出 JSON、工具名或协议。${locationActionContext ? `\n${locationActionContext}` : ''}` }],
        signal: controller.signal, purpose: proactiveContext ? 'proactive' : 'chat', automatic: !!proactiveContext,
        trace: { turnId: streamId, stage: 'original_generation', conversationId },
        stickerNames: stickers.map((sticker) => sticker.name), stickerSearchEnabled: isStickerProviderReady(settings),
        imageEnabled: isImageProviderReady(settings) || !!settings.pexelsApiKey,
        knowledgeEnabled: featureActive(contactPromptSettings, 'knowledgeBase'),
        scheduleEnabled: isModuleEnabled('location'), locationIds: actionLocations.filter((location) => !actionLocations.some((candidate) => candidate.parentId === location.id)).map((location) => location.id),
      })
      rawText = generated.raw
      localTurn = generated.parsed
    }

    if (!turns.isCurrent(conversationId, streamId)) return
    console.log(`[chat] Agent回复(${rawText.length}字): ${rawText.slice(0, 100)}...`)

    // The audit model performs the final JSON translation; there is no third translator.
    console.info(`[chat-perf] model-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)}`)
    let conversionPrompt = '审核模型已同时完成原文格式审核和JSON翻译；未调用第三个翻译模型。'
    let jsonRaw = serializePrivateTurn(localTurn)
    let parsedTurn = localTurn
    if (directOutput) {
      conversionPrompt = '一次调用直出：主模型直接返回最终 JSON，不调用格式转换模型。'
      jsonRaw = rawText
    }
    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = parsedTurn
    let immediateActivities = parsedTurn.immediateActivities ?? []
    bubbles = ensureImageHasText(bubbles)
    const initiallyRequestedKnowledge = [...knowledgeQueries]
    const qualityCheckDebug = {
      enabled: true,
      repaired: false,
      reason: undefined as string | undefined,
      detectedInvalid: false,
    }

    const runLogicReview = (stage: 'first_quality' | 'second_quality' | 'other', focus: string) => reviewTurnLogic({
      settings,
      latestUserText: _triggeringUserText,
      draftText: rawText,
      personaFacts: [
        `本次审查重点=${focus}`,
        promptModuleEnabled(contactPromptSettings, 'chat') ? `角色=${displayName(contact)}` : '',
        promptModuleEnabled(contactPromptSettings, 'chat') ? `人设=${contact.systemPrompt.slice(0, 1400)}` : '',
        featureActive(contactPromptSettings, 'worldview') && worldbookText ? `本轮命中世界书=${worldbookText.slice(0, 1000)}` : '',
        sharedOriginalContext ? `相关跨场景事实=${sharedOriginalContext.slice(-1000)}` : '',
        contactAge === null ? '' : `当前年龄硬事实=${contactAge}岁（生日${contact.birthday}）`,
        scheduleText ? `未来十四天日程=\n${scheduleText}` : '',
        locationFactsForReview ? `地点硬事实=\n${locationFactsForReview}\n列表外地点不得当成已确认存在，也不得虚构去过、见过照片或了解其情况。` : '',
        `事实来源规则=不得把用户没说、上下文没给出的片名类型、截稿日期、去过某地、看过预告或照片等细节写成既成事实。`,
      ].filter(Boolean).join('\n'),
      recentContext: formatRecentConversationForReview(recentHistory.slice(-4), contact),
      signal: controller.signal,
      trace: { turnId: streamId, stage, conversationId },
    })
    void runLogicReview
    knowledgeQueries = Array.from(new Set([...initiallyRequestedKnowledge, ...knowledgeQueries])).slice(0, 2)
    if (!directOutput && featureActive(contactPromptSettings, 'knowledgeBase') && knowledgeQueries.length > 0) {
      const knowledge = await resolveKnowledgeQueries(knowledgeQueries, settings)
      if (knowledge.text) {
        const enrichedMessages = chatMessages.map((message, index) => index === 0
          ? { ...message, content: `${message.content}\n\n【针对陌生词汇的搜索结果】\n${knowledge.text}\n你刚才对陌生词汇自然表示了疑问。现在根据可靠搜索结果重新回答用户，语气要自然，不要写成搜索报告，也不要提审查流程。` }
          : message)
        const regenerated = await generatePrivateAgentTurn({
          apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, utilityModel: settings.utilityModel,
          messages: [...enrichedMessages, { role: 'system', content: '根据查询结果重新决定回复，并通过唯一的 submit_turn 原生函数一次性提交完整回复。events 可按自然顺序包含多段文字、多张图片和行动；图片或行动存在时，整轮至少包含一条自然文字，但不要机械地逐项配文。心情使用中文文字，禁止 emoji。' }],
          signal: controller.signal, purpose: proactiveContext ? 'proactive' : 'chat', automatic: !!proactiveContext,
          trace: { turnId: streamId, stage: 'second_chat', conversationId }, stickerNames: stickers.map((sticker) => sticker.name),
          stickerSearchEnabled: isStickerProviderReady(settings), imageEnabled: isImageProviderReady(settings) || !!settings.pexelsApiKey,
          knowledgeEnabled: false, scheduleEnabled: isModuleEnabled('location'), locationIds: actionLocations.filter((location) => !actionLocations.some((candidate) => candidate.parentId === location.id)).map((location) => location.id),
        })
        rawText = regenerated.raw
        const converted = regenerated.parsed
        if (converted.bubbles.length === 0) throw new Error('联网补全后的审核模型没有产出有效JSON')
        conversionPrompt = '联网补全后的审核模型已同时完成原文审核和JSON翻译。'
        jsonRaw = rawText
        finalRaw = jsonRaw
        ;({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought } = converted)
        immediateActivities = converted.immediateActivities ?? []
        bubbles = ensureImageHasText(bubbles)
      }
    }
    console.log(`[chat] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 mood=${turnMood || '无'} thought=${turnThought ? '有(' + turnThought.length + '字)' : '无'} 对方=${displayName(contact)}`)
    if (bubbles.length === 0) {
      console.warn(`[chat] 本轮没有正常回复 对方=${displayName(contact)} JSON内容: ${jsonRaw.slice(0, 200)}`)
      engine.patch(conversationId, { error: proactiveContext ? '' : '对方这次没有正常回复 可以再发一条试试', aiTyping: false, typingLabel: undefined })
      return
    }
    const directReview = directOutput ? parseDirectOutputReview(rawText) : null
    // The mandatory audit stage above owns all semantic and format review.
    // Keep this empty compatibility result so the legacy fallback branches
    // below cannot issue extra hidden review calls.
    const logicReviews: Array<{ status: 'pass' | 'reject' | 'unavailable'; reason: string }> = []
    if (!turns.isCurrent(conversationId, streamId)) return
    const rejectedReview = logicReviews.find((review) => review.status === 'reject')
    const unavailableReviews = logicReviews.filter((review) => review.status === 'unavailable')
    if (directOutput && directReview?.valid === false) {
      qualityCheckDebug.detectedInvalid = true
      qualityCheckDebug.reason = directReview.reason || '主模型同次自审未通过'
      bubbles = [{ type: 'text', content: '我刚才没想清楚，能让我重新想一下吗？' }]
      knowledgeQueries = []
      turnMood = undefined
      turnThought = undefined
      finalRaw = serializePrivateTurn({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought })
      jsonRaw = finalRaw
    } else if (rejectedReview) {
      qualityCheckDebug.detectedInvalid = true
      qualityCheckDebug.reason = rejectedReview.reason
      console.warn(`[chat] 最终回复未通过三重逻辑审查，改发兜底提示 对方=${displayName(contact)} 原因=${rejectedReview.reason || '未知原因'}`)
      bubbles = [{ type: 'text', content: '我刚才没想清楚，能让我重新想一下吗？' }]
      knowledgeQueries = []
      turnMood = undefined
      turnThought = undefined
      finalRaw = serializePrivateTurn({ bubbles, knowledgeQueries, mood: turnMood, thought: turnThought })
      jsonRaw = finalRaw
    } else {
      const selfReview = directOutput
        ? (directReview ? `同次自审通过：${directReview.reason || '无客观冲突'}` : '同次自审字段缺失，已仅执行本地结构校验')
        : '主回复已通过三重逻辑审查'
      qualityCheckDebug.reason = unavailableReviews.length
        ? `${selfReview}；${unavailableReviews.length}/3 项审查不可用，已按其余审查放行`
        : `${selfReview}；三重逻辑审查均通过`
    }
    let actionCommittee: (ActionCommitteeDebug & { toolResult?: CreateSpecialTaskResult }) | undefined
    let internalTask: InternalTask | undefined
    if (!directOutput && !qualityCheckDebug.detectedInvalid && immediateActivities.length > 0 && isModuleEnabled('location')) {
      const action = immediateActivities[0]
      const location = actionLocations.find((candidate) => candidate.id === action.locationId)
      const playerHomeVisit = /来我家|到我家|去我家|来家里|到家里|去家里|邀请你.*家/.test(_triggeringUserText)
      const toolResult = await createScheduleInternalTask(contact.id, conversationId, {
        startsAt: now,
        endsAt: now + action.durationMinutes * 60_000,
        locationId: action.locationId,
        activity: action.activity,
        summary: `${action.activity} · ${location?.name ?? action.locationId}`,
        phoneAccess: action.phoneAccess,
        sourceConversationId: conversationId,
        playerHomeVisit,
      }, now)
      if (toolResult.success) {
        internalTask = toolResult.internalTask
        void traceTurnEvent({ turnId: streamId, conversationId, stage: 'location_change', output: `立即行动：${action.activity}｜${location?.name ?? action.locationId}｜${action.durationMinutes}分钟` })
      } else {
        bubbles = [{ type: 'text', content: '我刚想动身，但这个地点现在去不了。' }]
        immediateActivities = []
        turnThought = undefined
        finalRaw = serializePrivateTurn({ bubbles, knowledgeQueries: [], mood: turnMood, thought: turnThought })
        jsonRaw = finalRaw
      }
    }
    // Normal turns only execute explicit [schedule:...] markers parsed above.
    // The legacy committee remains limited to the experimental direct-output mode.
    if (directOutput && !qualityCheckDebug.detectedInvalid && _triggeringUserText.trim() && isModuleEnabled('location') && actionLocations.length > 0) {
      const visibleDraft = bubbles.map((bubble) => {
        if (bubble.type === 'text') return bubble.content
        if (bubble.type === 'scheduleChange') return bubble.summary
        if (bubble.type === 'image') return '[图片]'
        if (bubble.type === 'sticker') return `[表情：${bubble.name}]`
        return ''
      }).filter(Boolean).join('\n')
      actionCommittee = directOutput ? evaluateDirectSpecialTask(rawText, actionLocations, now, _triggeringUserText) : await runActionCommittee({
        contact,
        settings,
        locations: actionLocations,
        playerText: _triggeringUserText,
        draftText: visibleDraft,
        now,
        signal: controller.signal,
        turnId: streamId,
        conversationId,
      })
      if (!turns.isCurrent(conversationId, streamId)) return
      if (actionCommittee.approved && actionCommittee.task) {
        const playerHomeVisit = /来我家|到我家|去我家|来家里|到家里|去家里|邀请你.*家/.test(_triggeringUserText)
        const toolResult = await createScheduleInternalTask(contact.id, conversationId, { ...actionCommittee.task, sourceConversationId: conversationId, playerHomeVisit }, now)
        actionCommittee = { ...actionCommittee, toolResult }
        if (!toolResult.success) {
          console.warn(`[agent] 特殊任务执行失败 contact=${displayName(contact)} code=${toolResult.code}`)
          bubbles = [{ type: 'text', content: '我刚才想了一下，这个安排现在还定不下来，等我确认好再告诉你。' }]
          turnThought = undefined
          finalRaw = serializePrivateTurn({ bubbles, knowledgeQueries: [], mood: turnMood, thought: turnThought })
          jsonRaw = finalRaw
        } else {
          internalTask = toolResult.internalTask
        }
      }
    }
    console.info(`[chat-perf] review-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)} repaired=no`)
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
        actionCommittee,
        promptTrace: { sections: [{ label: '世界书', content: worldbookText }, { label: '结构化记忆', content: recentMemories }, { label: '关系与心情', content: relationshipText }, { label: '日程与当前情境', content: situationText }, { label: '主动话题', content: proactiveContext }].filter((section) => section.content), worldbookMatches: worldbookTrace.matches.map((match) => ({ id: match.entry.id, title: match.entry.title, score: match.score, chars: match.entry.content.length })), memorySummary: recentMemories, proactiveSource: proactiveContext || undefined },
      }),
      knowledgeQueries,
      createdAt: now,
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
      now,
      directOutput,
      internalTask,
    )
    console.info(`[chat-perf] first-bubble-ready=${Math.round(performance.now() - turnStartedAt)}ms contact=${displayName(contact)}`)
  } catch (err) {
    if (!turns.isCurrent(conversationId, streamId)) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[chat] 生成回复出错 对方=${displayName(contact)}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false, typingLabel: undefined })
  } finally {
    if (responseTimeout) clearTimeout(responseTimeout)
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
  turnNow = Date.now(),
  directOutput = false,
  internalTask?: InternalTask,
  onFirstBubble?: () => void,
): void {
  revealSequentially({
    conversationId,
    streamId,
    items: bubbles,
    controller: turns,
    // Generation and quality review already made the user wait. Show the
    // first completed bubble immediately; pace follow-ups only after the
    // previous bubble (including remote media work) has actually landed.
    delayMs: (bubble, i) => i > 0 ? typingDelayMs(bubble) : 0,
    reveal: async (bubble, i) => {
      let executionError = ''
      if (bubble.type === 'link' && bubble.app === 'contact_recommendation') {
        const candidateName = typeof bubble.data?.candidateName === 'string' ? bubble.data.candidateName.trim().toLocaleLowerCase() : ''
        const existingContact = candidateName
          ? await db.contacts.filter((candidate) => [candidate.name, candidate.realName, candidate.nickname, displayName(candidate)]
              .some((name) => name?.trim().toLocaleLowerCase() === candidateName)).first()
          : undefined
        const recentRecommendations = candidateName
          ? await db.messages.where('conversationId').equals(conversationId).filter((message) =>
              message.type === 'link'
              && message.link?.app === 'contact_recommendation'
              && typeof message.link.data?.candidateName === 'string'
              && message.link.data.candidateName.trim().toLocaleLowerCase() === candidateName,
            ).count()
          : 0
        if (!candidateName) executionError = '这次介绍的信息不完整，暂时没法把人推荐给你。'
        else if (existingContact) executionError = `${displayName(existingContact)}已经在你的联系人里了。`
        else if (recentRecommendations > 0) executionError = '这个人之前已经介绍过了，我就不重复发推荐了。'
      }
      if (bubble.type === 'scheduleChange') {
        // Re-fetch rather than reusing the `contact` this whole turn was
        // handed — that snapshot predates this write, and stashing a stale
        // scheduleOverrides array here would silently drop the exception
        // (same staleness bug fixed in proactiveChat.ts's pendingEvents write).
        const fresh = await db.contacts.get(contact.id)
        const pruned = pruneExpiredOverrides(fresh?.scheduleOverrides ?? [], new Date(turnNow))
        const location = bubble.locationId ? await db.locations.get(bubble.locationId) : undefined
        const playerHomeVisit = /来我家|到我家|去我家|来家里|到家里|去家里|邀请你.*家/.test(_triggeringUserText)
        // Markers carry IDs, never free-form locations.  An invalid ID is a
        // rejected execution, not an invitation for a later model to guess.
        if (bubble.locationId && !location) executionError = '这个地点已经不可用了，日程没有创建成功。'
        else if (location && !canUsePlayerHome(contact, location.id, playerHomeVisit)) executionError = '没有明确邀请，不能把对方安排到你家。'
        const override: ScheduleOverride | undefined = executionError ? undefined : {
          id: uuid(),
          date: bubble.date,
          startHour: bubble.startHour,
          endHour: bubble.endHour,
          phoneAccess: bubble.phoneAccess,
          location: location?.name ?? bubble.location,
          locationId: location?.id,
          activity: bubble.activity,
          summary: bubble.summary,
          priority: 'special',
          playerHomeVisit,
          createdAt: turnNow,
        }
        // Multiple non-overlapping special tasks may coexist on the same day.
        if (override) {
          await db.contacts.update(contact.id, { scheduleOverrides: [...pruned, override] })
          void traceTurnEvent({ turnId: streamId, conversationId, stage: 'schedule_change', output: `新建：${override.activity}｜${override.date} ${String(override.startHour).padStart(2, '0')}:00-${String(override.endHour).padStart(2, '0')}:00｜${override.location}` })
        }
      }
      let imagePayload: Message['image']
      let imageFailed = false
      let imageAssetId: string | undefined
      const media = bubble.type === 'image'
        ? { remoteSticker: undefined, stickerFailed: false }
        : await resolveBubbleMedia(bubble, settings, stickers)
      const { remoteSticker, stickerFailed } = media

      let finance: Message['finance']
      if (bubble.type === 'transfer') {
        try { const tx = await transferFunds({ from: contact.id, to: USER_WALLET_ID, amount: bubble.amount, kind: 'transfer', note: bubble.note, idempotencyKey: `ai:${streamId}:${i}` }); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.note, status: 'completed' } } catch (err) { console.warn('[finance] AI转账被拒绝', err); executionError = '转账没有成功，余额或交易状态不允许这次操作。' }
      } else if (bubble.type === 'redPacket') {
        try { const tx = await reserveRedPacket(contact.id, bubble.amount, bubble.note, `ai-red-packet:${streamId}:${i}`); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.note, status: 'pending' } } catch (err) { console.warn('[finance] AI红包被拒绝', err); executionError = '红包没有发成功，余额或交易状态不允许这次操作。' }
      } else if (bubble.type === 'loanRequest') {
        const loanId = uuid(); await db.loans.add({ id: loanId, lenderId: USER_WALLET_ID, borrowerId: contact.id, principal: bubble.amount, outstanding: bubble.amount, note: bubble.note, status: 'pending', createdAt: Date.now() }); finance = { loanId, amount: bubble.amount, note: bubble.note, status: 'pending' }
      } else if (bubble.type === 'loanDecision' && bubble.loanId) {
        const loan = await db.loans.get(bubble.loanId)
        if (!loan || loan.status !== 'pending' || loan.borrowerId !== USER_WALLET_ID || loan.lenderId !== contact.id) executionError = '这笔借款已经不能处理了。'
        else if (bubble.decision === 'accept') { try { await transferFunds({ from: contact.id, to: USER_WALLET_ID, amount: loan.principal, kind: 'loan', note: loan.note, idempotencyKey: `loan:${loan.id}` }); await db.loans.update(loan.id,{status:'active',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,note:loan.note,status:'accepted'} } catch { await db.loans.update(loan.id,{status:'rejected',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,status:'rejected'} } } else { await db.loans.update(loan.id,{status:'rejected',resolvedAt:Date.now()}); finance={loanId:loan.id,amount:loan.principal,status:'rejected'} }
      } else if (bubble.type === 'giftPurchase') {
        if (!bubble.name) executionError = '礼物信息不完整，购买没有完成。'
        else try { const tx = await transferFunds({ from: contact.id, amount: bubble.amount, kind: 'purchase', note: `送给用户：${bubble.name}`, idempotencyKey: `ai-gift:${streamId}:${i}` }); finance = { transactionId: tx.id, amount: tx.amount, note: bubble.description, status: 'completed' } } catch (err) { console.warn('[finance] AI购买礼物被拒绝', err); executionError = '礼物没有购买成功，余额或交易状态不允许这次操作。' }
      }

      let content: string
      if (executionError) content = executionError
      else if (bubble.type === 'text') content = bubble.content
      else if (bubble.type === 'sticker') content = stickerFailed ? '表情没找到…' : bubble.name
      else if (bubble.type === 'image') content = imageFailed ? '图片没发出来…' : '[图片]'
      else if (bubble.type === 'scheduleChange') content = bubble.summary
      else if (bubble.type === 'link') content = bubble.label
      else if (bubble.type === 'giftPurchase') content = bubble.name || '礼物'
      else content = bubble.note || (bubble.type === 'loanDecision' ? '借款决定' : '资金互动')

      const messageCreatedAt = await nextMessageTimestamp(conversationId, turnNow + i + 1)
      const messageId = uuid()
      if (bubble.type === 'image') {
        if (!isImageProviderReady(settings)) imageFailed = true
        else {
          try {
            const kind = bubble.kind ?? 'portrait'
            const participants = bubble.participants ?? (kind === 'scene' || kind === 'object' ? [] : ['self'])
            const asset = await createMediaAsset({
              origin: 'chat', originId: messageId, conversationId, turnId: streamId,
              ownerContactIds: participants.includes('self') ? [contact.id] : [],
              includeUser: participants.includes('user'), scene: bubble.query,
              kind, settings,
            })
            imageAssetId = asset.id
            imagePayload = { assetId: asset.id, query: bubble.query, provider: asset.provider }
          } catch (error) { console.warn('[media] 创建图片任务失败', error); imageFailed = true }
        }
      }
      if (bubble.type === 'image' && imageFailed) content = '图片没发出来…'
      const msg: Message = {
        id: messageId,
        conversationId,
        role: 'assistant',
        type: executionError ? 'text' : bubble.type === 'loanDecision'
          ? 'loanResult'
          : bubble.type === 'giftPurchase'
            ? 'gift'
            : (bubble.type === 'image' && imageFailed) || (bubble.type === 'sticker' && stickerFailed)
              ? 'text'
              : bubble.type,
        content,
        link: !executionError && bubble.type === 'link' ? {
          app: bubble.app,
          label: bubble.label,
          data: bubble.app === 'contact_recommendation'
            ? { ...bubble.data, recommenderContactId: contact.id, recommenderName: displayName(contact), status: 'pending' }
            : bubble.data,
        } : undefined,
        scheduleChange:
          !executionError && bubble.type === 'scheduleChange'
            ? {
                date: bubble.date,
                startHour: bubble.startHour,
                endHour: bubble.endHour,
                phoneAccess: bubble.phoneAccess,
                location: bubble.location,
                locationId: bubble.locationId,
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
        createdAt: messageCreatedAt,
      }
      if (turnThought && i === bubbles.length - 1) {
        console.log(`[chat] 想法已存入消息: ${turnThought}`)
      }
      await db.messages.add(msg)
      if (imageAssetId) startMediaAsset(imageAssetId)
      if (i === 0) onFirstBubble?.()
      if (remoteSticker) void trackRemoteStickerSend(remoteSticker)
      await db.conversations.update(conversationId, { updatedAt: messageCreatedAt })

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
        if (internalTask) {
          const taskCreatedAt = await nextMessageTimestamp(conversationId, messageCreatedAt + 1)
          const taskMessage: Message = {
            id: uuid(), conversationId, role: 'assistant', type: 'internalTask',
            content: `${internalTask.presentation.activity} · ${internalTask.presentation.locationName}`,
            internalTask: { taskId: internalTask.id, status: internalTask.status, presentation: internalTask.presentation },
            createdAt: taskCreatedAt,
          }
          await db.messages.add(taskMessage)
          await db.conversations.update(conversationId, { updatedAt: taskCreatedAt })
        }
        useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined })
        const memoryUpdate = directOutput ? null : await maybeUpdateMemory(contact.id, conversationId, settings)
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
            mood: { text: turnMood, expiresAt: turnNow + settings.moodExpiryMs },
          })
        }
          }
    },
    onError: (error) => console.error('[chat] 气泡写入失败', error),
    onComplete: () => useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined }),
  })
}


