import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletionText as chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import {
  buildGroupRawChatPrompt,
  buildLocationRawChatPrompt,
  groupTypingDelayMs,
  parseGroupAiResponse,
  pickSociallyConnectedSpeakers,
  selectGroupImageParticipantIds,
  stripSpeakerNamePrefix,
} from './groupChat'
import { parseJsonLoose } from './aiProtocol'
import { CONTEXT_WINDOW_SIZE, maybeUpdateGroupMemory, nonGroupScopedMemoriesText } from './memory'
import { aiRelationshipPrompt } from './contactRelations'
import { resolveKnowledgeQueries } from './knowledgeBase'
import { isModuleEnabled } from '../features'
import { describeCurrentTime } from './time'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { buildUserProfileText, nextMessageTimestamp, useChatEngineStore } from './chatEngine'
import { reviewTurnLogic } from './turnLogicReviewer'
import { buildDirectGroupOutputInstruction, parseDirectOutputReview } from './directOutput'
import { trackRemoteStickerSend } from './remoteMedia'
import { resolveBubbleMedia } from './bubbleMedia'
import { createTurnController, revealSequentially } from './conversationRuntime'
import { isImageProviderReady, isStickerProviderReady } from './mediaProviders'
import { realSeason, resolveLocationParticipants, syncContactLocationsAt, type LocationParticipants } from './locations'
import { recentSocialEventsText, recordSocialEvent } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { createGroupPlan, planCardMessage } from './groupPlans'
import { useChatUiStore } from '../store/useChatUiStore'
import { retrieveWorldbookContext } from './worldbook'
import { featureActive, promptModuleEnabled } from './promptModules'
import { realisticReplyDelayMs } from './replyTiming'
import { createMediaAsset, startMediaAsset } from './imageAssets'
import { generateGroupAgentTurn } from './chatAgentTools'
import { traceTurnEvent } from './deepseek'
import type { AppSettings, Contact, Group, GroupAiBubble, Message, Sticker } from '../types'

/** Load recent structured memories for each speaker in parallel. */
async function loadSpeakerMemories(speakers: Contact[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const results = await Promise.all(speakers.map(async (s) => {
    const text = await nonGroupScopedMemoriesText(s.id)
    return { id: s.id, text }
  }))
  for (const { id, text } of results) {
    if (text) map.set(id, text)
  }
  return map
}

/**
 * Same background-engine shape as chatEngine.ts (module-level bookkeeping,
 * reuses the same useChatEngineStore keyed by conversationId so ChatPage's
 * aiTyping/error subscription works unchanged for group conversations too)
 * — kept in its own file rather than folded into chatEngine.ts because the
 * group turn genuinely has a different shape (multiple personas per turn,
 * no relationship-dimension updates, a smaller text/sticker-only protocol)
 * and entangling the two would make chatEngine.ts's single-contact
 * assumptions harder to reason about. Memory (facts/style/plans) *is*
 * updated per speaker, via maybeUpdateGroupMemory — see memory.ts.
 */
const turns = createTurnController()

function scheduleGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  regenerationInstruction = '',
): void {
  const delay = realisticReplyDelayMs(isModuleEnabled('realisticReplies'))
  if (delay === 0) {
    void runGroupAiTurn(conversationId, group, members, settings, stickers, streamId, regenerationInstruction)
    return
  }
  const timer = setTimeout(() => {
    if (!turns.isCurrent(conversationId, streamId)) return
    void runGroupAiTurn(conversationId, group, members, settings, stickers, streamId, regenerationInstruction)
  }, delay)
  turns.addTimer(conversationId, timer)
}

function parseGroupTurnDebugPayload(
  mainPrompt: string,
  rawText: string,
  draftFeedback: string | undefined,
  jsonRaw: string,
  finalRaw: string,
  bubbles: GroupAiBubble[],
  knowledgeQueries: string[],
  turnSummary: string,
  groupVibe: string,
  storyOutline?: string,
): unknown {
  const parsed = parseJsonLoose(finalRaw)
  if (parsed && typeof parsed === 'object') {
    return { ...(parsed as Record<string, unknown>), mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } }
  }
  if (parsed !== null) return parsed
  return { mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, knowledgeQueries, turnSummary, groupVibe, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } }
}

/** Cancels a group generation and its queued bubbles. */
export function stopGroupAiTurn(conversationId: string): void {
  turns.begin(conversationId, uuid())
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '' })
}

export function resetAllGroupChatTurns(): void {
  turns.resetAll()
}

function parseCompressedGroupMemory(raw: string): string | null {
  const parsed = parseJsonLoose<{ memory?: unknown }>(raw)
  return typeof parsed?.memory === 'string' && parsed.memory.trim() ? parsed.memory.trim() : null
}

async function updateGroupMemoryAndVibe(opts: {
  group: Group
  aiTurnId: string
  settings: AppSettings
  turnSummary: string
  groupVibe: string
  directOutput?: boolean
}): Promise<void> {
  const { group, aiTurnId, settings } = opts
  const now = Date.now()
  const timeLabel = new Date(now).toLocaleString()
  const turnSummary = opts.turnSummary.trim()
  const nextTurnCount = (group.memoryTurnCount ?? 0) + 1
  const appendedMemory = turnSummary
    ? [group.memory?.trim() ?? '', `[${timeLabel}] ${turnSummary}`].filter(Boolean).join('\n')
    : (group.memory ?? '')
  const patch: Partial<Group> = {
    memory: appendedMemory,
    vibe: opts.groupVibe.trim() || group.vibe || '',
    memoryTurnCount: nextTurnCount,
  }

  if (!opts.directOutput && nextTurnCount % 5 === 0 && appendedMemory.trim()) {
    try {
      const raw = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.utilityModel,
        jsonMode: true,
        messages: [
          {
            role: 'system',
            content: `你是群聊记忆压缩器。把群"${group.name}"的群聊记忆按时间线压缩，保留重要事件、固定梗、关系变化、长期氛围，不要保留流水账。输出JSON: {"memory":"..."}`,
          },
          {
            role: 'user',
            content: appendedMemory.slice(-5000),
          },
        ],
        purpose: 'memory',
        automatic: true,
      })
      const compressed = parseCompressedGroupMemory(raw)
      if (compressed) patch.memory = compressed
    } catch {
      // best-effort; keep appended memory if compression fails
    }
  }

  await db.groups.update(group.id, patch)
  const turn = await db.aiTurns.get(aiTurnId)
  if (turn?.parsed && typeof turn.parsed === 'object') {
    await db.aiTurns.update(aiTurnId, {
      parsed: { ...(turn.parsed as Record<string, unknown>), groupMemoryUpdate: patch },
    })
  }
}

function messageLabel(message: Message, contactById: Map<string, Contact>, userNickname: string): string {
  if (message.role === 'user') return userNickname || '我'
  const speaker = message.speakerContactId ? contactById.get(message.speakerContactId) : undefined
  return speaker ? displayName(speaker) : '某人'
}

function messageBody(message: Message): string {
  if (message.type === 'sticker') return `[表情: ${message.content}]`
  if (message.type === 'link') return `[链接: ${message.content}]`
  if (message.type === 'gift') return `[礼物: ${message.content}]`
  if (message.type === 'scheduleChange') return `[日程: ${message.content}]`
  return message.content
}

function formatGroupHistoryMessage(
  message: Message,
  contactById: Map<string, Contact>,
  messageById: Map<string, Message>,
  userNickname: string,
): ChatMessage {
  const speakerLabel = messageLabel(message, contactById, userNickname)
  const parts: string[] = []
  if (message.mentions?.length) {
    const names = message.mentions.map((id) => contactById.get(id)).filter((c): c is Contact => !!c).map(displayName)
    if (names.length > 0) parts.push(`@${names.join(' @')}`)
  }
  if (message.replyToMessageId) {
    const replied = messageById.get(message.replyToMessageId)
    if (replied) parts.push(`replying to ${messageLabel(replied, contactById, userNickname)}: "${messageBody(replied)}"`)
  }
  parts.push(messageBody(message))
  return { role: message.role, content: `${speakerLabel}: ${parts.join(' | ')}` }
}

function targetedContextText(
  latestUserMessage: Message | undefined,
  contactById: Map<string, Contact>,
  messageById: Map<string, Message>,
  userNickname: string,
): string {
  if (!latestUserMessage) return ''
  const lines: string[] = []
  if (latestUserMessage.mentions?.length) {
    const names = latestUserMessage.mentions.map((id) => contactById.get(id)).filter((c): c is Contact => !!c).map(displayName)
    if (names.length > 0) lines.push(`User explicitly @mentioned: ${names.join(', ')}`)
  }
  if (latestUserMessage.replyToMessageId) {
    const replied = messageById.get(latestUserMessage.replyToMessageId)
    if (replied) {
      lines.push(`User is replying to ${messageLabel(replied, contactById, userNickname)}: "${messageBody(replied)}"`)
    }
  }
  return lines.join('\n')
}

export async function sendGroupMessage(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
  text: string,
  mentionContactIds: string[] = [],
  replyToMessageId?: string,
): Promise<void> {
  if (!text.trim()) return
  if (group.kind === 'location' && group.locationId) {
    await syncContactLocationsAt(new Date())
    const participants = await resolveLocationParticipants(group.locationId)
    members = participants.activeMembers
    group = { ...group, memberContactIds: members.map((member) => member.id) }
    await db.groups.update(group.id, { memberContactIds: group.memberContactIds })
  }
  if (!settings.apiKey && members.length > 0) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置API Key 请先去"我-设置"里填写' })
    return
  }

  const streamId = uuid()
  turns.begin(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: '群成员' })

  const messageCreatedAt = await nextMessageTimestamp(conversationId)
  const msg: Message = {
    id: uuid(),
    conversationId,
    role: 'user',
    type: 'text',
    content: text.trim(),
    mentions: mentionContactIds.length > 0 ? Array.from(new Set(mentionContactIds)) : undefined,
    replyToMessageId,
    createdAt: messageCreatedAt,
  }
  await db.messages.add(msg)
  await db.conversations.update(conversationId, { updatedAt: messageCreatedAt })
  if (group.kind === 'location' && members.length === 0) {
    useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '' })
    return
  }
  if (msg.mentions?.length || msg.replyToMessageId) {
    const mentionedNames = msg.mentions
      ?.map((id) => members.find((member) => member.id === id))
      .filter((member): member is Contact => !!member)
      .map(displayName)
      .join('、')
    await recordSocialEvent({
      type: 'group_targeted_message',
      actorId: 'user',
      relatedContactIds: Array.from(new Set([...(msg.mentions ?? []), ...group.memberContactIds])),
      conversationId,
      groupId: group.id,
      messageId: msg.id,
      summary: mentionedNames
        ? `群聊"${group.name}"里，用户@了${mentionedNames}: ${text.trim()}`
        : `群聊"${group.name}"里，用户回复了一条消息: ${text.trim()}`,
      importance: 2,
    })
  }

  scheduleGroupAiTurn(conversationId, group, members, settings, stickers, streamId)
}

/** Trigger a group reply after a non-text user action has already been stored. */
export async function triggerGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
): Promise<void> {
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置 API Key，请先去“我 / 设置”里填写' })
    return
  }
  const streamId = uuid()
  turns.begin(conversationId, streamId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: '群成员' })
  scheduleGroupAiTurn(conversationId, group, members, settings, stickers, streamId)
}

export async function regenerateGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
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
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: '群成员' })

  const turnMessages = await db.messages
    .where('conversationId')
    .equals(conversationId)
    .filter((message) => message.debugAiTurnId === aiTurnId)
    .toArray()
  if (turnMessages.length > 0) await db.messages.bulkDelete(turnMessages.map((message) => message.id))
  await db.aiTurns.delete(aiTurnId)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  scheduleGroupAiTurn(conversationId, group, members, settings, stickers, streamId, regenerationInstruction.trim())
}

async function runGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
  regenerationInstruction = '',
): Promise<void> {
  const engine = useChatEngineStore.getState()
  let responseTimeout: ReturnType<typeof setTimeout> | undefined
  const directOutput = isModuleEnabled('directOutput')
  const turnStartedAt = performance.now()
  engine.patch(conversationId, { aiTyping: true, error: '', typingLabel: '群成员' })
  const timeoutMs = Math.max(0, Math.min(10 * 60 * 1000, Math.round(settings.chatResponseTimeoutMs ?? 60 * 1000)))
  if (timeoutMs > 0) {
    responseTimeout = setTimeout(() => {
      if (!turns.isCurrent(conversationId, streamId)) return
      turns.begin(conversationId, uuid())
      engine.patch(conversationId, { aiTyping: false, typingLabel: undefined, error: `回复等待超过 ${Math.round(timeoutMs / 1000)} 秒，已停止生成。` })
    }, timeoutMs)
  }
  console.log(`[group] 开始生成回复 群=${group.name} conversationId=${conversationId}`)
  try {
    let locationParticipants: LocationParticipants | undefined
    if (group.kind === 'location' && group.locationId) {
      await syncContactLocationsAt(new Date())
      locationParticipants = await resolveLocationParticipants(group.locationId)
      members = locationParticipants.activeMembers
      group = { ...group, memberContactIds: members.map((member) => member.id) }
      await db.groups.update(group.id, { memberContactIds: group.memberContactIds })
    }
    if (members.length === 0) {
      engine.patch(conversationId, { error: group.kind === 'location' ? '' : '这个群里已经没有成员了', aiTyping: false, typingLabel: undefined })
      return
    }

    const contactById = new Map(members.map((c) => [c.id, c]))

    const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const messageById = new Map(history.map((m) => [m.id, m]))
    const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')
    const preferredSpeakerIds = new Set(latestUserMessage?.mentions ?? [])
    const replied = latestUserMessage?.replyToMessageId ? messageById.get(latestUserMessage.replyToMessageId) : undefined
    if (replied?.role === 'assistant' && replied.speakerContactId) preferredSpeakerIds.add(replied.speakerContactId)
    const speakers = await pickSociallyConnectedSpeakers(members, Array.from(preferredSpeakerIds), group.speakerLimit ?? 3)
    console.log(`[group] 本轮发言人: ${speakers.map((s) => s.name).join('、')}`)
    const targetContext = targetedContextText(latestUserMessage, contactById, messageById, settings.userNickname)
    const recentEventsText = await recentSocialEventsText(members.map((m) => m.id), 4)
    const sharedOriginalContext = promptModuleEnabled(settings, 'memory') ? await recentSharedOriginalContext(members.map((m) => m.id), settings.userNickname, {
      maxMessages: 60,
      maxChars: 10_000,
      // This group already contributes its recent raw history below. Excluding
      // it here avoids paying twice for the same messages.
      excludeConversationId: conversationId,
    }) : ''
    const worldbookText = featureActive(settings, 'worldview') ? await retrieveWorldbookContext([group.name, group.vibe, targetContext, history.slice(-10).map((m) => m.content).join(' '), members.map((m) => `${m.name} ${m.systemPrompt}`).join(' ')].filter(Boolean).join('\n'), { worldviewId: settings.activeWorldId || settings.defaultWorldviewId }) : ''

    const speakerMemoriesMap = promptModuleEnabled(settings, 'memory') ? await loadSpeakerMemories(speakers) : new Map<string, string>()
    const aiRelationshipText = featureActive(settings, 'relationship') ? await aiRelationshipPrompt(members) : ''
    const remoteStickerSearchEnabled = isStickerProviderReady(settings)
    const imageGenerationEnabled = isImageProviderReady(settings)
    const location = group.kind === 'location' && group.locationId ? await db.locations.get(group.locationId) : undefined
    const allLocations = isModuleEnabled('location') ? await db.locations.toArray() : []
    const leafLocations = allLocations.filter((candidate) => !allLocations.some((child) => child.parentId === candidate.id))
    const locationToolContext = leafLocations.length ? `\n可创建日程的合法地点：${leafLocations.map((candidate) => `${candidate.name}(${candidate.id})`).join('、')}` : ''
    const promptBuilder = group.kind === 'location' ? buildLocationRawChatPrompt : buildGroupRawChatPrompt
    const participantPositions = locationParticipants
      ? [
          ...locationParticipants.here.map((contact) => `- ${displayName(contact)}：here，正在当前地点`),
          ...locationParticipants.audible.map(({ contact, audibility }) => `- ${displayName(contact)}：${audibility}，位于${contact.currentLocationId ?? '未知地点'}`),
        ].join('\n')
      : ''
    const systemPrompt = promptBuilder({
      stylePrompt: settings.globalSystemPrompt,
      groupName: group.name,
      allMembers: members,
      speakers,
      stickerNames: stickers.map((s) => s.name),
      remoteStickerSearchEnabled,
      imageGenerationEnabled,
      imageSearchEnabled: !!settings.pexelsApiKey,
      groupMemoryText: group.memory,
      groupVibeText: group.vibe,
      allowAiChatter: group.allowAiChatter ?? true,
      energyLevel: group.energyLevel ?? 'normal',
      currentTimeText: describeCurrentTime(new Date()),
      userProfileText: buildUserProfileText(settings),
      targetedContextText: targetContext,
      recentEventsText: recentEventsText || undefined,
      worldviewText: worldbookText || undefined,
      knowledgeDigestText: undefined,
      speakerMemoriesMap,
      aiRelationshipText,
      locationContextText: location
        ? `当前地点：${location.name}\n地点描述：${location.description}\n设备现实时间：${describeCurrentTime(new Date())}\n现实季节：${realSeason(new Date())}\n人物位置与听觉状态：\n${participantPositions || '当前没有任何人物能听见'}\n模型只能从本轮可发言成员中选择说话人。muffled人物只能隔墙、隔门或从远处搭话。`
        : undefined,
      promptModules: settings.promptModules,
      enabledModules: settings.enabledModules,
    })
    if (!systemPrompt.trim()) throw new Error('对话核心提示词模块已屏蔽')

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const controller = new AbortController()
    turns.setAbortController(conversationId, controller)

    // ChatSLG retired per-turn pre-draft outlines because they add a complete
    // serial model request before every group reply. The main prompt already
    // contains the same planning, persona, pacing, and topic contracts.
    const storyOutline = ''
    // Group history needs an explicit "who said this" label per line — unlike
    // 1:1 chat where the single assistant persona is implicit from the system
    // prompt, a group turn's assistant block can contain several different
    // people, and role:"assistant" alone can't distinguish them across turns.
    const regenerationPrompt = regenerationInstruction
      ? `【重要：本次重生成必须遵守的剧情指令】\n用户不认可上一版群聊的发展。下方用户指令是本次重生成的首要内容要求：必须落实到实际回复和事件发展中，不可忽略、淡化、回避或改写成相反走向。`
      : ''
    const regenerationUserMessage = regenerationInstruction
      ? `【本次重生成：最高优先级剧情要求】\n请先在心中确认后再作答：你们接下来生成的每条消息和事件发展，都必须严格符合以下要求：\n${regenerationInstruction}\n\n这是用户对上一版结果的明确修正。即使原本会作出不同选择，也必须以此要求为准；不要解释、复述或提及这条要求，只需自然地把它演出来。`
      : ''
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: [
        systemPrompt,
        sharedOriginalContext,
        regenerationPrompt,
        directOutput ? buildDirectGroupOutputInstruction(speakers) : '',
      ].filter(Boolean).join('\n\n') },
      ...recentHistory.map((m): ChatMessage => formatGroupHistoryMessage(m, contactById, messageById, settings.userNickname)),
      ...(regenerationUserMessage ? [{ role: 'user' as const, content: regenerationUserMessage }] : []),
      { role: 'system', content: '【最终生成提醒】现在只生成自然群聊正文，不输出JSON、分析、标题或Markdown。' },
    ])
    let rawText: string
    let agentParsed: ReturnType<typeof parseGroupAiResponse>
    if (directOutput) {
      rawText = await chatCompletion({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, messages: chatMessages, signal: controller.signal, purpose: 'chat', thinking: 'disabled', temperature: regenerationInstruction ? 0.55 : 0.9, maxTokens: 1400, jsonMode: true, trace: { turnId: streamId, stage: 'original_generation', conversationId } })
      agentParsed = parseGroupAiResponse(rawText, speakers.length)
    } else {
      const generated = await generateGroupAgentTurn({
        apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, utilityModel: settings.utilityModel,
        messages: [...chatMessages, { role: 'system', content: `本轮必须通过提供的函数发送群聊消息或执行行动。create_schedule 日程卡不能单独作为回复：创建日程时，同一位发言人必须同时调用 send_text 自然说话；图片已有必填配文，表情包可以单独发送。每条消息都必须填写该发言人的真实想法和简短中文文字心情；心情禁止使用 emoji。严格选择正确的 speakerIndex。${locationToolContext}` }],
        signal: controller.signal, purpose: 'chat', trace: { turnId: streamId, stage: 'original_generation', conversationId },
        stickerNames: stickers.map((sticker) => sticker.name), stickerSearchEnabled: remoteStickerSearchEnabled,
        imageEnabled: imageGenerationEnabled || !!settings.pexelsApiKey, knowledgeEnabled: featureActive(settings, 'knowledgeBase'),
        scheduleEnabled: isModuleEnabled('location'), locationIds: leafLocations.map((candidate) => candidate.id),
        speakerNames: speakers.map((speaker) => displayName(speaker)), memberNames: members.map((member) => displayName(member)),
      })
      rawText = generated.raw
      agentParsed = generated.parsed
    }

    if (!turns.isCurrent(conversationId, streamId)) return
    console.log(`[group] Agent群聊回复(${rawText.length}字): ${rawText.slice(0, 160)}...`)
    let draftFeedback: string | undefined
    const parsedTurn = { ...agentParsed, valid: true, needsUtility: false }
    let jsonRaw = rawText
    if (parsedTurn.bubbles.length === 0 && parsedTurn.knowledgeQueries.length === 0) throw new Error('主模型没有产出有效的群聊行动')
    console.log('[group] 审核模型已完成群聊原文审核和JSON翻译，未调用第三个翻译模型')

    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, turnSummary, groupVibe, planCandidates } = parsedTurn
    const initiallyRequestedKnowledge = [...knowledgeQueries]
    const runLogicReview = (stage: 'first_quality' | 'second_quality') => reviewTurnLogic({
      settings,
      latestUserText: latestUserMessage?.content ?? '',
      draftText: rawText,
      personaFacts: [
        ...speakers.map((speaker) => `${displayName(speaker)}：${speaker.systemPrompt.slice(0, 700)}${speaker.personaConstraints ? `；硬约束=${speaker.personaConstraints.slice(0, 350)}` : ''}${featureActive(settings, 'personalityTraits') && speaker.personalityTrait ? `；人格特质=${speaker.personalityTrait}` : ''}${promptModuleEnabled(settings, 'memory') && speaker.sharedHistory ? `；共同过往锚点=${speaker.sharedHistory.slice(0, 500)}` : ''}`),
        `群聊设置：热闹程度=${group.energyLevel ?? 'normal'}；AI互聊=${group.allowAiChatter === false ? '关闭' : '开启'}`,
        targetContext ? `本轮定向上下文=${targetContext.slice(0, 600)}` : '',
        featureActive(settings, 'worldview') && worldbookText ? `命中世界书=${worldbookText.slice(0, 800)}` : '',
      ].filter(Boolean).join('\n'),
      recentContext: recentHistory
        .slice(-4)
        .map((message) => formatGroupHistoryMessage(message, contactById, messageById, settings.userNickname).content)
        .join('\n'),
      signal: controller.signal,
      trace: { turnId: streamId, stage, conversationId },
    })
    void runLogicReview
    const directReview = directOutput ? parseDirectOutputReview(rawText) : null
    // Semantic/format review is the mandatory second stage above.  Do not
    // issue legacy extra reviewer calls after JSON translation.
    let logicReview: { status: 'pass' | 'reject' | 'unavailable'; reason: string } | undefined = (() => undefined as { status: 'pass' | 'reject' | 'unavailable'; reason: string } | undefined)()
    if (!turns.isCurrent(conversationId, streamId)) return
    if (logicReview?.status === 'unavailable') {
      draftFeedback = `审查降级：${logicReview.reason}`
      console.warn(`[group] 逻辑审查不可用，放行已解析回复 群=${group.name} 原因=${logicReview.reason}`)
    }
    if (directReview?.valid === false) {
      throw new Error(`群聊同次自审未通过：${directReview.reason || '未知原因'}`)
    }
    knowledgeQueries = Array.from(new Set([...initiallyRequestedKnowledge, ...knowledgeQueries])).slice(0, 2)
    if (!directOutput && featureActive(settings, 'knowledgeBase') && knowledgeQueries.length > 0) {
      const knowledge = await resolveKnowledgeQueries(knowledgeQueries, settings)
      if (knowledge.text) {
        const regenerated = await generateGroupAgentTurn({
          apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, utilityModel: settings.utilityModel,
          messages: [...chatMessages, { role: 'user', content: `刚才出现了你们不了解的词。搜索结果如下：\n${knowledge.text}\n请基于结果自然接话，不要写成报告。` }, { role: 'system', content: `必须通过提供的函数发送消息。create_schedule 日程卡不能单独作为回复：创建日程时，同一位发言人必须同时调用 send_text 自然说话。每条消息填写真实想法和中文文字心情，禁止使用 emoji。${locationToolContext}` }],
          signal: controller.signal, purpose: 'chat', trace: { turnId: streamId, stage: 'second_chat', conversationId },
          stickerNames: stickers.map((sticker) => sticker.name), stickerSearchEnabled: remoteStickerSearchEnabled,
          imageEnabled: imageGenerationEnabled || !!settings.pexelsApiKey, knowledgeEnabled: false,
          scheduleEnabled: isModuleEnabled('location'), locationIds: leafLocations.map((candidate) => candidate.id), speakerNames: speakers.map((speaker) => displayName(speaker)), memberNames: members.map((member) => displayName(member)),
        })
        rawText = regenerated.raw
        const enrichedConverted = regenerated.parsed
        if (enrichedConverted.bubbles.length === 0) throw new Error('知识补全后的审核模型没有产出有效群聊JSON')
        jsonRaw = rawText
        finalRaw = jsonRaw
        ;({ bubbles, knowledgeQueries, turnSummary, groupVibe, planCandidates } = enrichedConverted)
      }
    }
    console.log(`[group] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 群=${group.name}`)
    if (bubbles.length === 0) {
      console.warn(`[group] 本轮没有人回复 群=${group.name} 原始内容: ${rawText.slice(0, 200)}`)
      engine.patch(conversationId, { error: '群里这次没有人回复 可以再发一条试试', aiTyping: false, typingLabel: undefined })
      return
    }
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw: finalRaw,
      parsed: parseGroupTurnDebugPayload(systemPrompt, rawText, draftFeedback, jsonRaw, finalRaw, bubbles, knowledgeQueries, turnSummary, groupVibe, storyOutline),
      knowledgeQueries,
      createdAt: Date.now(),
    })
    const createdPlans = []
    for (const candidate of planCandidates) {
      const plan = await createGroupPlan({
        group,
        conversationId,
        title: candidate.title,
        summary: candidate.summary,
        location: candidate.location,
        participantContactIds: candidate.participantIndexes.map((index) => speakers[index - 1]?.id).filter((id): id is string => !!id),
      })
      if (plan) createdPlans.push(plan)
    }
    for (const plan of createdPlans) await db.messages.add(planCardMessage(plan))
    void updateGroupMemoryAndVibe({ group, aiTurnId, settings, turnSummary, groupVibe, directOutput })
    console.info(`[group-perf] 模型与自检完成=${Math.round(performance.now() - turnStartedAt)}ms 群=${group.name}`)
    revealGroupBubbles(conversationId, group, members, speakers, bubbles, streamId, settings, stickers, aiTurnId, turnSummary, turnStartedAt, directOutput)
  } catch (err) {
    if (!turns.isCurrent(conversationId, streamId)) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[group] 生成回复出错 群=${group.name}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false, typingLabel: undefined })
  } finally {
    if (responseTimeout) clearTimeout(responseTimeout)
  }
}

function revealGroupBubbles(
  conversationId: string,
  group: Group,
  members: Contact[],
  speakers: Contact[],
  bubbles: GroupAiBubble[],
  streamId: string,
  settings: AppSettings,
  stickers: Sticker[],
  aiTurnId: string,
  turnSummary: string,
  turnStartedAt = performance.now(),
  directOutput = false,
  onFirstBubble?: () => void,
): void {
  revealSequentially({
    conversationId,
    streamId,
    items: bubbles,
    controller: turns,
    // Reveal the first completed message immediately. A later message only
    // starts after the previous one, including image/sticker API work, has
    // been persisted so mixed media can never overtake its intended slot.
    delayMs: (bubble, i) => i > 0 ? groupTypingDelayMs(bubble) : 0,
    reveal: async (bubble, i) => {
      const speaker = speakers[bubble.speakerIndex - 1]
      let executionError = ''
      useChatEngineStore.getState().patch(conversationId, {
        typingLabel: speaker ? displayName(speaker) : '群成员',
      })
      let imagePayload: Message['image']
      let imageFailed = false
      let imageAssetId: string | undefined
      const media = bubble.type === 'image'
        ? { remoteSticker: undefined, stickerFailed: false }
        : await resolveBubbleMedia(bubble, settings, stickers)
      const { remoteSticker, stickerFailed } = media
      let content =
        bubble.type === 'text'
          ? stripSpeakerNamePrefix(
              bubble.content,
              members.map((m) => m.name),
            )
          : bubble.type === 'sticker' ? (stickerFailed ? '表情没找到…' : bubble.name)
            : bubble.type === 'scheduleChange' ? bubble.summary
              : imageFailed ? '图片没发出来…' : bubble.caption || '[图片]'

      const messageCreatedAt = await nextMessageTimestamp(conversationId)
      const messageId = uuid()
      if (bubble.type === 'scheduleChange' && speaker?.id) {
        const location = bubble.locationId ? await db.locations.get(bubble.locationId) : undefined
        if (bubble.locationId && !location) executionError = '这个地点已经不可用了，日程没有创建成功。'
        const fresh = await db.contacts.get(speaker.id)
        if (!fresh) executionError = '没有找到对应联系人，日程没有创建成功。'
        if (!executionError && fresh) await db.contacts.update(speaker.id, { scheduleOverrides: [...(fresh.scheduleOverrides ?? []), {
          id: uuid(), date: bubble.date, startHour: bubble.startHour, endHour: bubble.endHour,
          phoneAccess: bubble.phoneAccess, location: location?.name ?? bubble.location, locationId: location?.id,
          activity: bubble.activity, summary: bubble.summary, priority: 'special', createdAt: Date.now(),
        }] })
        if (!executionError) void traceTurnEvent({ turnId: streamId, conversationId, stage: 'schedule_change', output: `${displayName(speaker)} 新建：${bubble.activity}｜${bubble.date} ${String(bubble.startHour).padStart(2, '0')}:00-${String(bubble.endHour).padStart(2, '0')}:00｜${location?.name ?? bubble.location}` })
      }
      if (bubble.type === 'image') {
        if (!isImageProviderReady(settings)) imageFailed = true
        else {
          try {
            const kind = bubble.kind ?? 'portrait'
            let participantIds = (bubble.participantIndexes ?? [])
              .map((index) => members[index - 1]?.id)
              .filter((id): id is string => !!id)
            if (participantIds.length === 0 && kind !== 'scene' && kind !== 'object') participantIds = speaker ? [speaker.id] : []
            participantIds = selectGroupImageParticipantIds(participantIds, speaker?.id)
            const asset = await createMediaAsset({ origin: 'chat', originId: messageId, conversationId, turnId: streamId, ownerContactIds: participantIds, includeUser: bubble.includeUser, scene: bubble.query, kind, settings })
            imageAssetId = asset.id
            imagePayload = { assetId: asset.id, caption: bubble.caption, query: bubble.query, provider: asset.provider }
          } catch (error) { console.warn('[media] 创建群聊图片任务失败', error); imageFailed = true }
        }
      }
      if (bubble.type === 'image' && imageFailed) content = '图片没发出来…'
      if (executionError) content = executionError
      const msg: Message = {
        id: messageId,
        conversationId,
        role: 'assistant',
        type: executionError || (bubble.type === 'image' && imageFailed) || (bubble.type === 'sticker' && stickerFailed) ? 'text' : bubble.type,
        content,
        scheduleChange: !executionError && bubble.type === 'scheduleChange' ? { date: bubble.date, startHour: bubble.startHour, endHour: bubble.endHour, phoneAccess: bubble.phoneAccess, location: bubble.location, locationId: bubble.locationId, activity: bubble.activity, summary: bubble.summary } : undefined,
        speakerContactId: speaker?.id,
        debugAiTurnId: aiTurnId,
        debugParsedBubble: bubble,
        thought: bubble.thought,
        sticker: remoteSticker ? { url: remoteSticker.url, provider: remoteSticker.provider } : undefined,
        image: imagePayload,
        createdAt: messageCreatedAt,
      }
      await db.messages.add(msg)
      if (imageAssetId) startMediaAsset(imageAssetId)
      if (i === 0) onFirstBubble?.()
      if (remoteSticker) void trackRemoteStickerSend(remoteSticker)
      if (i === 0) {
        console.info(`[group-perf] 首条气泡显示=${Math.round(performance.now() - turnStartedAt)}ms 群=${group.name}`)
      }
      if (speaker?.id && bubble.mood) {
        await db.contacts.update(speaker.id, {
          mood: { text: bubble.mood, expiresAt: Date.now() + settings.moodExpiryMs },
        })
      }
      await db.conversations.update(conversationId, { updatedAt: messageCreatedAt })

      if (useChatUiStore.getState().activeConversationId !== conversationId) {
        useChatUiStore.getState().showNotification({
          id: uuid(),
          conversationId,
          contactName: group.name,
          contactAvatar: group.avatar,
          contactAvatarColor: group.avatarColor,
          preview: previewForMessage(msg, speaker ? displayName(speaker) : undefined),
        })
      }

          if (i === bubbles.length - 1) {
        useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined })
        if (!directOutput) void maybeUpdateGroupMemory(group.id, conversationId, members, settings)

        // A group conversation is shared context: unlike a private chat, it
        // can naturally colour a member's later 1:1 chat and a follow-up
        // moment. Persist only the model's one-line group summary, never the
        // raw transcript, so this creates continuity without leaking details
        // from messages that were not meant to leave the group.
        if (turnSummary.trim()) {
          await recordSocialEvent({
            type: 'group_turn',
            actorId: speaker?.id ?? 'user',
            relatedContactIds: group.memberContactIds,
            conversationId,
            groupId: group.id,
            messageId: msg.id,
            summary: `群聊“${group.name}”刚聊到：${turnSummary.trim()}`,
            importance: 2,
          })
        }
          }
    },
    onError: (error) => console.error('[group] 气泡写入失败', error),
    onComplete: () => useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined }),
  })
}
