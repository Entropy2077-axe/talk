import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import {
  buildGroupJsonConversionPrompt,
  buildGroupRawChatPrompt,
  groupTypingDelayMs,
  parseGroupAiResponse,
  pickSociallyConnectedSpeakers,
  stripSpeakerNamePrefix,
} from './groupChat'
import { extractJsonObject } from './aiProtocol'
import { CONTEXT_WINDOW_SIZE, activeUpcomingPlansText, maybeUpdateGroupMemory, nonGroupScopedMemoriesText } from './memory'
import { aiRelationshipPrompt } from './contactRelations'
import { knowledgeDigestText, resolveKnowledgeQueries } from './knowledgeBase'
import { isModuleEnabled } from '../features'
import { describeCurrentTime } from './time'
import { describeCurrentSchedule } from './schedule'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { buildUserProfileText, useChatEngineStore } from './chatEngine'
import { validateGroupDraft, validateGroupTurn } from './responseQuality'
import { searchPexelsPhoto } from './photoSearch'
import { recentSocialEventsText, recordSocialEvent } from './socialEvents'
import { recentSharedOriginalContext } from './sharedRecentContext'
import { createGroupPlan, planCardMessage } from './groupPlans'
import { useChatUiStore } from '../store/useChatUiStore'
import { retrieveWorldbookContext } from './worldbook'
import { generateGroupStoryOutline, storyOutlinePromptSection } from './storyOutline'
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
const streamByConversation = new Map<string, string>()
const timersByConversation = new Map<string, ReturnType<typeof setTimeout>[]>()
const abortByConversation = new Map<string, AbortController>()

function clearPending(conversationId: string) {
  timersByConversation.get(conversationId)?.forEach(clearTimeout)
  timersByConversation.set(conversationId, [])
  abortByConversation.get(conversationId)?.abort()
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
  const trimmed = finalRaw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenceMatch ? fenceMatch[1].trim() : trimmed
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>), mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } } : parsed
  } catch {
    const extracted = extractJsonObject(text)
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted)
        return parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>), mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } } : parsed
      } catch {
        // fall through
      }
    }
  }
  return { mainPrompt, rawText, draftFeedback, jsonRaw, finalRaw, parsedBubbles: bubbles, knowledgeQueries, turnSummary, groupVibe, storyOutline, promptTrace: { sections: [{ label: '群聊主提示词', content: mainPrompt }] } }
}

/** Admin-only safe stop for a group generation and its queued bubbles. */
export function stopGroupAiTurn(conversationId: string): void {
  streamByConversation.set(conversationId, uuid())
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { aiTyping: false, typingLabel: undefined, error: '已由管理员停止本轮群聊生成' })
}

function parseCompressedGroupMemory(raw: string): string | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.memory === 'string' && parsed.memory.trim() ? parsed.memory.trim() : null
  } catch {
    return null
  }
}

async function updateGroupMemoryAndVibe(opts: {
  group: Group
  aiTurnId: string
  settings: AppSettings
  turnSummary: string
  groupVibe: string
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

  if (nextTurnCount % 5 === 0 && appendedMemory.trim()) {
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
  if (!settings.apiKey) {
    useChatEngineStore.getState().patch(conversationId, { error: '还没有配置API Key 请先去"我-设置"里填写' })
    return
  }

  const streamId = uuid()
  streamByConversation.set(conversationId, streamId)
  clearPending(conversationId)
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: '群成员' })

  const msg: Message = {
    id: uuid(),
    conversationId,
    role: 'user',
    type: 'text',
    content: text.trim(),
    mentions: mentionContactIds.length > 0 ? Array.from(new Set(mentionContactIds)) : undefined,
    replyToMessageId,
    createdAt: Date.now(),
  }
  await db.messages.add(msg)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })
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

  runGroupAiTurn(conversationId, group, members, settings, stickers, streamId)
}

export async function regenerateGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
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
  useChatEngineStore.getState().patch(conversationId, { error: '', typingLabel: '群成员' })

  const turnMessages = await db.messages
    .where('conversationId')
    .equals(conversationId)
    .filter((message) => message.debugAiTurnId === aiTurnId)
    .toArray()
  if (turnMessages.length > 0) await db.messages.bulkDelete(turnMessages.map((message) => message.id))
  await db.aiTurns.delete(aiTurnId)
  await db.conversations.update(conversationId, { updatedAt: Date.now() })

  await runGroupAiTurn(conversationId, group, members, settings, stickers, streamId)
}

async function runGroupAiTurn(
  conversationId: string,
  group: Group,
  members: Contact[],
  settings: AppSettings,
  stickers: Sticker[],
  streamId: string,
): Promise<void> {
  const engine = useChatEngineStore.getState()
  engine.patch(conversationId, { aiTyping: true, error: '', typingLabel: '群成员' })
  console.log(`[group] 开始生成回复 群=${group.name} conversationId=${conversationId}`)
  try {
    if (members.length === 0) {
      engine.patch(conversationId, { error: '这个群里已经没有成员了', aiTyping: false, typingLabel: undefined })
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
    const knowledgeEntries = await db.knowledgeEntries.toArray()
    const targetContext = targetedContextText(latestUserMessage, contactById, messageById, settings.userNickname)
    const recentEventsText = await recentSocialEventsText(members.map((m) => m.id), 4)
    const sharedOriginalContext = await recentSharedOriginalContext(members.map((m) => m.id), settings.userNickname, { maxMessages: 120, maxChars: 20_000 })
    const worldbookText = isModuleEnabled('worldview') ? await retrieveWorldbookContext([group.name, group.vibe, targetContext, history.slice(-10).map((m) => m.content).join(' '), members.map((m) => `${m.name} ${m.systemPrompt}`).join(' ')].filter(Boolean).join('\n')) : ''

    const speakerMemoriesMap = await loadSpeakerMemories(speakers)
    const aiRelationshipText = await aiRelationshipPrompt(members)
    const systemPrompt = buildGroupRawChatPrompt({
      stylePrompt: settings.globalSystemPrompt,
      groupName: group.name,
      allMembers: members,
      speakers,
      stickerNames: stickers.map((s) => s.name),
      groupMemoryText: group.memory,
      groupVibeText: group.vibe,
      allowAiChatter: group.allowAiChatter ?? true,
      energyLevel: group.energyLevel ?? 'normal',
      currentTimeText: describeCurrentTime(new Date()),
      userProfileText: buildUserProfileText(settings),
      targetedContextText: targetContext,
      recentEventsText: recentEventsText || undefined,
      worldviewText: worldbookText || undefined,
      knowledgeDigestText: isModuleEnabled('knowledgeBase') ? (knowledgeDigestText(knowledgeEntries) || undefined) : undefined,
      selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
      speakerMemoriesMap,
      aiRelationshipText,
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    const controller = new AbortController()
    abortByConversation.set(conversationId, controller)

    let storyOutline = ''
    if (isModuleEnabled('storyOutline')) {
      const speakerPremises = speakers
        .map((speaker, i) => {
          const recentMemo = speakerMemoriesMap.get(speaker.id)
          return `发言人${i + 1}: ${displayName(speaker)}
人设: ${speaker.systemPrompt || '自由发挥'}
关系: ${speaker.relationshipBase || '朋友'}${speaker.relationshipDynamic ? `（${speaker.relationshipDynamic}）` : ''}
记忆: ${speaker.memoryFacts || '暂无'}
相处习惯: ${speaker.memoryStyle || '暂无'}
当前状态: ${describeCurrentSchedule(speaker, new Date()) || '没有特别安排'}
约定: ${activeUpcomingPlansText(speaker, new Date()) || '无'}${recentMemo ? `\n最近记忆碎片:\n${recentMemo}` : ''}`
        })
        .join('\n\n')
      const premiseText = [
        `【群名】${group.name}`,
        `【群成员】\n${members.map((m) => `- ${displayName(m)}`).join('\n')}`,
        group.memory ? `【群聊记忆】\n${group.memory}` : '',
        group.vibe ? `【群聊氛围】\n${group.vibe}` : '',
        `【当前时间】${describeCurrentTime(new Date())}`,
        `【用户资料】${buildUserProfileText(settings)}`,
        targetContext ? `【本轮定向上下文】\n${targetContext}` : '',
        recentEventsText ? `【最近发生的事】\n${recentEventsText}` : '',
        worldbookText ? `【世界书命中】\n${worldbookText}` : '',
        `【发言人逻辑前提】\n${speakerPremises}`,
      ].filter(Boolean).join('\n\n')
      try {
        storyOutline = await generateGroupStoryOutline({
          settings,
          groupName: group.name,
          members,
          speakers,
          premiseText,
          history: recentHistory,
          allowAiChatter: group.allowAiChatter ?? true,
          energyLevel: group.energyLevel ?? 'normal',
          signal: controller.signal,
        })
        if (storyOutline) console.log(`[story-outline][group] 群=${group.name}\n${storyOutline}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[story-outline][group] 生成失败 群=${group.name}: ${message}`)
      }
      if (streamByConversation.get(conversationId) !== streamId) return
    }

    const outlineSection = storyOutlinePromptSection(storyOutline)
    // Group history needs an explicit "who said this" label per line — unlike
    // 1:1 chat where the single assistant persona is implicit from the system
    // prompt, a group turn's assistant block can contain several different
    // people, and role:"assistant" alone can't distinguish them across turns.
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: [systemPrompt, sharedOriginalContext, outlineSection].filter(Boolean).join('\n\n') },
      ...recentHistory.map((m): ChatMessage => formatGroupHistoryMessage(m, contactById, messageById, settings.userNickname)),
    ])
    let rawText = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      messages: chatMessages,
      signal: controller.signal,
      purpose: 'chat',
      trace: { turnId: streamId, stage: 'first_chat', conversationId },
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    console.log(`[group] 主模型群聊草稿(${rawText.length}字): ${rawText.slice(0, 160)}...`)
    let draftFeedback: string | undefined
    const draftCheck = await validateGroupDraft({
      settings,
      groupName: group.name,
      speakers,
      rawText,
      allowAiChatter: group.allowAiChatter ?? true,
      energyLevel: group.energyLevel ?? 'normal',
      targetedContext: targetContext,
      sharedRecentContext: sharedOriginalContext,
      worldbookText: worldbookText || undefined,
      signal: controller.signal,
      trace: { turnId: streamId, stage: 'first_quality', conversationId },
    })
    if (streamByConversation.get(conversationId) !== streamId) return
    if (!draftCheck.valid) {
      draftFeedback = draftCheck.reason || '草稿不符合群聊特殊规则'
      console.warn(`[group] 主模型草稿未通过校验 群=${group.name} 原因=${draftFeedback}`)
      rawText = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: coalesceConsecutiveRoles([
          ...chatMessages,
          {
            role: 'user',
            content: `上一版群聊草稿没有通过校验，请严格按反馈重写一次。

【校验反馈】
${draftFeedback}

【上一版草稿】
${rawText}

必须重新输出群聊纯文本草稿，不要解释，不要输出JSON。
第一行第一个字符必须是 <。
每一行必须严格是: <人名>（想法）[心情]“消息内容”
尤其注意：AI互聊规则、群聊热闹程度、每行必须有非空（想法）和非空[心情]，消息内容里不要残留人名冒号/括号/方括号。
如果上一版反复使用同一个特殊词、梗、比喻、称号或外号，这一版必须减少复读，并自然收束或换到相邻话题。`,
          },
        ]),
        signal: controller.signal,
        purpose: 'chat',
        trace: { turnId: streamId, stage: 'second_chat', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      console.log(`[group] 主模型重写草稿(${rawText.length}字): ${rawText.slice(0, 160)}...`)
    }

    let jsonRaw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel,
      messages: [
        {
          role: 'system',
          content: buildGroupJsonConversionPrompt(rawText, speakers, stickers.map((s) => s.name)),
        },
      ],
      jsonMode: true,
      signal: controller.signal,
      trace: { turnId: streamId, stage: 'other', conversationId },
    })

    if (streamByConversation.get(conversationId) !== streamId) return
    let finalRaw = jsonRaw
    let { bubbles, knowledgeQueries, turnSummary, groupVibe, planCandidates } = parseGroupAiResponse(finalRaw, speakers.length)
    const initiallyRequestedKnowledge = [...knowledgeQueries]
    let reviewFailure = draftFeedback
    if (bubbles.length > 0) {
      const checked = await validateGroupTurn({
        settings,
        groupName: group.name,
        speakers,
        targetedContext: targetContext,
        sharedRecentContext: sharedOriginalContext,
        raw: finalRaw,
        bubbles,
        worldbookText: worldbookText || undefined,
        signal: controller.signal,
        trace: { turnId: streamId, stage: 'second_quality', conversationId },
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      if (checked.repaired) {
        console.warn(`[group] 回复已被质量校验重写 群=${group.name} 原因=${checked.reason ?? 'unknown'}`)
        finalRaw = checked.raw
        reviewFailure = checked.reason || '群聊回复审查未通过'
        ;({ bubbles, knowledgeQueries, turnSummary, groupVibe, planCandidates } = parseGroupAiResponse(finalRaw, speakers.length))
      } else if (checked.detectedInvalid) {
        reviewFailure = checked.reason || '群聊回复审查未通过'
        console.warn(`[group] 审查发现问题但未能修复 群=${group.name} 原因=${checked.reason ?? 'unknown'}`)
      }
    }
    knowledgeQueries = Array.from(new Set([...initiallyRequestedKnowledge, ...knowledgeQueries])).slice(0, 2)
    if (isModuleEnabled('knowledgeBase') && knowledgeQueries.length > 0) {
      const knowledge = await resolveKnowledgeQueries(knowledgeQueries, settings)
      if (knowledge.text) {
        rawText = await chatCompletion({ apiKey:settings.apiKey,baseUrl:settings.baseUrl,model:settings.model,messages:[...chatMessages,{role:'user',content:`刚才出现了你们不了解的词。搜索结果如下：\n${knowledge.text}${reviewFailure?`\n\n上一版审查问题：${reviewFailure}，重写时同时修正。`:''}\n请基于结果重新生成群聊草稿，保持原群聊格式，像刚查明白后自然接话，不要写成报告。`}],signal:controller.signal, trace:{turnId:streamId,stage:'second_chat',conversationId} })
        jsonRaw = await chatCompletion({apiKey:settings.apiKey,baseUrl:settings.baseUrl,model:settings.utilityModel,messages:[{role:'system',content:buildGroupJsonConversionPrompt(rawText,speakers,stickers.map(s=>s.name))}],jsonMode:true,signal:controller.signal,trace:{turnId:streamId,stage:'other',conversationId}})
        finalRaw=jsonRaw
        ;({bubbles,knowledgeQueries,turnSummary,groupVibe,planCandidates}=parseGroupAiResponse(finalRaw,speakers.length))
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
    void updateGroupMemoryAndVibe({ group, aiTurnId, settings, turnSummary, groupVibe })
    revealGroupBubbles(conversationId, group, members, speakers, bubbles, streamId, settings, aiTurnId, turnSummary)
  } catch (err) {
    if (streamByConversation.get(conversationId) !== streamId) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[group] 生成回复出错 群=${group.name}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false, typingLabel: undefined })
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
  aiTurnId: string,
  turnSummary: string,
): void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let cumulative = 0
  bubbles.forEach((bubble, i) => {
    cumulative += groupTypingDelayMs(bubble)
    const timer = setTimeout(async () => {
      if (streamByConversation.get(conversationId) !== streamId) return

      const speaker = speakers[bubble.speakerIndex - 1]
      useChatEngineStore.getState().patch(conversationId, {
        typingLabel: speaker ? displayName(speaker) : '群成员',
      })
      let imagePayload: Message['image']
      let imageFailed=false
      if (bubble.type === 'image') { if(!settings.pexelsApiKey)imageFailed=true; else try{const photo=await searchPexelsPhoto(settings.pexelsApiKey,bubble.query,'landscape');if(!photo)imageFailed=true;else imagePayload={url:photo.url,caption:bubble.caption,photographer:photo.photographer,photographerUrl:photo.photographerUrl,query:bubble.query}}catch{imageFailed=true} }
      const content =
        bubble.type === 'text'
          ? stripSpeakerNamePrefix(
              bubble.content,
              members.map((m) => m.name),
            )
          : bubble.type === 'sticker' ? bubble.name : imageFailed ? '图片没发出来…' : bubble.caption || '[图片]'

      const msg: Message = {
        id: uuid(),
        conversationId,
        role: 'assistant',
        type: bubble.type === 'image' && imageFailed ? 'text' : bubble.type,
        content,
        speakerContactId: speaker?.id,
        debugAiTurnId: aiTurnId,
        debugParsedBubble: bubble,
        thought: bubble.thought,
        image: imagePayload,
        createdAt: Date.now(),
      }
      await db.messages.add(msg)
      if (speaker?.id && bubble.mood) {
        await db.contacts.update(speaker.id, {
          mood: { text: bubble.mood, expiresAt: Date.now() + settings.moodExpiryMs },
        })
      }
      await db.conversations.update(conversationId, { updatedAt: Date.now() })

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
        maybeUpdateGroupMemory(group.id, conversationId, members, settings)

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
    }, cumulative)
    timers.push(timer)
  })
  timersByConversation.set(conversationId, timers)
}
