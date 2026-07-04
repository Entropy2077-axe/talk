import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { RELATIONSHIP_DIMENSIONS, applyRelationshipDelta, type RelationshipDelta } from './relationship'
import type { Message, RelationshipDimensions } from '../types'

/** How many *new* messages accumulate before we bother refreshing memory. Keeps the extra API call rare. */
export const MEMORY_UPDATE_INTERVAL = 10

/** How many of the most recent messages get sent verbatim to the main chat call. Older context is represented only via the memory summary, not raw text — this is what keeps token usage bounded as a conversation grows. */
export const CONTEXT_WINDOW_SIZE = 30

/**
 * Facts/style memory and the relationship-dimension scores are updated
 * together in one call (same trigger, same batch of new messages) rather
 * than as two separate API calls — they're reading the same evidence, so
 * splitting them would just double the token cost for no benefit.
 */
function buildMemoryUpdatePrompt(
  existingFacts: string,
  existingStyle: string,
  relationship: RelationshipDimensions,
): string {
  const dimensionLines = RELATIONSHIP_DIMENSIONS.map(
    ({ key, label }) => `- ${key}（${label}，当前 ${relationship[key]}/100）`,
  ).join('\n')

  return `你是一个对话记忆整理器 任务是帮一个角色扮演AI维护它对聊天对象的记忆和关系判断 你不会出现在对话里 只输出JSON 不要有其他任何文字

已有记忆:
【已知信息】
${existingFacts || '（暂无）'}
【相处状态】
${existingStyle || '（暂无 默认还比较陌生）'}

当前关系维度（0-100分 满分100）:
${dimensionLines}

接下来会给你一批新的聊天记录（"对方"是用户 "你"是角色扮演AI自己） 请你更新记忆并评估关系变化 输出格式:
{"facts": "...", "style": "...", "relationshipDelta": {"familiarity": 0, "affection": 0, "trust": 0, "romance": 0, "friction": 0}}

要求:
- facts是关于对方(用户)的客观信息 比如名字、年龄、职业、住址、喜好、讨厌的东西、重要的人和事、说过的承诺、正在经历的事情等 只记录聊天里明确提到的 不要编造 用简短的、分号分隔的短语罗列 总长度控制在200字以内 新信息和旧信息冲突时以新的为准 不再重要或已过时的旧信息可以删除 保持精简
- style是这个AI应该如何调整语气和熟悉程度来更贴合这位对话对象 比如"关系变熟了 可以更随便"、"对方喜欢简短回复 你也保持简短"、"对方情绪低落时会安静倾听不追问" 这类相处细节 绝对不能改变角色的核心性格 只是语气和熟悉度上的贴合 总长度控制在150字以内
- 两个字段都必须是非空字符串 如果这批新记录里确实没有值得更新的内容 就把已有记忆原样返回 不要清空
- relationshipDelta是根据这批新聊天记录 对五个关系维度打出的**变化量**（不是新的绝对值） 每个维度取 -10 到 10 之间的整数 0表示这批对话没有明显影响这个维度 比如对方主动分享隐私和感受 familiarity和trust应该上升 对方说了让人开心或贴心的话 affection上升 出现调情、暧昧的互动 romance上升 对方表现出不耐烦、被冷落、起冲突 friction上升 平淡日常闲聊多数维度应该是0或很小的变化 不要因为聊天条数多就无脑加分 要真实评估这批内容本身的性质
- 只输出JSON 不要有markdown代码块标记`
}

function formatMessagesForMemory(messages: Message[]): string {
  return messages
    .map((m) => {
      const speaker = m.role === 'user' ? '对方' : '你'
      if (m.type === 'sticker') return `${speaker}: [发了一个表情: ${m.content}]`
      if (m.type === 'link') return `${speaker}: [分享了一个链接: ${m.content}]`
      return `${speaker}: ${m.content}`
    })
    .join('\n')
}

function parseMemoryResponse(
  raw: string,
): { facts: string; style: string; relationshipDelta: RelationshipDelta } | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.facts === 'string' && typeof parsed?.style === 'string') {
      const rawDelta = parsed.relationshipDelta && typeof parsed.relationshipDelta === 'object' ? parsed.relationshipDelta : {}
      const relationshipDelta: RelationshipDelta = {}
      for (const { key } of RELATIONSHIP_DIMENSIONS) {
        const v = rawDelta[key]
        if (typeof v === 'number' && Number.isFinite(v)) relationshipDelta[key] = v
      }
      return { facts: parsed.facts.trim(), style: parsed.style.trim(), relationshipDelta }
    }
  } catch {
    // ignore malformed response, memory update is best-effort
  }
  return null
}

/**
 * Fire-and-forget: if enough new messages have piled up since the last
 * memory refresh, summarize them into the contact's compact facts/style
 * memory and nudge the relationship dimensions. Silently does nothing on
 * failure — this is an enhancement, it must never block or break the chat.
 */
export async function maybeUpdateMemory(
  contactId: string,
  conversationId: string,
  api: { apiKey: string; baseUrl: string; model: string },
): Promise<void> {
  try {
    const contact = await db.contacts.get(contactId)
    if (!contact) return

    const allMessages = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const cursor = contact.memoryMessageCursor ?? 0
    const newMessages = allMessages.slice(cursor)
    if (newMessages.length < MEMORY_UPDATE_INTERVAL) return

    const raw = await chatCompletion({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      model: api.model,
      messages: [
        {
          role: 'system',
          content: buildMemoryUpdatePrompt(contact.memoryFacts, contact.memoryStyle, contact.relationship),
        },
        { role: 'user', content: formatMessagesForMemory(newMessages) },
      ],
    })
    const updated = parseMemoryResponse(raw)
    if (!updated) return

    await db.contacts.update(contact.id, {
      memoryFacts: updated.facts,
      memoryStyle: updated.style,
      memoryUpdatedAt: Date.now(),
      memoryMessageCursor: allMessages.length,
      relationship: applyRelationshipDelta(contact.relationship, updated.relationshipDelta),
    })
  } catch {
    // best-effort only
  }
}

export async function resetMemory(contactId: string): Promise<void> {
  await db.contacts.update(contactId, {
    memoryFacts: '',
    memoryStyle: '',
    memoryUpdatedAt: 0,
    memoryMessageCursor: 0,
  })
}
