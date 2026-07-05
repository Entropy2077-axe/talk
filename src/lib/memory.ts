import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { RELATIONSHIP_DIMENSIONS, applyRelationshipDelta, type RelationshipDelta } from './relationship'
import { displayName } from './contact'
import { describeCurrentTime, toDateKey } from './time'
import type { Contact, Message, PlanItem, RelationshipDimensions } from '../types'

/** How many *new* messages accumulate before we bother refreshing memory. Keeps the extra API call rare. */
export const MEMORY_UPDATE_INTERVAL = 10

/** How many of the most recent messages get sent verbatim to the main chat call. Older context is represented only via the memory summary, not raw text — this is what keeps token usage bounded as a conversation grows. */
export const CONTEXT_WINDOW_SIZE = 30

/** Bounds how many upcoming plans a contact can accumulate — old/expired ones are pruned, but this is a hard backstop against unbounded growth for plans with no resolvable date. */
const MAX_UPCOMING_PLANS = 8

/** Plans whose date has passed are no longer "upcoming" — filters both for prompt injection and for what gets persisted back at the next memory update. */
export function activeUpcomingPlans(plans: PlanItem[], now: Date): PlanItem[] {
  const todayKey = toDateKey(now)
  return plans.filter((p) => !p.date || p.date >= todayKey)
}

/** Model-facing text block for the "what have you two arranged" prompt section — empty string if nothing active, so callers can skip the section entirely. */
export function activeUpcomingPlansText(contact: Pick<Contact, 'upcomingPlans'>, now: Date): string {
  const active = activeUpcomingPlans(contact.upcomingPlans ?? [], now)
  if (active.length === 0) return ''
  return active.map((p) => (p.date ? `- [${p.date}] ${p.text}` : `- ${p.text}`)).join('\n')
}

function plansPromptFragment(): string {
  return `- plans只列这批记录里**新出现**的、双方明确约好的具体安排或承诺(不是正式委托系统里的那种委托 是随口聊到的约定 比如"周三一起吃饭") 不要重复已经在"已知约定"里出现过的 如果结合当前时间能推算出具体日期就填date(格式YYYY-MM-DD) 算不出来就留空字符串 这批记录里没有新约定就返回空数组`
}

/**
 * Facts/style memory, the relationship-dimension scores, and now upcoming
 * plans are all updated together in one call (same trigger, same batch of
 * new messages) rather than as separate API calls — they're reading the
 * same evidence, so splitting them would just multiply the token cost for
 * no benefit.
 */
function buildMemoryUpdatePrompt(
  existingFacts: string,
  existingStyle: string,
  existingPlansText: string,
  relationship: RelationshipDimensions,
  currentTimeText: string,
): string {
  const dimensionLines = RELATIONSHIP_DIMENSIONS.map(
    ({ key, label }) => `- ${key}（${label}，当前 ${relationship[key]}/100）`,
  ).join('\n')

  return `你是一个对话记忆整理器 任务是帮一个角色扮演AI维护它对聊天对象的记忆和关系判断 你不会出现在对话里 只输出JSON 不要有其他任何文字

【当前时间】
${currentTimeText}

已有记忆:
【已知信息】
${existingFacts || '（暂无）'}
【相处状态】
${existingStyle || '（暂无 默认还比较陌生）'}
【已知约定】
${existingPlansText || '（暂无）'}

当前关系维度（0-100分 满分100）:
${dimensionLines}

接下来会给你一批新的聊天记录（"对方"是用户 "你"是角色扮演AI自己） 请你更新记忆并评估关系变化 输出格式:
{"facts": "...", "style": "...", "relationshipDelta": {"familiarity": 0, "affection": 0, "trust": 0, "romance": 0, "friction": 0}, "plans": [{"text": "...", "date": "YYYY-MM-DD或空字符串"}]}

要求:
- facts是关于对方(用户)的客观信息 比如名字、年龄、职业、住址、喜好、讨厌的东西、重要的人和事、正在经历的事情等 只记录聊天里明确提到的 不要编造 用简短的、分号分隔的短语罗列 总长度控制在200字以内 新信息和旧信息冲突时以新的为准 不再重要或已过时的旧信息可以删除 保持精简
- style是这个AI应该如何调整语气和熟悉程度来更贴合这位对话对象 比如"关系变熟了 可以更随便"、"对方喜欢简短回复 你也保持简短"、"对方情绪低落时会安静倾听不追问" 这类相处细节 绝对不能改变角色的核心性格 只是语气和熟悉度上的贴合 总长度控制在150字以内
- facts和style都必须是非空字符串 如果这批新记录里确实没有值得更新的内容 就把已有记忆原样返回 不要清空
- relationshipDelta是根据这批新聊天记录 对五个关系维度打出的**变化量**（不是新的绝对值） 每个维度取 -10 到 10 之间的整数 0表示这批对话没有明显影响这个维度 比如对方主动分享隐私和感受 familiarity和trust应该上升 对方说了让人开心或贴心的话 affection上升 出现调情、暧昧的互动 romance上升 对方表现出不耐烦、被冷落、起冲突 friction上升 平淡日常闲聊多数维度应该是0或很小的变化 不要因为聊天条数多就无脑加分 要真实评估这批内容本身的性质
${plansPromptFragment()}
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

interface ParsedPlan {
  text: string
  date?: string
}

function parsePlansField(raw: unknown): ParsedPlan[] {
  if (!Array.isArray(raw)) return []
  const result: ParsedPlan[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const text = typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text.trim() : ''
    if (!text) continue
    const rawDate = (p as { date?: unknown }).date
    const date = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined
    result.push({ text, date })
  }
  return result
}

function parseMemoryResponse(
  raw: string,
): { facts: string; style: string; relationshipDelta: RelationshipDelta; plans: ParsedPlan[] } | null {
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
      return {
        facts: parsed.facts.trim(),
        style: parsed.style.trim(),
        relationshipDelta,
        plans: parsePlansField(parsed.plans),
      }
    }
  } catch {
    // ignore malformed response, memory update is best-effort
  }
  return null
}

function mergePlans(existing: PlanItem[], newOnes: ParsedPlan[], now: number): PlanItem[] {
  const active = activeUpcomingPlans(existing, new Date(now))
  const added: PlanItem[] = newOnes.map((p) => ({ id: uuid(), text: p.text, date: p.date, createdAt: now }))
  return [...active, ...added].slice(-MAX_UPCOMING_PLANS)
}

/**
 * Fire-and-forget: if enough new messages have piled up since the last
 * memory refresh, summarize them into the contact's compact facts/style
 * memory, nudge the relationship dimensions, and fold in any newly
 * mentioned plans/appointments. Silently does nothing on failure — this is
 * an enhancement, it must never block or break the chat.
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
          content: buildMemoryUpdatePrompt(
            contact.memoryFacts,
            contact.memoryStyle,
            activeUpcomingPlansText(contact, new Date()),
            contact.relationship,
            describeCurrentTime(new Date()),
          ),
        },
        { role: 'user', content: formatMessagesForMemory(newMessages) },
      ],
      jsonMode: true,
    })
    const updated = parseMemoryResponse(raw)
    if (!updated) return

    const now = Date.now()
    await db.contacts.update(contact.id, {
      memoryFacts: updated.facts,
      memoryStyle: updated.style,
      memoryUpdatedAt: now,
      memoryMessageCursor: allMessages.length,
      relationship: applyRelationshipDelta(contact.relationship, updated.relationshipDelta),
      upcomingPlans: mergePlans(contact.upcomingPlans ?? [], updated.plans, now),
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
    upcomingPlans: [],
  })
}

// ---- group chat memory (see groupChatEngine.ts) ----
// A single shared call updates every member who actually spoke in the new
// batch of group messages — same "one call, positional output" shape as
// moments.ts and groupChat.ts, so cost stays flat regardless of group size.
// No relationshipDelta here (scope cut, see CLAUDE.md): there's no
// per-group relationship model to nudge, only the plain user-AI one.

function formatGroupMessagesForMemory(
  messages: Message[],
  memberById: Map<string, Contact>,
  userNickname: string,
): string {
  return messages
    .map((m) => {
      const speakerName =
        m.role === 'user'
          ? userNickname || '对方'
          : displayName(m.speakerContactId ? (memberById.get(m.speakerContactId) ?? { name: '某人' }) : { name: '某人' })
      if (m.type === 'sticker') return `${speakerName}: [发了一个表情: ${m.content}]`
      return `${speakerName}: ${m.content}`
    })
    .join('\n')
}

function buildGroupMemoryUpdatePrompt(opts: {
  groupName: string
  transcript: string
  currentTimeText: string
  speakers: Contact[]
}): string {
  const speakerBlocks = opts.speakers
    .map(
      (c, i) => `发言人${i + 1}: ${c.name}
已知信息: ${c.memoryFacts || '（暂无）'}
相处状态: ${c.memoryStyle || '（暂无）'}
已知约定: ${activeUpcomingPlansText(c, new Date()) || '（暂无）'}`,
    )
    .join('\n\n')

  return `你是一个群聊记忆整理器 任务是帮群聊"${opts.groupName}"里的每个角色扮演AI维护它对用户(群里的"对方")的记忆 你不会出现在对话里 只输出JSON 不要有其他任何文字

【当前时间】
${opts.currentTimeText}

下面是这个群聊最近的一批聊天记录:
${opts.transcript}

下面几位是这批记录里说过话的人 需要分别帮他们更新记忆(只根据这批记录里能看到的信息更新 不要编造 也不要互相搞混):

${speakerBlocks}

输出格式:
{
  "updates": [
    { "facts": "...", "style": "...", "plans": [{"text": "...", "date": "YYYY-MM-DD或空字符串"}] }
  ]
}

要求:
- updates数组顺序必须和上面"发言人1/发言人2/..."顺序完全一致 数量必须完全一致
- facts客观信息≤200字 分号分隔 style相处语气建议≤150字 含义跟"已知信息"/"相处状态"一致 如果这批记录里对某人确实没有新增内容 就把对应已知信息原样返回 不要清空
${plansPromptFragment()}
- 只输出JSON 不要markdown代码块标记`
}

interface GroupMemoryUpdate {
  facts: string
  style: string
  plans: ParsedPlan[]
}

function parseGroupMemoryResponse(raw: string, expectedCount: number): GroupMemoryUpdate[] | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.updates) || parsed.updates.length !== expectedCount) return null
    const result: GroupMemoryUpdate[] = []
    for (const u of parsed.updates) {
      if (!u || typeof u.facts !== 'string' || typeof u.style !== 'string') return null
      result.push({ facts: u.facts.trim(), style: u.style.trim(), plans: parsePlansField(u.plans) })
    }
    return result
  } catch {
    return null
  }
}

/**
 * Fire-and-forget group-chat counterpart to maybeUpdateMemory. The cursor
 * lives on the Group (not per-contact) since a contact's own
 * memoryMessageCursor already tracks their 1:1 conversation and a contact
 * can belong to several groups at once. Only members who actually spoke in
 * the new batch get updated — a silent member sitting in the group doesn't
 * need their personal memory of the user touched.
 */
export async function maybeUpdateGroupMemory(
  groupId: string,
  conversationId: string,
  members: Contact[],
  api: { apiKey: string; baseUrl: string; model: string; userNickname: string },
): Promise<void> {
  try {
    const group = await db.groups.get(groupId)
    if (!group) return

    const allMessages = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const cursor = group.memoryMessageCursor ?? 0
    const newMessages = allMessages.slice(cursor)
    if (newMessages.length < MEMORY_UPDATE_INTERVAL) return

    const memberById = new Map(members.map((c) => [c.id, c]))
    const speakerIds = Array.from(
      new Set(
        newMessages
          .filter((m): m is Message & { speakerContactId: string } => m.role === 'assistant' && !!m.speakerContactId)
          .map((m) => m.speakerContactId),
      ),
    )
    const speakers = speakerIds.map((id) => memberById.get(id)).filter((c): c is Contact => !!c)

    if (speakers.length === 0) {
      // Nothing to attribute this batch to (e.g. a parse failure produced no
      // assistant bubbles) — still advance the cursor so it isn't reprocessed forever.
      await db.groups.update(groupId, { memoryMessageCursor: allMessages.length })
      return
    }

    const raw = await chatCompletion({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      model: api.model,
      messages: [
        {
          role: 'system',
          content: buildGroupMemoryUpdatePrompt({
            groupName: group.name,
            transcript: formatGroupMessagesForMemory(newMessages, memberById, api.userNickname),
            currentTimeText: describeCurrentTime(new Date()),
            speakers,
          }),
        },
        { role: 'user', content: '请生成' },
      ],
      jsonMode: true,
    })

    const updates = parseGroupMemoryResponse(raw, speakers.length)
    if (!updates) {
      await db.groups.update(groupId, { memoryMessageCursor: allMessages.length })
      return
    }

    const now = Date.now()
    for (let i = 0; i < speakers.length; i++) {
      const contact = speakers[i]
      const update = updates[i]
      await db.contacts.update(contact.id, {
        memoryFacts: update.facts,
        memoryStyle: update.style,
        memoryUpdatedAt: now,
        upcomingPlans: mergePlans(contact.upcomingPlans ?? [], update.plans, now),
      })
    }
    await db.groups.update(groupId, { memoryMessageCursor: allMessages.length })
  } catch {
    // best-effort only
  }
}
