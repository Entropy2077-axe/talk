import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion, coalesceConsecutiveRoles, type ChatMessage } from './deepseek'
import {
  buildGroupSystemPrompt,
  groupTypingDelayMs,
  parseGroupAiResponse,
  pickSpeakers,
  stripSpeakerNamePrefix,
} from './groupChat'
import { extractJsonObject } from './aiProtocol'
import { CONTEXT_WINDOW_SIZE, maybeUpdateGroupMemory, recentMemoriesText } from './memory'
import { knowledgeDigestText, processKnowledgeQueries } from './knowledgeBase'
import { isModuleEnabled } from '../features'
import { describeCurrentTime } from './time'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { buildUserProfileText, useChatEngineStore } from './chatEngine'
import { validateGroupTurn } from './responseQuality'
import { recentSocialEventsText, recordSocialEvent } from './socialEvents'
import { useChatUiStore } from '../store/useChatUiStore'
import type { AppSettings, Contact, Group, GroupAiBubble, Message, Sticker } from '../types'

/** Load recent structured memories for each speaker in parallel. */
async function loadSpeakerMemories(speakers: Contact[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const results = await Promise.all(speakers.map(async (s) => {
    const text = await recentMemoriesText(s.id)
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

function parseGroupTurnDebugPayload(raw: string, bubbles: GroupAiBubble[], knowledgeQueries: string[]): unknown {
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
  useChatEngineStore.getState().patch(conversationId, { error: '' })

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
  useChatEngineStore.getState().patch(conversationId, { error: '' })

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
  engine.patch(conversationId, { aiTyping: true, error: '' })
  console.log(`[group] 开始生成回复 群=${group.name} conversationId=${conversationId}`)
  try {
    if (members.length === 0) {
      engine.patch(conversationId, { error: '这个群里已经没有成员了', aiTyping: false })
      return
    }

    const contactById = new Map(members.map((c) => [c.id, c]))

    const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const messageById = new Map(history.map((m) => [m.id, m]))
    const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')
    const preferredSpeakerIds = new Set(latestUserMessage?.mentions ?? [])
    const replied = latestUserMessage?.replyToMessageId ? messageById.get(latestUserMessage.replyToMessageId) : undefined
    if (replied?.role === 'assistant' && replied.speakerContactId) preferredSpeakerIds.add(replied.speakerContactId)
    const speakers = pickSpeakers(members, Array.from(preferredSpeakerIds))
    console.log(`[group] 本轮发言人: ${speakers.map((s) => s.name).join('、')}`)
    const knowledgeEntries = await db.knowledgeEntries.toArray()
    const targetContext = targetedContextText(latestUserMessage, contactById, messageById, settings.userNickname)
    const recentEventsText = await recentSocialEventsText(members.map((m) => m.id), 4)

    const systemPrompt = buildGroupSystemPrompt({
      stylePrompt: settings.globalSystemPrompt,
      groupName: group.name,
      allMembers: members,
      speakers,
      stickerNames: stickers.map((s) => s.name),
      currentTimeText: describeCurrentTime(new Date()),
      userProfileText: buildUserProfileText(settings),
      targetedContextText: targetContext,
      recentEventsText: recentEventsText || undefined,
      worldviewText: isModuleEnabled('worldview') ? (settings.worldview || undefined) : undefined,
      knowledgeDigestText: isModuleEnabled('knowledgeBase') ? (knowledgeDigestText(knowledgeEntries) || undefined) : undefined,
      selfIterationGlobalText: isModuleEnabled('selfIteration') ? settings.selfIterationGlobalPrompt : undefined,
      speakerMemoriesMap: await loadSpeakerMemories(speakers),
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    // Group history needs an explicit "who said this" label per line — unlike
    // 1:1 chat where the single assistant persona is implicit from the system
    // prompt, a group turn's assistant block can contain several different
    // people, and role:"assistant" alone can't distinguish them across turns.
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: systemPrompt },
      ...recentHistory.map((m): ChatMessage => formatGroupHistoryMessage(m, contactById, messageById, settings.userNickname)),
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
    let finalRaw = raw
    let { bubbles, knowledgeQueries } = parseGroupAiResponse(finalRaw, speakers.length)
    if (bubbles.length > 0) {
      const checked = await validateGroupTurn({
        settings,
        groupName: group.name,
        speakers,
        targetedContext: targetContext,
        raw: finalRaw,
        bubbles,
        signal: controller.signal,
      })
      if (streamByConversation.get(conversationId) !== streamId) return
      if (checked.repaired) {
        console.warn(`[group] 回复已被质量校验重写 群=${group.name} 原因=${checked.reason ?? 'unknown'}`)
        finalRaw = checked.raw
        ;({ bubbles, knowledgeQueries } = parseGroupAiResponse(finalRaw, speakers.length))
      }
    }
    console.log(`[group] 收到回复(${finalRaw.length}字) 解析出${bubbles.length}条气泡 群=${group.name}`)
    if (bubbles.length === 0) {
      console.warn(`[group] 本轮没有人回复 群=${group.name} 原始内容: ${raw.slice(0, 200)}`)
      engine.patch(conversationId, { error: '群里这次没有人回复 可以再发一条试试', aiTyping: false })
      return
    }
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw: finalRaw,
      parsed: parseGroupTurnDebugPayload(finalRaw, bubbles, knowledgeQueries),
      knowledgeQueries,
      createdAt: Date.now(),
    })
    if (isModuleEnabled('knowledgeBase')) processKnowledgeQueries(knowledgeQueries, settings)
    revealGroupBubbles(conversationId, group, members, speakers, bubbles, streamId, settings, aiTurnId)
  } catch (err) {
    if (streamByConversation.get(conversationId) !== streamId) return
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[group] 生成回复出错 群=${group.name}:`, message)
    engine.patch(conversationId, { error: message, aiTyping: false })
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
): void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let cumulative = 0
  bubbles.forEach((bubble, i) => {
    cumulative += groupTypingDelayMs(bubble)
    const timer = setTimeout(async () => {
      if (streamByConversation.get(conversationId) !== streamId) return

      const speaker = speakers[bubble.speakerIndex - 1]
      const content =
        bubble.type === 'text'
          ? stripSpeakerNamePrefix(
              bubble.content,
              members.map((m) => m.name),
            )
          : bubble.name

      const msg: Message = {
        id: uuid(),
        conversationId,
        role: 'assistant',
        type: bubble.type,
        content,
        speakerContactId: speaker?.id,
        debugAiTurnId: aiTurnId,
        debugParsedBubble: bubble,
        createdAt: Date.now(),
      }
      await db.messages.add(msg)
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
        useChatEngineStore.getState().patch(conversationId, { aiTyping: false })
        maybeUpdateGroupMemory(group.id, conversationId, members, settings)
      }
    }, cumulative)
    timers.push(timer)
  })
  timersByConversation.set(conversationId, timers)
}
