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
import { CONTEXT_WINDOW_SIZE, maybeUpdateGroupMemory } from './memory'
import { knowledgeDigestText, processKnowledgeQueries } from './knowledgeBase'
import { describeCurrentTime } from './time'
import { displayName } from './contact'
import { previewForMessage } from './messagePreview'
import { buildUserProfileText, useChatEngineStore } from './chatEngine'
import { useChatUiStore } from '../store/useChatUiStore'
import type { AppSettings, Contact, Group, GroupAiBubble, Message, Sticker } from '../types'

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

export async function sendGroupMessage(
  conversationId: string,
  group: Group,
  members: Contact[],
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

  runGroupAiTurn(conversationId, group, members, settings, stickers, streamId)
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

    const speakers = pickSpeakers(members)
    console.log(`[group] 本轮发言人: ${speakers.map((s) => s.name).join('、')}`)
    const contactById = new Map(members.map((c) => [c.id, c]))

    const history = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const knowledgeEntries = await db.knowledgeEntries.toArray()

    const systemPrompt = buildGroupSystemPrompt({
      stylePrompt: settings.globalSystemPrompt,
      groupName: group.name,
      allMembers: members,
      speakers,
      stickerNames: stickers.map((s) => s.name),
      currentTimeText: describeCurrentTime(new Date()),
      userProfileText: buildUserProfileText(settings),
      worldviewText: settings.worldview || undefined,
      knowledgeDigestText: knowledgeDigestText(knowledgeEntries) || undefined,
    })

    const recentHistory = history.slice(-CONTEXT_WINDOW_SIZE)
    // Group history needs an explicit "who said this" label per line — unlike
    // 1:1 chat where the single assistant persona is implicit from the system
    // prompt, a group turn's assistant block can contain several different
    // people, and role:"assistant" alone can't distinguish them across turns.
    const chatMessages: ChatMessage[] = coalesceConsecutiveRoles([
      { role: 'system', content: systemPrompt },
      ...recentHistory.map((m): ChatMessage => {
        const speakerContact = m.role === 'assistant' && m.speakerContactId ? contactById.get(m.speakerContactId) : undefined
        const speakerLabel = m.role === 'user' ? settings.userNickname || '我' : displayName(speakerContact ?? { name: '某人' })
        const body = m.type === 'sticker' ? `[发了一个表情: ${m.content}]` : m.content
        return { role: m.role, content: `${speakerLabel}: ${body}` }
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
    const { bubbles, knowledgeQueries } = parseGroupAiResponse(raw, speakers.length)
    console.log(`[group] 收到回复(${raw.length}字) 解析出${bubbles.length}条气泡 群=${group.name}`)
    if (bubbles.length === 0) {
      console.warn(`[group] 本轮没有人回复 群=${group.name} 原始内容: ${raw.slice(0, 200)}`)
      engine.patch(conversationId, { error: '群里这次没有人回复 可以再发一条试试', aiTyping: false })
      return
    }
    const aiTurnId = uuid()
    await db.aiTurns.add({
      id: aiTurnId,
      conversationId,
      raw,
      parsed: parseGroupTurnDebugPayload(raw, bubbles, knowledgeQueries),
      knowledgeQueries,
      createdAt: Date.now(),
    })
    processKnowledgeQueries(knowledgeQueries, settings)
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
