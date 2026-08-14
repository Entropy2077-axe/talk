import { db } from '../db/db'
import { parseJsonLoose } from './aiProtocol'
import { createSandbox, resultFromTurn, waitForTurn, type CompletedAiTestCase, type GeneratedAiTestCase } from './aiTestCards'
import { sendMessage, stopAiTurn } from './chatEngine'
import { chatCompletionText } from './deepseek'
import { sendGroupMessage, stopGroupAiTurn } from './groupChatEngine'
import { useSettingsStore } from '../store/useSettingsStore'
import { USER_WALLET_ID } from './finance'
import { runMomentTestSandbox } from './moments'
import { isModuleEnabled } from '../features'
import { ensureLocationsInitialized, isLeafLocation, resolveContactRuntimeAt, syncContactLocationAt } from './locations'
import { resolveActiveTask } from './schedule'
import type { AiTestCardRecord, AiTestKind, AiTestSuiteRecord, AiTurnDebug, AppSettings, Contact, Group, Sticker } from '../types'

export const AI_TEST_KINDS: Array<{ id: AiTestKind; label: string; mode: 'sequential' | 'isolated'; description: string }> = [
  { id: 'conversation', label: '连续私聊逻辑', mode: 'sequential', description: '在一个联系人副本中连续运行多轮，检查长期人设、记忆和上下文逻辑。' },
  { id: 'group', label: '连续群聊逻辑', mode: 'sequential', description: '复制群和群成员，在同一个临时群聊中连续测试发言与角色区分。' },
  { id: 'moments', label: '朋友圈 JSON', mode: 'isolated', description: '每条用例使用独立副本，检查朋友圈内容 JSON 是否正常生成。' },
  { id: 'sticker', label: '表情包 JSON', mode: 'isolated', description: '每条用例独立检查表情包类型和名称是否正确返回。' },
  { id: 'transfer', label: '转账 JSON', mode: 'isolated', description: '每条用例独立检查金额类结构化消息。' },
  { id: 'gift', label: '发礼物 JSON', mode: 'isolated', description: '每条用例独立检查礼物结构化消息。' },
  { id: 'image', label: '生图 JSON', mode: 'isolated', description: '每条用例独立检查图片查询词和说明字段。' },
  { id: 'locationSchedule', label: '切换地点与日程 JSON', mode: 'isolated', description: '每条用例使用独立副本，检查聊天约定是否正确写入特殊日程并绑定具体地点。' },
]

const activeRuns = new Map<string, AbortController>()

function shortText(value: string, max = 1000): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function diagnosticSnapshot(value: unknown, key = ''): unknown {
  if (/api.?key|secret|password|access.?token|refresh.?token/i.test(key)) return '[已移除凭据]'
  if (typeof value === 'function') return '[已省略函数]'
  if (typeof value === 'string' && value.startsWith('data:')) return `[已省略 data URL，长度 ${value.length}]`
  if (Array.isArray(value)) return value.map((item) => diagnosticSnapshot(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, diagnosticSnapshot(child, childKey)]))
  return value
}

function targetPrompt(contact: Contact, settings: AppSettings): string {
  return [
    `真实用户：${settings.userNickname || '用户'}`,
    settings.userOccupation ? `真实用户职业：${settings.userOccupation}` : '真实用户职业：未设置',
    settings.userBio ? `真实用户简介：${shortText(settings.userBio, 400)}` : '',
    `被测试联系人：${contact.name}`,
    contact.occupation ? `被测试联系人职业：${contact.occupation}` : '',
    `双方关系：${contact.relationshipBase || '朋友'}`,
    `联系人设定：${shortText(contact.systemPrompt, 1400)}`,
    `记忆摘要：${shortText(contact.memoryFacts || '暂无', 700)}`,
  ].filter(Boolean).join('\n')
}

function generationSystemPrompt(kind: AiTestKind, count: number): string {
  const protocol = `只输出JSON：{"cases":[{"description":"测试目的","userMessage":"输入内容"}]}，恰好${count}条。不要评价结果。`
  if (kind === 'conversation') return `${protocol}\n这些消息是同一位真实用户按顺序发给联系人的连续长对话，必须承接前文并逐步换话题。消息发送者永远是真实用户，绝不能代入联系人的职业、经历或身份。联系人是医生时，用户可以问诊或聊天，但不得声称自己接诊病人，除非真实用户资料明确写着医生。消息必须像聊天软件里的真人短消息。`
  if (kind === 'group') return `${protocol}\n这些消息是同一位真实用户按顺序发进同一个群的连续对话，要自然承接前文，并能观察不同成员是否保持各自身份。userMessage只能是用户在群里会说的话，不能冒充任何群成员。`
  if (kind === 'locationSchedule') return `${protocol}\n每条用例都在独立联系人副本中运行，用自然聊天测试角色如何回应线下安排，以及系统能否根据角色的真实回复正确决定是否写入特殊日程并绑定地点。混合覆盖：可能接受的邀请、可能拒绝的邀请、仅讨论或考虑、缺少精确时间、地点不存在、与默认日程重叠、相对时间和分钟级时间。除非description明确写的是“测试过期时间防护”，所有具体或相对时间都必须严格晚于提供的设备当前时间且在十四天内，不能生成已经过去的“今天/本周”时间。角色的实际回复具有不确定性，所以description只能中性描述“要测试的情境和能力”，例如“测试周六早起跑步邀请及默认日程冲突处理”；严禁写“应创建日程”“不应创建日程”“角色会同意”“角色会拒绝”等执行前预判。userMessage不能命令角色输出JSON。每条用例互不依赖。`
  const feature: Record<Exclude<AiTestKind, 'conversation' | 'group'>, string> = {
    moments: '每条是互相独立的朋友圈生成主题，用于要求被测试联系人生成一条朋友圈JSON。',
    sticker: '每条是互相独立的聊天情境，要自然诱发表情包回复，但不要在用户消息里命令输出JSON。',
    transfer: '每条是互相独立的金钱情境，要自然测试转账、红包或借款结构化回复。',
    gift: '每条是互相独立的送礼情境，要自然测试联系人购买并发送礼物的结构化回复。',
    image: '每条是互相独立的看图或发图情境，要自然测试图片结构化回复。',
    locationSchedule: '',
  }
  return `${protocol}\n${feature[kind as Exclude<AiTestKind, 'conversation' | 'group'>]}每条用例互不依赖。消息发送者永远是真实用户，不能代入被测试联系人的职业和人生经历。`
}

export async function createAiTestSuite(options: {
  kind: AiTestKind
  count: number
  scenarioLabel: string
  contact?: Contact
  group?: Group
  groupMembers?: Contact[]
  settings: AppSettings
}): Promise<AiTestSuiteRecord> {
  const definition = AI_TEST_KINDS.find((item) => item.id === options.kind)!
  const max = definition.mode === 'sequential' ? 50 : 20
  const count = Math.max(5, Math.min(max, Math.floor(options.count)))
  if (options.kind === 'group' && (!options.group || !options.groupMembers?.length)) throw new Error('请选择一个有效群聊')
  if (options.kind !== 'group' && !options.contact) throw new Error('请选择联系人')
  if (options.kind === 'locationSchedule' && !isModuleEnabled('location')) throw new Error('请先启用地点模块，再创建地点与日程测试。')
  let locationTarget = ''
  let locationEnvironment: AiTestSuiteRecord['environmentSnapshot']
  if (options.kind === 'locationSchedule') {
    await ensureLocationsInitialized()
    const locations = await db.locations.toArray()
    const leaves = locations.filter((location) => isLeafLocation(location.id, locations))
    locationEnvironment = { locations: locations.map(({ id, name, parentId }) => ({ id, name, parentId })) }
    locationTarget = `\n设备当前时间：${new Date().toLocaleString()}\n联系人当前地点ID：${options.contact!.currentLocationId || '未知'}\n联系人默认日程与特殊日程：${JSON.stringify({ schedule: options.contact!.schedule ?? [], scheduleOverrides: options.contact!.scheduleOverrides ?? [] })}\n合法具体地点：${leaves.map((location) => `${location.id}=${location.name}`).join('；')}`
  }
  const target = options.kind === 'group'
    ? `群聊：${options.group!.name}\n成员：${options.groupMembers!.map((item) => `${item.name}（${item.occupation || '未设置职业'}）`).join('、')}`
    : `${targetPrompt(options.contact!, options.settings)}${locationTarget}`
  const raw = await chatCompletionText({
    apiKey: options.settings.apiKey,
    baseUrl: options.settings.baseUrl,
    model: options.settings.utilityModel || options.settings.model,
    messages: [
      { role: 'system', content: generationSystemPrompt(options.kind, count) },
      { role: 'user', content: `${target}\n测试主题：${options.scenarioLabel}` },
    ],
    jsonMode: true,
    thinking: 'disabled',
    temperature: 0.75,
    maxTokens: Math.min(5000, 500 + count * 150),
    purpose: 'other',
  })
  const parsed = parseJsonLoose<{ cases?: Array<{ description?: unknown; userMessage?: unknown }> }>(raw)
  const generated = parsed?.cases?.flatMap((item, order) => {
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    const userMessage = typeof item.userMessage === 'string' ? item.userMessage.trim() : ''
    return description && userMessage ? [{ id: crypto.randomUUID(), order, description, userMessage, status: 'pending' as const }] : []
  }) ?? []
  if (generated.length < 5) throw new Error(`AI 只生成了 ${generated.length} 条有效用例，请重新生成。`)
  const now = Date.now()
  const suite: AiTestSuiteRecord = {
    id: crypto.randomUUID(),
    kind: options.kind,
    executionMode: definition.mode,
    status: 'draft',
    title: `${definition.label} · ${options.kind === 'group' ? options.group!.name : options.contact!.remark || options.contact!.name}`,
    scenarioLabel: options.scenarioLabel,
    targetContactId: options.contact?.id,
    targetGroupId: options.group?.id,
    targetLabel: options.kind === 'group' ? options.group!.name : options.contact!.remark || options.contact!.name,
    targetSnapshot: structuredClone(options.kind === 'group' ? { group: options.group, members: options.groupMembers } : options.contact),
    settingsSnapshot: diagnosticSnapshot(options.settings),
    environmentSnapshot: locationEnvironment,
    cards: generated.slice(0, count),
    createdAt: now,
    updatedAt: now,
  }
  await db.aiTestSuites.add(suite)
  return suite
}

async function updateCard(suite: AiTestSuiteRecord, index: number, patch: Partial<AiTestCardRecord>) {
  suite.cards = suite.cards.map((card, cardIndex) => cardIndex === index ? { ...card, ...patch } : card)
  suite.currentCardIndex = index
  suite.updatedAt = Date.now()
  await db.aiTestSuites.update(suite.id, { cards: suite.cards, currentCardIndex: index, updatedAt: suite.updatedAt })
}

async function createGroupSandbox(group: Group, members: Contact[]) {
  const memberIdMap = new Map(members.map((member) => [member.id, `ai-test-contact-${crypto.randomUUID()}`]))
  const clones = members.map((member) => ({ ...structuredClone(member), id: memberIdMap.get(member.id)!, pendingEvents: [] }))
  const groupId = `ai-test-group-${crypto.randomUUID()}`
  const conversationId = `ai-test-conversation-${crypto.randomUUID()}`
  const groupClone: Group = { ...structuredClone(group), id: groupId, memberContactIds: clones.map((item) => item.id), createdAt: Date.now() }
  await db.contacts.bulkAdd(clones)
  const sourceIds = new Set(members.map((item) => item.id))
  const memories = (await db.contactMemories.filter((item) => sourceIds.has(item.contactId)).toArray()).map((item) => ({
    ...structuredClone(item), id: `ai-test-memory-${crypto.randomUUID()}`, contactId: memberIdMap.get(item.contactId)!,
    relatedContactIds: item.relatedContactIds?.map((id) => memberIdMap.get(id) ?? id),
  }))
  const experiences = (await db.contactExperiences.filter((item) => item.contactIds.some((id) => sourceIds.has(id))).toArray()).map((item) => ({
    ...structuredClone(item), id: `ai-test-experience-${crypto.randomUUID()}`, contactIds: item.contactIds.map((id) => memberIdMap.get(id) ?? id),
  }))
  const lifeEvents = (await db.lifeEvents.filter((item) => sourceIds.has(item.contactId) || item.participantContactIds.some((id) => sourceIds.has(id))).toArray()).map((item) => ({
    ...structuredClone(item), id: `ai-test-life-event-${crypto.randomUUID()}`, contactId: memberIdMap.get(item.contactId) ?? item.contactId,
    participantContactIds: item.participantContactIds.map((id) => memberIdMap.get(id) ?? id),
  }))
  const relations = (await db.contactRelations.filter((item) => sourceIds.has(item.fromContactId) && sourceIds.has(item.toContactId)).toArray()).map((item) => ({
    ...structuredClone(item), id: `ai-test-relation-${crypto.randomUUID()}`, pairId: `ai-test-pair-${crypto.randomUUID()}`,
    fromContactId: memberIdMap.get(item.fromContactId)!, toContactId: memberIdMap.get(item.toContactId)!,
  }))
  if (memories.length) await db.contactMemories.bulkAdd(memories)
  if (experiences.length) await db.contactExperiences.bulkAdd(experiences)
  if (lifeEvents.length) await db.lifeEvents.bulkAdd(lifeEvents)
  if (relations.length) await db.contactRelations.bulkAdd(relations)
  await db.groups.add(groupClone)
  await db.conversations.add({ id: conversationId, groupId, pinned: false, createdAt: Date.now(), updatedAt: Date.now() })
  return { members: clones, group: groupClone, conversationId }
}

async function runChatCard(suite: AiTestSuiteRecord, index: number, contact: Contact, conversationId: string, stickers: Sticker[], settings: AppSettings, signal: AbortSignal, knownTurns: Set<string>) {
  const card = suite.cards[index]
  const beforeContact = suite.kind === 'locationSchedule' ? await db.contacts.get(contact.id) : undefined
  const userWalletBefore = await db.walletAccounts.get(USER_WALLET_ID)
  await updateCard(suite, index, { status: 'running', cloneContactIds: [contact.id], conversationId })
  let turn: AiTurnDebug | undefined
  let result: CompletedAiTestCase | undefined
  try {
    await sendMessage(conversationId, contact, settings, stickers, card.userMessage)
    turn = await waitForTurn(conversationId, knownTurns, signal)
    knownTurns.add(turn.id)
    const messages = await db.messages.where('conversationId').equals(conversationId).filter((item) => item.role === 'assistant' && item.debugAiTurnId === turn!.id).sortBy('createdAt')
    result = resultFromTurn(card as GeneratedAiTestCase, turn, messages)
    if (suite.kind === 'locationSchedule') {
      await syncContactLocationAt(contact.id, new Date())
      const [afterContact, locations] = await Promise.all([db.contacts.get(contact.id), db.locations.toArray()])
      if (!beforeContact || !afterContact) throw new Error('无法读取地点日程测试副本状态')
      const beforeIds = new Set((beforeContact.scheduleOverrides ?? []).map((item) => item.id))
      const addedScheduleOverrides = (afterContact.scheduleOverrides ?? []).filter((item) => !beforeIds.has(item.id))
      const validLeafIds = new Set(locations.filter((location) => isLeafLocation(location.id, locations)).map((location) => location.id))
      const locationById = new Map(locations.map((location) => [location.id, location]))
      const active = resolveActiveTask(afterContact, new Date())
      const scheduledTaskLocationChecks = addedScheduleOverrides.map((task) => {
        const startsAt = task.startsAt ?? new Date(`${task.date}T${String(task.startHour).padStart(2, '0')}:00:00`).getTime()
        const endsAt = task.endsAt ?? new Date(`${task.date}T${String(task.endHour % 24).padStart(2, '0')}:00:00`).getTime()
        const resolved = resolveContactRuntimeAt(afterContact, new Date(startsAt), validLeafIds)
        return {
          taskId: task.id, summary: task.summary, startsAt, endsAt,
          expectedLocationId: task.locationId,
          expectedLocationName: task.locationId ? locationById.get(task.locationId)?.name ?? task.location : task.location,
          resolvedLocationId: resolved.locationId,
          resolvedLocationName: locationById.get(resolved.locationId)?.name,
          matches: Boolean(task.locationId && resolved.locationId === task.locationId),
        }
      })
      result.diagnostics = {
        ...result.diagnostics,
        locationSchedule: {
          before: diagnosticSnapshot(beforeContact) as Record<string, unknown>,
          after: diagnosticSnapshot(afterContact) as Record<string, unknown>,
          addedScheduleOverrides,
          currentLocationChange: {
            beforeId: beforeContact.currentLocationId,
            beforeName: beforeContact.currentLocationId ? locationById.get(beforeContact.currentLocationId)?.name : undefined,
            afterId: afterContact.currentLocationId,
            afterName: afterContact.currentLocationId ? locationById.get(afterContact.currentLocationId)?.name : undefined,
          },
          scheduledTaskLocationChecks,
          checks: {
            scheduleChanged: addedScheduleOverrides.length > 0,
            allLocationIdsValid: addedScheduleOverrides.every((item) => Boolean(item.locationId && validLeafIds.has(item.locationId))),
            activeLocationMatchesTask: !active?.task.locationId || afterContact.currentLocationId === active.task.locationId,
            scheduledTasksResolveToExpectedLocations: scheduledTaskLocationChecks.every((item) => item.matches),
          },
        },
      }
    }
  } finally {
    if (userWalletBefore) await db.walletAccounts.put(userWalletBefore)
    else await db.walletAccounts.delete(USER_WALLET_ID)
    const transactionIds = await db.walletTransactions
      .filter((item) => item.fromOwnerId === contact.id || item.toOwnerId === contact.id)
      .primaryKeys()
    if (transactionIds.length) await db.walletTransactions.bulkDelete(transactionIds)
  }
  if (!turn || !result) throw new Error('测试回复未能保存')
  await updateCard(suite, index, { status: 'completed', reply: result.reply, rawResponse: turn.raw, context: result.context, diagnostics: result.diagnostics, aiTurnId: turn.id, completedAt: Date.now() })
}

async function runMomentCard(suite: AiTestSuiteRecord, index: number, contact: Contact, conversationId: string, settings: AppSettings) {
  const card = suite.cards[index]
  await updateCard(suite, index, { status: 'running', cloneContactIds: [contact.id], conversationId })
  const result = await runMomentTestSandbox(contact, settings, card.userMessage)
  await updateCard(suite, index, { status: 'completed', reply: result.reviewedRaw, rawResponse: result.raw, context: { worldbookEntries: [], memorySummary: shortText(contact.memoryFacts || ''), sections: [{ label: '朋友圈生产提示词人物设定', summary: shortText(contact.systemPrompt) }] }, completedAt: Date.now() })
}

async function runSuite(suiteId: string, controller: AbortController) {
  const suite = await db.aiTestSuites.get(suiteId)
  if (!suite) throw new Error('测试批次不存在')
  const settings = useSettingsStore.getState() as AppSettings
  const stickers = await db.stickers.toArray()
  suite.status = 'running'
  suite.error = undefined
  await db.aiTestSuites.update(suite.id, { status: 'running', error: undefined, updatedAt: Date.now() })
  try {
    if (suite.kind === 'group') {
      const snapshot = suite.targetSnapshot as { group: Group; members: Contact[] }
      let group = suite.cards.find((card) => card.cloneGroupId)?.cloneGroupId
        ? await db.groups.get(suite.cards.find((card) => card.cloneGroupId)!.cloneGroupId!)
        : undefined
      let conversationId = suite.cards.find((card) => card.conversationId)?.conversationId
      let members = group ? (await db.contacts.bulkGet(group.memberContactIds)).filter((item): item is Contact => !!item) : []
      if (!group || !conversationId || members.length === 0) {
        const sandbox = await createGroupSandbox(snapshot.group, snapshot.members)
        group = sandbox.group
        members = sandbox.members
        conversationId = sandbox.conversationId
        suite.cards = suite.cards.map((card) => ({ ...card, cloneGroupId: group!.id, cloneContactIds: members.map((item) => item.id), conversationId }))
        await db.aiTestSuites.update(suite.id, { cards: suite.cards, updatedAt: Date.now() })
      }
      const knownTurns = new Set((await db.aiTurns.where('conversationId').equals(conversationId).primaryKeys()).map(String))
      for (let index = 0; index < suite.cards.length; index += 1) {
        if (suite.cards[index].status === 'completed') continue
        await updateCard(suite, index, { status: 'running' })
        await sendGroupMessage(conversationId, group, members, settings, stickers, suite.cards[index].userMessage)
        const turn = await waitForTurn(conversationId, knownTurns, controller.signal)
        knownTurns.add(turn.id)
        const messages = await db.messages.where('conversationId').equals(conversationId).filter((item) => item.role === 'assistant' && item.debugAiTurnId === turn.id).sortBy('createdAt')
        const result = resultFromTurn(suite.cards[index] as GeneratedAiTestCase, turn, messages)
        await updateCard(suite, index, { status: 'completed', reply: result.reply, rawResponse: turn.raw, context: result.context, diagnostics: result.diagnostics, aiTurnId: turn.id, completedAt: Date.now() })
      }
    } else {
      const source = suite.targetSnapshot as Contact
      let sequentialSandbox: Awaited<ReturnType<typeof createSandbox>> | undefined
      let sequentialContact: Contact | undefined
      const knownTurns = new Set<string>()
      if (suite.executionMode === 'sequential') {
        const existingConversationId = suite.cards.find((card) => card.conversationId)?.conversationId
        const existingContactId = suite.cards.find((card) => card.cloneContactIds?.[0])?.cloneContactIds?.[0]
        if (existingConversationId && existingContactId) {
          const existingContact = await db.contacts.get(existingContactId)
          if (existingContact) {
            sequentialSandbox = { contactId: existingContactId, conversationId: existingConversationId, memoryIds: [], experienceIds: [], lifeEventIds: [], loanIds: [] }
            sequentialContact = existingContact
            for (const id of await db.aiTurns.where('conversationId').equals(existingConversationId).primaryKeys()) knownTurns.add(String(id))
          }
        }
        if (!sequentialSandbox) {
          sequentialSandbox = await createSandbox(source)
          sequentialContact = (await db.contacts.get(sequentialSandbox.contactId))!
          suite.cards = suite.cards.map((card) => ({ ...card, cloneContactIds: [sequentialSandbox!.contactId], conversationId: sequentialSandbox!.conversationId }))
          await db.aiTestSuites.update(suite.id, { cards: suite.cards, updatedAt: Date.now() })
        }
      }
      for (let index = 0; index < suite.cards.length; index += 1) {
        if (suite.cards[index].status === 'completed') continue
        const sandbox = sequentialSandbox ?? await createSandbox(source)
        const contact = sequentialContact ?? (await db.contacts.get(sandbox.contactId))!
        if (suite.kind === 'moments') await runMomentCard(suite, index, contact, sandbox.conversationId, settings)
        else await runChatCard(suite, index, contact, sandbox.conversationId, stickers, settings, controller.signal, sequentialSandbox ? knownTurns : new Set<string>())
      }
    }
    suite.status = 'completed'
    suite.currentCardIndex = undefined
    await db.aiTestSuites.update(suite.id, { status: 'completed', currentCardIndex: undefined, updatedAt: Date.now() })
  } catch (error) {
    const cancelled = controller.signal.aborted
    const message = cancelled ? '已由管理员停止' : error instanceof Error ? error.message : String(error)
    const cardIndex = suite.currentCardIndex ?? 0
    if (!cancelled && suite.cards[cardIndex]?.status === 'running') await updateCard(suite, cardIndex, { status: 'failed', error: message })
    await db.aiTestSuites.update(suite.id, { status: cancelled ? 'cancelled' : 'failed', error: message, updatedAt: Date.now() })
  } finally {
    activeRuns.delete(suiteId)
  }
}

export function startAiTestSuite(suiteId: string): void {
  if (activeRuns.has(suiteId)) return
  const controller = new AbortController()
  activeRuns.set(suiteId, controller)
  void runSuite(suiteId, controller)
}

export async function stopAiTestSuite(suite: AiTestSuiteRecord): Promise<void> {
  activeRuns.get(suite.id)?.abort()
  for (const conversationId of new Set(suite.cards.flatMap((card) => card.conversationId ? [card.conversationId] : []))) {
    if (suite.kind === 'group') stopGroupAiTurn(conversationId)
    else stopAiTurn(conversationId)
  }
  await db.aiTestSuites.update(suite.id, { status: 'cancelled', error: '已由管理员停止', updatedAt: Date.now() })
}

export async function markInterruptedAiTests(): Promise<void> {
  const running = await db.aiTestSuites.where('status').equals('running').toArray()
  for (const suite of running) {
    if (!activeRuns.has(suite.id)) await db.aiTestSuites.update(suite.id, { status: 'interrupted', error: '应用在测试完成前关闭，可继续运行或清理副本。', updatedAt: Date.now() })
  }
}

export async function updateAiTestReview(suiteId: string, cardId: string, patch: Pick<AiTestCardRecord, 'rating' | 'comment'>): Promise<void> {
  const suite = await db.aiTestSuites.get(suiteId)
  if (!suite) return
  await db.aiTestSuites.update(suiteId, { cards: suite.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card), updatedAt: Date.now() })
}
