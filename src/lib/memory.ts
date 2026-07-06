import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { clampWarmthDelta, applyWarmthDelta, warmthStage, shouldUpdateBase, containsBreakupLanguage, WARMTH_BREAKUP_PENALTY, traitWarmthModifier } from './relationship'
import { displayName } from './contact'
import { describeCurrentTime, toDateKey } from './time'
import type { AppSettings, Contact, Message, PlanItem } from '../types'

/** How many *new* messages accumulate before we bother refreshing memory. Keeps the extra API call rare. */
export const MEMORY_UPDATE_INTERVAL = 10

/** How many of the most recent messages get sent verbatim to the main chat call. */
export const CONTEXT_WINDOW_SIZE = 30

/** Bounds how many upcoming plans a contact can accumulate. */
const MAX_UPCOMING_PLANS = 8

export function activeUpcomingPlans(plans: PlanItem[], now: Date): PlanItem[] {
  const todayKey = toDateKey(now)
  return plans.filter((p) => !p.date || p.date >= todayKey)
}

export function activeUpcomingPlansText(contact: Pick<Contact, 'upcomingPlans'>, now: Date): string {
  const active = activeUpcomingPlans(contact.upcomingPlans ?? [], now)
  if (active.length === 0) return ''
  return active.map((p) => (p.date ? `- [${p.date}] ${p.text}` : `- ${p.text}`)).join('\n')
}

function plansPromptFragment(): string {
  return `- plans: 这批记录里新出现的约定/安排(不是正式委托 是随口聊到的 比如"周三一起吃饭") 不要重复"已知约定"里已有的 能推算出日期就填date(YYYY-MM-DD) 算不出来留空 没有新约定就返回空数组`
}

// ---- 1:1 memory update (now also handles warmth scoring) ----

function buildMemoryUpdatePrompt(opts: {
  existingFacts: string
  existingStyle: string
  existingPlansText: string
  warmth: number
  currentTimeText: string
}): string {
  const stage = warmthStage(opts.warmth)
  return `你是对话记忆整理器 也是好感度评分员 输出JSON 不要有其他任何文字

【当前时间】
${opts.currentTimeText}

【已知信息】
${opts.existingFacts || '（暂无）'}
【相处状态】
${opts.existingStyle || '（暂无）'}
【已知约定】
${opts.existingPlansText || '（暂无）'}
【当前好感度】${opts.warmth}/100（${stage.label}）

接下来是一批新的聊天记录（"对方"是用户 "你"是角色扮演AI） 请更新记忆并评估好感度变化 输出:
{"facts":"...", "style":"...", "plans":[{"text":"...", "date":"YYYY-MM-DD或空字符串"}], "warmthDelta": 0, "relationshipAssessment":"..."}

要求:
- facts: 关于对方的客观信息(名字/年龄/喜好/重要事件等) 只记聊天里明确提到的 ≤200字 分号分隔 新旧冲突以新为准
- style: AI应如何调整语气来贴合对方 ≤150字 不改变核心性格
- facts和style有值得更新的才改 没有就原样返回 不要清空
${plansPromptFragment()}
- warmthDelta: 根据这批聊天记录的语气和互动质量 好感度应该变化多少(-5到+5整数) 聊得好→正数 聊崩了→负数 平平无奇→0 不要因为好感度已经很高/很低就不敢给分
- relationshipAssessment: 每次都要写 描述当前关系实际状态 一句话 不超过30字 比如"虽然是恋人但最近闹得很僵"或"关系升温很快 比普通朋友亲密多了"或"维持现状 关系稳定"`
}

function formatMessagesForMemory(messages: Message[]): string {
  return messages
    .map((m) => {
      const speaker = m.role === 'user' ? '对方' : '你'
      if (m.type === 'sticker') return `${speaker}: [表情: ${m.content}]`
      if (m.type === 'link') return `${speaker}: [链接: ${m.content}]`
      if (m.type === 'gift') return `${speaker}: [礼物: ${m.content}]`
      if (m.type === 'scheduleChange') return `${speaker}: [日程: ${m.content}]`
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

interface MemoryUpdateResult {
  facts: string
  style: string
  plans: ParsedPlan[]
  warmthDelta: number
  relationshipAssessment: string
}

function parseMemoryResponse(raw: string): MemoryUpdateResult | null {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.facts === 'string' && typeof parsed?.style === 'string') {
      const delta = typeof parsed.warmthDelta === 'number' ? parsed.warmthDelta : Number(parsed.warmthDelta)
      const assessment = typeof parsed.relationshipAssessment === 'string' ? parsed.relationshipAssessment.trim() : ''
      return {
        facts: parsed.facts.trim(),
        style: parsed.style.trim(),
        plans: parsePlansField(parsed.plans),
        warmthDelta: Number.isFinite(delta) ? clampWarmthDelta(delta) : 0,
        relationshipAssessment: assessment.slice(0, 80),
      }
    }
  } catch {
    // ignore
  }
  return null
}

function mergePlans(existing: PlanItem[], newOnes: ParsedPlan[], now: number): PlanItem[] {
  const active = activeUpcomingPlans(existing, new Date(now))
  const added: PlanItem[] = newOnes.map((p) => ({ id: uuid(), text: p.text, date: p.date, createdAt: now }))
  return [...active, ...added].slice(-MAX_UPCOMING_PLANS)
}

/**
 * Fire-and-forget: if enough new messages have piled up, summarize them into
 * compact facts/style memory, score warmth, and optionally re-assess the
 * relationship dynamic when warmth crosses a stage boundary.
 */
export async function maybeUpdateMemory(
  contactId: string,
  conversationId: string,
  settings: AppSettings,
): Promise<void> {
  try {
    const contact = await db.contacts.get(contactId)
    if (!contact) return

    const allMessages = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const cursor = contact.memoryMessageCursor ?? 0
    const newMessages = allMessages.slice(cursor)
    if (newMessages.length < MEMORY_UPDATE_INTERVAL) return

    const raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel,
      messages: [
        {
          role: 'system',
          content: buildMemoryUpdatePrompt({
            existingFacts: contact.memoryFacts,
            existingStyle: contact.memoryStyle,
            existingPlansText: activeUpcomingPlansText(contact, new Date()),
            warmth: contact.warmth ?? 0,
            currentTimeText: describeCurrentTime(new Date()),
          }),
        },
        { role: 'user', content: formatMessagesForMemory(newMessages) },
      ],
      jsonMode: true,
    })
    const updated = parseMemoryResponse(raw)
    if (!updated) return

    const now = Date.now()
    const oldWarmth = contact.warmth ?? 0
    let warmthDelta = traitWarmthModifier(contact.personalityTrait, updated.warmthDelta)

    // Breakup → immediate large warmth penalty, so the model doesn't
    // act like nothing happened. Applied on top of the model's own delta.
    const dynamic = updated.relationshipAssessment || contact.relationshipDynamic
    if (containsBreakupLanguage(dynamic)) {
      warmthDelta = applyWarmthDelta(warmthDelta, WARMTH_BREAKUP_PENALTY)
    }

    const newWarmth = applyWarmthDelta(oldWarmth, warmthDelta)
    let base = contact.relationshipBase
    const newBase = shouldUpdateBase(dynamic, newWarmth)
    if (newBase) base = newBase

    await db.contacts.update(contact.id, {
      memoryFacts: updated.facts,
      memoryStyle: updated.style,
      memoryUpdatedAt: now,
      memoryMessageCursor: allMessages.length,
      upcomingPlans: mergePlans(contact.upcomingPlans ?? [], updated.plans, now),
      warmth: newWarmth,
      relationshipDynamic: dynamic,
      relationshipBase: base,
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

// ---- group chat memory ----

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
      if (m.type === 'sticker') return `${speakerName}: [表情: ${m.content}]`
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

  return `你是群聊记忆整理器 帮群聊"${opts.groupName}"里的每个角色更新对用户("对方")的记忆 输出JSON 不要有额外文字

【当前时间】
${opts.currentTimeText}

群聊记录:
${opts.transcript}

下面是需要更新的发言人(只根据自己能看到的聊天内容更新):
${speakerBlocks}

输出:
{"updates":[{"facts":"...","style":"...","plans":[{"text":"...","date":"YYYY-MM-DD或空字符串"}]}]}

要求:
- updates数组顺序和上面发言人顺序一致 数量一致
- facts客观信息≤200字 style相处语气≤150字
- 没有新增内容的就原样返回已知信息 不要清空
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

/** Group-chat memory — no warmth scoring (intentional: group dynamics are too complex for a single score). */
export async function maybeUpdateGroupMemory(
  groupId: string,
  conversationId: string,
  members: Contact[],
  settings: AppSettings,
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
      await db.groups.update(groupId, { memoryMessageCursor: allMessages.length })
      return
    }

    const raw = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.utilityModel,
      messages: [
        {
          role: 'system',
          content: buildGroupMemoryUpdatePrompt({
            groupName: group.name,
            transcript: formatGroupMessagesForMemory(newMessages, memberById, settings.userNickname),
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
