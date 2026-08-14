import { db } from '../db/db'
import { parseJsonLoose } from './aiProtocol'
import { getConversationRuntimeState, stopAiTurn, triggerAiTurn } from './chatEngine'
import { chatCompletionText } from './deepseek'
import { USER_WALLET_ID } from './finance'
import { useChatUiStore } from '../store/useChatUiStore'
import type { AiBubble, AiTestCardRecord, AiTurnDebug, AppSettings, Contact, Message, PromptTrace, Sticker, WalletAccount } from '../types'

export const AI_TEST_SCENARIOS = [
  { id: 'daily', label: '日常闲聊', description: '自然、连续的生活化对话，观察语气和关系感。' },
  { id: 'money', label: '涉及金钱的对话', description: '借钱、转账、预算或礼物等需要谨慎处理的情境。' },
  { id: 'schedule', label: '涉及日程冲突的对话', description: '用已有日程制造时间冲突、改约与追问。' },
  { id: 'persona', label: '长对话人设一致性', description: '连续多轮换话题，观察身份、性格和口吻是否稳定。' },
  { id: 'memory', label: '记忆与世界书召回', description: '自然触及联系人记忆、共同经历和世界书设定。' },
] as const

export type AiTestScenarioId = (typeof AI_TEST_SCENARIOS)[number]['id']

export interface GeneratedAiTestCase {
  id: string
  description: string
  userMessage: string
}

export interface AiTestContextSummary {
  worldbookEntries: string[]
  memorySummary: string
  sections: Array<{ label: string; summary: string }>
}

export interface CompletedAiTestCase extends GeneratedAiTestCase {
  reply: string
  context: AiTestContextSummary
  aiTurnId: string
  diagnostics?: AiTestCardRecord['diagnostics']
}

export interface AiTestCleanupResult {
  total: number
  contacts: number
  conversations: number
  messages: number
  memories: number
  financeRecords: number
  other: number
}

interface GeneratedPayload {
  cases?: Array<{ description?: unknown; userMessage?: unknown }>
}

export interface SandboxIds {
  contactId: string
  conversationId: string
  memoryIds: string[]
  experienceIds: string[]
  lifeEventIds: string[]
  loanIds: string[]
}

function shortText(value: string, max = 600): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

export async function generateAiTestCases(
  contact: Contact,
  scenarioId: AiTestScenarioId,
  count: number,
  settings: AppSettings,
): Promise<GeneratedAiTestCase[]> {
  const scenario = AI_TEST_SCENARIOS.find((item) => item.id === scenarioId) ?? AI_TEST_SCENARIOS[0]
  const safeCount = Math.max(5, Math.min(20, Math.floor(count)))
  const usageIdsBefore = new Set((await db.aiUsageRecords.toCollection().primaryKeys()).map(String))
  const traceIdsBefore = new Set((await db.adminAiTraces.toCollection().primaryKeys()).map(String))
  try {
    const raw = await chatCompletionText({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel || settings.model,
      messages: [
        {
          role: 'system',
          content: `你是聊天软件的人工评测用例设计员。只负责生成模拟用户消息，不评价回复好坏。\n
输出严格 JSON：{"cases":[{"description":"本轮想测试什么","userMessage":"用户实际发送的话"}]}。\n
要求：恰好 ${safeCount} 条；消息要像真人聊天；各轮按顺序构成可连续进行的对话；不要在消息里解释测试目的；不要要求模型自我评价。`,
        },
        {
          role: 'user',
          content: `联系人：${contact.name}\n关系：${contact.relationshipBase || '朋友'}\n场景：${scenario.label}（${scenario.description}）\n人物设定摘要：${shortText(contact.systemPrompt, 1200)}\n记忆摘要：${shortText(contact.memoryFacts || '暂无', 800)}`,
        },
      ],
      jsonMode: true,
      thinking: 'disabled',
      temperature: 0.8,
      maxTokens: 1800,
      purpose: 'other',
    })
    const parsed = parseJsonLoose<GeneratedPayload>(raw)
    const cases = parsed?.cases?.flatMap((item) => {
      const description = typeof item.description === 'string' ? item.description.trim() : ''
      const userMessage = typeof item.userMessage === 'string' ? item.userMessage.trim() : ''
      return description && userMessage ? [{ id: crypto.randomUUID(), description, userMessage }] : []
    }) ?? []
    if (cases.length < 5) throw new Error(`AI 只生成了 ${cases.length} 条有效用例，请重新生成。`)
    return cases.slice(0, safeCount)
  } finally {
    const newUsageIds = (await db.aiUsageRecords.toCollection().primaryKeys()).filter((id) => !usageIdsBefore.has(String(id)))
    const newTraceIds = (await db.adminAiTraces.toCollection().primaryKeys()).filter((id) => !traceIdsBefore.has(String(id)))
    if (newUsageIds.length) await db.aiUsageRecords.bulkDelete(newUsageIds)
    if (newTraceIds.length) await db.adminAiTraces.bulkDelete(newTraceIds)
  }
}

export async function createSandbox(source: Contact): Promise<SandboxIds> {
  const suffix = crypto.randomUUID()
  const contactId = `ai-test-contact-${suffix}`
  const conversationId = `ai-test-conversation-${suffix}`
  const now = Date.now()
  const clone: Contact = {
    ...structuredClone(source),
    id: contactId,
    createdAt: now,
    pendingEvents: [],
    lastProactiveMessageAt: undefined,
  }
  await db.contacts.add(clone)
  await db.conversations.add({ id: conversationId, contactId, pinned: false, createdAt: now, updatedAt: now })

  const sourceMemories = await db.contactMemories.where('contactId').equals(source.id).toArray()
  const memories = sourceMemories.map((memory) => ({
    ...structuredClone(memory),
    id: `ai-test-memory-${crypto.randomUUID()}`,
    contactId,
    relatedContactIds: memory.relatedContactIds?.map((id) => id === source.id ? contactId : id),
  }))
  if (memories.length) await db.contactMemories.bulkAdd(memories)

  const sourceExperiences = await db.contactExperiences.where('contactIds').equals(source.id).toArray()
  const experiences = sourceExperiences.map((experience) => ({
    ...structuredClone(experience),
    id: `ai-test-experience-${crypto.randomUUID()}`,
    contactIds: experience.contactIds.map((id) => id === source.id ? contactId : id),
  }))
  if (experiences.length) await db.contactExperiences.bulkAdd(experiences)

  const sourceLifeEvents = await db.lifeEvents.where('contactId').equals(source.id).toArray()
  const lifeEvents = sourceLifeEvents.map((event) => ({
    ...structuredClone(event),
    id: `ai-test-life-event-${crypto.randomUUID()}`,
    contactId,
    participantContactIds: event.participantContactIds.map((id) => id === source.id ? contactId : id),
  }))
  if (lifeEvents.length) await db.lifeEvents.bulkAdd(lifeEvents)

  const sourceWallet = await db.walletAccounts.get(source.id)
  if (sourceWallet) await db.walletAccounts.put({ ...sourceWallet, ownerId: contactId })
  const sourceLoans = await db.loans.filter((loan) => loan.lenderId === source.id || loan.borrowerId === source.id).toArray()
  const loans = sourceLoans.map((loan) => ({
    ...structuredClone(loan),
    id: `ai-test-loan-${crypto.randomUUID()}`,
    lenderId: loan.lenderId === source.id ? contactId : loan.lenderId,
    borrowerId: loan.borrowerId === source.id ? contactId : loan.borrowerId,
  }))
  if (loans.length) await db.loans.bulkAdd(loans)

  return {
    contactId,
    conversationId,
    memoryIds: memories.map((item) => item.id),
    experienceIds: experiences.map((item) => item.id),
    lifeEventIds: lifeEvents.map((item) => item.id),
    loanIds: loans.map((item) => item.id),
  }
}

function bubbleText(bubble: AiBubble): string {
  if (bubble.type === 'text') return bubble.content
  if (bubble.type === 'sticker') return `[表情：${bubble.name}]`
  if (bubble.type === 'image') return `[图片：${bubble.caption || bubble.query}]`
  if (bubble.type === 'scheduleChange') return `[日程变更：${bubble.summary}]`
  if (bubble.type === 'link') return `[链接：${bubble.label}]`
  if (bubble.type === 'giftPurchase') return `[礼物：${bubble.name || bubble.description || bubble.amount}]`
  if (bubble.type === 'loanDecision') return `[借款决定：${bubble.decision || ''} ${bubble.amount}]`
  return `[${bubble.type}：${bubble.amount}${bubble.note ? `，${bubble.note}` : ''}]`
}

function readParsed(turn: AiTurnDebug): Record<string, unknown> {
  return turn.parsed && typeof turn.parsed === 'object' ? turn.parsed as Record<string, unknown> : {}
}

export function resultFromTurn(testCase: GeneratedAiTestCase, turn: AiTurnDebug, messages: Message[]): CompletedAiTestCase {
  const parsed = readParsed(turn)
  const bubbles = Array.isArray(parsed.parsedBubbles) ? parsed.parsedBubbles as AiBubble[] : []
  const promptTrace = parsed.promptTrace && typeof parsed.promptTrace === 'object' ? parsed.promptTrace as PromptTrace : undefined
  const reply = messages.length
    ? messages.map((message) => message.content).join('\n')
    : bubbles.map(bubbleText).join('\n')
  const sections = (promptTrace?.sections ?? [])
    .filter((section) => section.content.trim())
    .map((section) => ({ label: section.label, summary: shortText(section.content) }))
  return {
    ...testCase,
    aiTurnId: turn.id,
    reply: reply || '(该轮没有可展示的回复)',
    context: {
      worldbookEntries: promptTrace?.worldbookMatches?.map((item) => item.title) ?? [],
      memorySummary: shortText(promptTrace?.memorySummary ?? ''),
      sections,
    },
    diagnostics: {
      mainPrompt: typeof parsed.mainPrompt === 'string' ? parsed.mainPrompt : undefined,
      conversionPrompt: typeof parsed.conversionPrompt === 'string' ? parsed.conversionPrompt : undefined,
      promptSections: promptTrace?.sections.map((section) => ({ label: section.label, content: section.content })),
      parsedResponse: structuredClone(parsed),
      actionCommittee: parsed.actionCommittee ? structuredClone(parsed.actionCommittee) : undefined,
    },
  }
}

export async function waitForTurn(conversationId: string, knownTurnIds: Set<string>, signal?: AbortSignal): Promise<AiTurnDebug> {
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('测试已取消', 'AbortError')
    const runtime = getConversationRuntimeState(conversationId)
    if (runtime.error) throw new Error(runtime.error)
    const turns = await db.aiTurns.where('conversationId').equals(conversationId).toArray()
    const turn = turns.find((item) => !knownTurnIds.has(item.id))
    if (turn) {
      while (getConversationRuntimeState(conversationId).aiTyping) {
        if (signal?.aborted) throw new DOMException('测试已取消', 'AbortError')
        if (Date.now() >= deadline) throw new Error('等待气泡写入超时')
        await new Promise((resolve) => window.setTimeout(resolve, 250))
      }
      return turn
    }
    await new Promise((resolve) => window.setTimeout(resolve, 300))
  }
  throw new Error('等待 AI 回复超时；如果启用了真实回复延迟，可关闭后重试。')
}

async function cleanupSandbox(
  ids: SandboxIds,
  usageIdsBefore: Set<string>,
  traceIdsBefore: Set<string>,
  knowledgeIdsBefore: Set<string>,
  userWalletBefore: WalletAccount | undefined,
): Promise<void> {
  stopAiTurn(ids.conversationId)
  const messageIds = await db.messages.where('conversationId').equals(ids.conversationId).primaryKeys()
  const turnIds = await db.aiTurns.where('conversationId').equals(ids.conversationId).primaryKeys()
  const memoryIds = await db.contactMemories.where('contactId').equals(ids.contactId).primaryKeys()
  const experienceIds = await db.contactExperiences.where('contactIds').equals(ids.contactId).primaryKeys()
  const lifeEventIds = await db.lifeEvents.where('contactId').equals(ids.contactId).primaryKeys()
  const tempTransactions = await db.walletTransactions
    .filter((item) => item.fromOwnerId === ids.contactId || item.toOwnerId === ids.contactId)
    .primaryKeys()
  const tempLoans = await db.loans
    .filter((item) => item.lenderId === ids.contactId || item.borrowerId === ids.contactId)
    .primaryKeys()
  await Promise.all([
    db.messages.bulkDelete(messageIds),
    db.aiTurns.bulkDelete(turnIds),
    db.contactMemories.bulkDelete([...new Set([...ids.memoryIds, ...memoryIds])]),
    db.contactExperiences.bulkDelete([...new Set([...ids.experienceIds, ...experienceIds])]),
    db.lifeEvents.bulkDelete([...new Set([...ids.lifeEventIds, ...lifeEventIds])]),
    db.walletTransactions.bulkDelete(tempTransactions),
    db.loans.bulkDelete([...new Set([...ids.loanIds, ...tempLoans])]),
  ])
  await db.conversations.delete(ids.conversationId)
  await db.contacts.delete(ids.contactId)
  await db.walletAccounts.delete(ids.contactId)
  if (userWalletBefore) await db.walletAccounts.put(userWalletBefore)
  else await db.walletAccounts.delete(USER_WALLET_ID)

  const newUsageIds = (await db.aiUsageRecords.toCollection().primaryKeys()).filter((id) => !usageIdsBefore.has(String(id)))
  const newTraceIds = (await db.adminAiTraces.toCollection().primaryKeys()).filter((id) => !traceIdsBefore.has(String(id)))
  const newKnowledgeIds = (await db.knowledgeEntries.toCollection().primaryKeys()).filter((id) => !knowledgeIdsBefore.has(String(id)))
  if (newUsageIds.length) await db.aiUsageRecords.bulkDelete(newUsageIds)
  if (newTraceIds.length) await db.adminAiTraces.bulkDelete(newTraceIds)
  if (newKnowledgeIds.length) await db.knowledgeEntries.bulkDelete(newKnowledgeIds)
}

export async function runAiTestSuite(options: {
  contact: Contact
  cases: GeneratedAiTestCase[]
  settings: AppSettings
  stickers: Sticker[]
  signal?: AbortSignal
  onProgress?: (index: number, result?: CompletedAiTestCase) => void
}): Promise<CompletedAiTestCase[]> {
  const usageIdsBefore = new Set((await db.aiUsageRecords.toCollection().primaryKeys()).map(String))
  const traceIdsBefore = new Set((await db.adminAiTraces.toCollection().primaryKeys()).map(String))
  const knowledgeIdsBefore = new Set((await db.knowledgeEntries.toCollection().primaryKeys()).map(String))
  const userWalletBefore = await db.walletAccounts.get(USER_WALLET_ID)
  const ids = await createSandbox(options.contact)
  const sandboxContact = await db.contacts.get(ids.contactId)
  if (!sandboxContact) throw new Error('无法创建测试联系人副本')
  const previousActiveConversation = useChatUiStore.getState().activeConversationId
  useChatUiStore.getState().setActiveConversation(ids.conversationId)
  const settings: AppSettings = {
    ...options.settings,
    stickerProvider: 'none',
    imageProvider: 'none',
    pexelsApiKey: '',
  }
  const results: CompletedAiTestCase[] = []
  const knownTurnIds = new Set<string>()
  try {
    for (let index = 0; index < options.cases.length; index += 1) {
      const testCase = options.cases[index]
      if (options.signal?.aborted) throw new DOMException('测试已取消', 'AbortError')
      options.onProgress?.(index)
      const createdAt = Date.now() + index
      await db.messages.add({
        id: `ai-test-message-${crypto.randomUUID()}`,
        conversationId: ids.conversationId,
        role: 'user',
        type: 'text',
        content: testCase.userMessage,
        createdAt,
      })
      await db.conversations.update(ids.conversationId, { updatedAt: createdAt })
      const currentSandboxContact = await db.contacts.get(ids.contactId)
      if (!currentSandboxContact) throw new Error('测试联系人副本意外丢失')
      await triggerAiTurn(ids.conversationId, currentSandboxContact, settings, options.stickers)
      const turn = await waitForTurn(ids.conversationId, knownTurnIds, options.signal)
      knownTurnIds.add(turn.id)
      const messages = await db.messages
        .where('conversationId')
        .equals(ids.conversationId)
        .filter((message) => message.role === 'assistant' && message.debugAiTurnId === turn.id)
        .sortBy('createdAt')
      const result = resultFromTurn(testCase, turn, messages)
      if (userWalletBefore) await db.walletAccounts.put(userWalletBefore)
      else await db.walletAccounts.delete(USER_WALLET_ID)
      results.push(result)
      options.onProgress?.(index, result)
    }
    return results
  } finally {
    useChatUiStore.getState().setActiveConversation(previousActiveConversation)
    useChatUiStore.getState().dismissNotification()
    await cleanupSandbox(ids, usageIdsBefore, traceIdsBefore, knowledgeIdsBefore, userWalletBefore)
  }
}

const isAiTestId = (value: unknown): value is string => typeof value === 'string' && value.startsWith('ai-test-')

/** Removes test sandboxes left behind when the browser process was killed before a suite's finally block ran. */
export async function cleanupResidualAiTestData(): Promise<AiTestCleanupResult> {
  const [allContacts, allConversations, allGroups, allAccounts, allTransactions, allLoans, allMemories, allExperiences, allLifeEvents] = await Promise.all([
    db.contacts.toArray(),
    db.conversations.toArray(),
    db.groups.toArray(),
    db.walletAccounts.toArray(),
    db.walletTransactions.toArray(),
    db.loans.toArray(),
    db.contactMemories.toArray(),
    db.contactExperiences.toArray(),
    db.lifeEvents.toArray(),
  ])
  const temporaryContacts = allContacts.filter((item) => isAiTestId(item.id))
  const temporaryAccounts = allAccounts.filter((item) => isAiTestId(item.ownerId))
  const temporaryGroups = allGroups.filter((item) => isAiTestId(item.id))
  const temporaryGroupIds = new Set(temporaryGroups.map((item) => item.id))
  const temporaryContactIds = new Set([
    ...temporaryContacts.map((item) => item.id),
    ...allConversations.filter((item) => isAiTestId(item.contactId)).flatMap((item) => item.contactId ? [item.contactId] : []),
    ...temporaryAccounts.map((item) => item.ownerId),
    ...allTransactions.flatMap((item) => [item.fromOwnerId, item.toOwnerId].filter(isAiTestId)),
    ...allLoans.flatMap((item) => [item.lenderId, item.borrowerId].filter(isAiTestId)),
    ...allMemories.filter((item) => isAiTestId(item.contactId)).map((item) => item.contactId),
    ...allExperiences.flatMap((item) => item.contactIds.filter(isAiTestId)),
    ...allLifeEvents.flatMap((item) => [item.contactId, ...item.participantContactIds].filter(isAiTestId)),
  ])
  const temporaryConversationIds = new Set(allConversations
    .filter((item) => isAiTestId(item.id) || (item.contactId ? temporaryContactIds.has(item.contactId) : false) || (item.groupId ? temporaryGroupIds.has(item.groupId) : false))
    .map((item) => item.id))

  for (const conversationId of temporaryConversationIds) stopAiTurn(conversationId)

  const [messages, turns, memories, experiences, lifeEvents, lifeStates, relations, socialEvents, traces, transactions, loans, groupPlans] = await Promise.all([
    db.messages.filter((item) => isAiTestId(item.id) || temporaryConversationIds.has(item.conversationId)).toArray(),
    db.aiTurns.filter((item) => isAiTestId(item.id) || temporaryConversationIds.has(item.conversationId)).toArray(),
    Promise.resolve(allMemories.filter((item) => isAiTestId(item.id) || temporaryContactIds.has(item.contactId))),
    Promise.resolve(allExperiences.filter((item) => isAiTestId(item.id) || item.contactIds.some((id) => temporaryContactIds.has(id)))),
    Promise.resolve(allLifeEvents.filter((item) => isAiTestId(item.id) || temporaryContactIds.has(item.contactId) || item.participantContactIds.some((id) => temporaryContactIds.has(id)))),
    db.contactLifeStates.filter((item) => temporaryContactIds.has(item.contactId)).toArray(),
    db.contactRelations.filter((item) => isAiTestId(item.id) || temporaryContactIds.has(item.fromContactId) || temporaryContactIds.has(item.toContactId)).toArray(),
    db.socialEvents.filter((item) => isAiTestId(item.id) || temporaryContactIds.has(item.actorId) || (item.targetId ? temporaryContactIds.has(item.targetId) : false) || item.relatedContactIds.some((id) => temporaryContactIds.has(id))).toArray(),
    db.adminAiTraces.filter((item) => isAiTestId(item.id) || (item.conversationId ? temporaryConversationIds.has(item.conversationId) : false)).toArray(),
    Promise.resolve(allTransactions.filter((item) => isAiTestId(item.id) || isAiTestId(item.idempotencyKey) || (item.fromOwnerId ? temporaryContactIds.has(item.fromOwnerId) : false) || (item.toOwnerId ? temporaryContactIds.has(item.toOwnerId) : false))),
    Promise.resolve(allLoans.filter((item) => isAiTestId(item.id) || temporaryContactIds.has(item.lenderId) || temporaryContactIds.has(item.borrowerId))),
    db.groupPlans.filter((item) => isAiTestId(item.id) || temporaryGroupIds.has(item.groupId)).toArray(),
  ])

  // A crash can happen after a test transfer changed the real user's balance.
  // Reverse only the non-test side of transactions tied to a temporary owner.
  for (const transaction of transactions) {
    if (transaction.status === 'cancelled') continue
    if (transaction.fromOwnerId && !temporaryContactIds.has(transaction.fromOwnerId) && transaction.toOwnerId && temporaryContactIds.has(transaction.toOwnerId)) {
      const account = await db.walletAccounts.get(transaction.fromOwnerId)
      if (account) await db.walletAccounts.update(account.ownerId, { balance: account.balance + transaction.amount, updatedAt: Date.now() })
    }
    if (transaction.toOwnerId && !temporaryContactIds.has(transaction.toOwnerId) && transaction.fromOwnerId && temporaryContactIds.has(transaction.fromOwnerId) && transaction.status === 'completed') {
      const account = await db.walletAccounts.get(transaction.toOwnerId)
      if (account) await db.walletAccounts.update(account.ownerId, { balance: Math.max(0, account.balance - transaction.amount), updatedAt: Date.now() })
    }
  }

  await Promise.all([
    db.messages.bulkDelete(messages.map((item) => item.id)),
    db.aiTurns.bulkDelete(turns.map((item) => item.id)),
    db.contactMemories.bulkDelete(memories.map((item) => item.id)),
    db.contactExperiences.bulkDelete(experiences.map((item) => item.id)),
    db.lifeEvents.bulkDelete(lifeEvents.map((item) => item.id)),
    db.contactLifeStates.bulkDelete(lifeStates.map((item) => item.contactId)),
    db.contactRelations.bulkDelete(relations.map((item) => item.id)),
    db.socialEvents.bulkDelete(socialEvents.map((item) => item.id)),
    db.adminAiTraces.bulkDelete(traces.map((item) => item.id)),
    db.walletTransactions.bulkDelete(transactions.map((item) => item.id)),
    db.loans.bulkDelete(loans.map((item) => item.id)),
    db.groupPlans.bulkDelete(groupPlans.map((item) => item.id)),
    db.walletAccounts.bulkDelete([...temporaryContactIds]),
    db.conversations.bulkDelete([...temporaryConversationIds]),
    db.groups.bulkDelete([...temporaryGroupIds]),
    db.contacts.bulkDelete([...temporaryContactIds]),
  ])

  const result = {
    contacts: temporaryContacts.length,
    conversations: temporaryConversationIds.size,
    messages: messages.length,
    memories: memories.length + experiences.length + lifeEvents.length + lifeStates.length,
    financeRecords: temporaryAccounts.length + transactions.length + loans.length,
    other: turns.length + relations.length + socialEvents.length + traces.length + temporaryGroups.length + groupPlans.length,
  }
  return { ...result, total: Object.values(result).reduce((sum, value) => sum + value, 0) }
}
