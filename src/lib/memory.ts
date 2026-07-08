import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { chatCompletion } from './deepseek'
import { clampWarmthDelta, applyWarmthDelta, maxWarmthForTrait, warmthStage, shouldUpdateBase, containsBreakupLanguage, WARMTH_BREAKUP_PENALTY, traitWarmthModifier } from './relationship'
import { displayName } from './contact'
import { describeCurrentTime, toDateKey } from './time'
import { isModuleEnabled } from '../features'
import { parseIntentsField, type ParsedIntent } from './intent'
import type { AppSettings, Contact, ContactMemory, ContactMemoryScope, ContactRelationLabel, IntentItem, MemoryCategory, MemoryKind, Message, PlanItem } from '../types'

/** How many *new* messages accumulate before we bother refreshing memory. Keeps the extra API call rare. */
export const MEMORY_UPDATE_INTERVAL = 10

/** How many of the most recent messages get sent verbatim to the main chat call. */
export const CONTEXT_WINDOW_SIZE = 30

/** Bounds how many upcoming plans a contact can accumulate. */
const MAX_UPCOMING_PLANS = 8
const MEMORY_CONFIDENCE_THRESHOLD = 60
const RELATIONSHIP_CONFIDENCE_THRESHOLD = 80

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
{"facts":"...", "factConfidence":80, "style":"...", "styleConfidence":75, "plans":[{"text":"...", "date":"YYYY-MM-DD或空字符串", "confidence":80}], "warmthDelta": 0, "relationshipAssessment":"...", "relationshipConfidence":70, "intents":[{"text":"下次想问问他昨晚睡得怎么样","kind":"care","confidence":85}], "memoryItems":[{"category":"基础信息","kind":"user_fact","content":"用户说他养了一只叫小橘的橘猫","tags":["宠物","猫"],"importance":0.7,"emotionalWeight":0.3,"confidence":0.9}]}

要求:
- facts: 关于对方的客观信息(名字/年龄/喜好/重要事件等) 只记聊天里明确提到的 ≤200字 分号分隔 新旧冲突以新为准
- factConfidence/styleConfidence/relationshipConfidence: 0-100整数 只有明确证据才给高分
- style: AI应如何调整语气来贴合对方 ≤150字 不改变核心性格
- facts和style有值得更新的才改 没有就原样返回 不要清空
${plansPromptFragment()}
- plans每条必须带confidence 0-100 低于60不要写入
- intents: AI心里想保留到下次的小念头 不是任务清单 kind只能是follow_up/care/avoid/relationship/topic confidence>=70才写 最多4条
- warmthDelta: 根据这批聊天记录的语气和互动质量 好感度应该变化多少(-5到+5整数) 聊得好→正数 聊崩了→负数 平平无奇→0 不要因为好感度已经很高/很低就不敢给分
- relationshipAssessment: 每次都要写 一句话描述当前关系实际状态 不超过30字。**如果聊天里发生了关系断裂(分手/离婚/绝交/闹掰/拉黑/删除/断绝联系等) 必须在描述中使用明确的标准化关键词——**比如"已经分手了 关系彻底破裂"或"已经绝交 形同陌路"或"已经离婚 不想再有任何联系"——**不要只用模糊措辞(比如"关系不太好") 因为系统需要识别这些关键词来触发后续处理**。升级的情况同理 比如"已经在一起了 确认恋爱关系"。没有大变化就写"关系稳定"
- memoryItems: 从这批聊天记录里提取的具体记忆条目 每条都是独立的事实/观察 用于后续检索和注入 规则:
  * category必须是以下之一: 关系动态/话题历史/基础信息/偏好习惯/人格特质/重要事件/四季日常
  * kind必须是以下之一: general/user_fact/user_preference/relationship_event/character_promise/open_thread/world_state
  * character_promise=AI向用户做出的承诺或约定(比如"我答应周末陪你去") 对应的content用第一人称"我"开头 必须是聊天里真正说出口的承诺 不能是自己心里想的
  * user_fact=关于用户的客观事实(对方在聊天里明确说过的) user_preference=用户的喜好/习惯(对方表达过的)
  * ⚠️防污染关键: 你在角色扮演中随口说的关于对方的事(比如"你以前说过你喜欢..."但其实对方没说过)绝对不能记成user_fact 只有对方自己明确说过/承认过的事才能记成user_fact 不确定就记成general或直接跳过
  * ⚠️同样: AI自己幻想/脑补/角色设定里的内容(比如"我是一个来自魔界的恶魔")不能当成世界事实记成world_state 除非聊天里对方确认了这个设定存在于当前世界观 不确定就用general
  * open_thread=对话里提到但还没完结的话题(比如"下次再聊这个") 用于让AI下次能主动提起
  * relationship_event=两人关系的重要节点(吵架/和好/告白/约定见面等) 不是日常闲聊
  * importance/emotionalWeight/confidence都是0-1的小数 不确定就0.5 重要事件/承诺类至少0.7
  * tags是字符串数组 2-5个标签概括这条记忆
  * 每条content要独立可懂 不超过80字 用第三人称描述(如"用户喜欢喝奶茶""AI答应周五陪用户去看电影") 写清楚主语 不要用"你""我""他"这种指代不清的词
  * 新旧信息冲突时 以聊天记录里最新明确出现的信息为准 旧记忆会被自动覆盖
  * 只记这批新消息里出现的 不重复已有的 没有新材料就不输出空数组`
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
  confidence: number
}

function parsePlansField(raw: unknown, requireConfidence = false): ParsedPlan[] {
  if (!Array.isArray(raw)) return []
  const result: ParsedPlan[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const text = typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text.trim() : ''
    if (!text) continue
    const rawDate = (p as { date?: unknown }).date
    const date = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined
    const confidenceRaw = (p as { confidence?: unknown }).confidence
    const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : Number(confidenceRaw)
    if (requireConfidence && (!Number.isFinite(confidence) || confidence < MEMORY_CONFIDENCE_THRESHOLD)) continue
    const normalizedConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 100
    result.push({ text, date, confidence: normalizedConfidence })
  }
  return result
}

const VALID_CATEGORIES: Set<string> = new Set([
  '关系动态', '话题历史', '基础信息', '偏好习惯', '人格特质', '重要事件', '四季日常',
])

const VALID_KINDS: Set<string> = new Set([
  'general', 'user_fact', 'user_preference', 'relationship_event',
  'character_promise', 'open_thread', 'world_state',
])

interface ParsedMemoryItem {
  category: MemoryCategory
  kind: MemoryKind
  content: string
  tags: string[]
  importance: number
  emotionalWeight: number
  confidence: number
  scope?: ContactMemoryScope
  relatedContactNames?: string[]
  relatedContactIds?: string[]
  groupId?: string
}

const VALID_MEMORY_SCOPES: Set<string> = new Set(['private', 'group', 'interpersonal'])

function parseMemoryItemsField(raw: unknown): ParsedMemoryItem[] {
  if (!Array.isArray(raw)) return []
  const result: ParsedMemoryItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const category = typeof (item as { category?: unknown }).category === 'string'
      ? (item as { category: string }).category.trim()
      : ''
    if (!category || !VALID_CATEGORIES.has(category)) continue
    const kind = typeof (item as { kind?: unknown }).kind === 'string'
      ? (item as { kind: string }).kind.trim()
      : ''
    if (!kind || !VALID_KINDS.has(kind)) continue
    const content = typeof (item as { content?: unknown }).content === 'string'
      ? (item as { content: string }).content.trim()
      : ''
    if (!content || content.length > 200) continue
    const tags: string[] = Array.isArray((item as { tags?: unknown }).tags)
      ? ((item as { tags: unknown[] }).tags
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim().slice(0, 30))
          .slice(0, 8))
      : []
    const clamp01 = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? Math.max(0, Math.min(1, Math.round(n * 100) / 100)) : 0.5
    }
    const importance = clamp01((item as { importance?: unknown }).importance)
    const emotionalWeight = clamp01((item as { emotionalWeight?: unknown }).emotionalWeight)
    const confidence = clamp01((item as { confidence?: unknown }).confidence)
    if (confidence < 0.5) continue // skip low-confidence items
    const scopeRaw = typeof (item as { scope?: unknown }).scope === 'string' ? (item as { scope: string }).scope.trim() : ''
    const scope = VALID_MEMORY_SCOPES.has(scopeRaw) ? scopeRaw as ContactMemoryScope : undefined
    const relatedContactNames = Array.isArray((item as { relatedContactNames?: unknown }).relatedContactNames)
      ? (item as { relatedContactNames: unknown[] }).relatedContactNames
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
          .map((name) => name.trim().slice(0, 40))
          .slice(0, 8)
      : []
    result.push({ category: category as MemoryCategory, kind: kind as MemoryKind, content, tags, importance, emotionalWeight, confidence, scope, relatedContactNames })
  }
  return result
}

interface MemoryUpdateResult {
  facts: string
  factConfidence: number
  style: string
  styleConfidence: number
  plans: ParsedPlan[]
  warmthDelta: number
  relationshipAssessment: string
  relationshipConfidence: number
  intents: ParsedIntent[]
  memoryItems: ParsedMemoryItem[]
}

export interface MemoryUpdateDebug {
  applied: boolean
  factsUpdated: boolean
  styleUpdated: boolean
  addedPlans: PlanItem[]
  addedIntents: IntentItem[]
  warmthDelta: number
  relationshipAssessment: string
  relationshipConfidence: number
  relationshipBaseChanged: boolean
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
      const factConfidence = typeof parsed.factConfidence === 'number' ? parsed.factConfidence : Number(parsed.factConfidence)
      const styleConfidence = typeof parsed.styleConfidence === 'number' ? parsed.styleConfidence : Number(parsed.styleConfidence)
      const relationshipConfidence =
        typeof parsed.relationshipConfidence === 'number' ? parsed.relationshipConfidence : Number(parsed.relationshipConfidence)
      return {
        facts: parsed.facts.trim(),
        factConfidence: Number.isFinite(factConfidence) ? Math.max(0, Math.min(100, Math.round(factConfidence))) : 0,
        style: parsed.style.trim(),
        styleConfidence: Number.isFinite(styleConfidence) ? Math.max(0, Math.min(100, Math.round(styleConfidence))) : 0,
        plans: parsePlansField(parsed.plans, true),
        warmthDelta: Number.isFinite(delta) ? clampWarmthDelta(delta) : 0,
        relationshipAssessment: assessment.slice(0, 80),
        relationshipConfidence: Number.isFinite(relationshipConfidence)
          ? Math.max(0, Math.min(100, Math.round(relationshipConfidence)))
          : 0,
        intents: parseIntentsField(parsed.intents),
        memoryItems: parseMemoryItemsField(parsed.memoryItems),
      }
    }
  } catch {
    // ignore
  }
  return null
}

// ---- structured memory dedup/merge ----

/** Simple word-level tokenization for Chinese text content similarity. */
function tokenizeForSimilarity(text: string): Set<string> {
  // Split on non-word characters, keep Chinese chars as individual tokens,
  // filter out very short tokens.
  const cleaned = text.replace(/[，。！？、；：""''【】（）\s]+/g, ' ').trim()
  if (!cleaned) return new Set()
  // For Chinese-heavy text, split into bigrams for better matching.
  const chars = cleaned.replace(/\s+/g, '').split('')
  const tokens: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    // Single CJK character
    if (/[一-鿿]/.test(c)) {
      tokens.push(c)
      // Also add bigrams for better specificity
      if (i + 1 < chars.length && /[一-鿿]/.test(chars[i + 1])) {
        tokens.push(c + chars[i + 1])
      }
    } else {
      tokens.push(c)
    }
  }
  // Also split by spaces for any Latin words
  for (const w of cleaned.split(/\s+/)) {
    if (w.length >= 2) tokens.push(w.toLowerCase())
  }
  return new Set(tokens)
}

function contentSimilarity(a: string, b: string): number {
  const tokensA = tokenizeForSimilarity(a)
  const tokensB = tokenizeForSimilarity(b)
  if (tokensA.size === 0 && tokensB.size === 0) return 1
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersection = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++
  }
  return intersection / Math.min(tokensA.size, tokensB.size)
}

/** Minimum Jaccard-like similarity to treat two memories as the same fact. */
const MERGE_SIMILARITY_THRESHOLD = 0.45

interface MergeMemoryStats {
  added: number
  updated: number
  skipped: number
}

/**
 * Dedup new memory items against existing entries for the same contact.
 * - Same kind + high content similarity → update existing (bump confidence, updatedAt).
 * - Same kind + moderate tag overlap + moderate content similarity → update existing.
 * - Otherwise → insert as new.
 * Low-confidence items (confidence < 0.5) are silently dropped.
 */
async function mergeMemoryItems(
  contactId: string,
  newItems: ParsedMemoryItem[],
  conversationId: string,
  now: number,
  defaults: { scope?: ContactMemoryScope; groupId?: string; relatedContactIds?: string[] } = {},
): Promise<MergeMemoryStats> {
  const stats: MergeMemoryStats = { added: 0, updated: 0, skipped: 0 }
  if (newItems.length === 0) return stats

  const existing = await db.contactMemories
    .where('contactId')
    .equals(contactId)
    .toArray()

  // Index existing by kind for fast lookup.
  const byKind = new Map<string, (typeof existing)>([])
  for (const ex of existing) {
    const list = byKind.get(ex.kind) ?? []
    list.push(ex)
    byKind.set(ex.kind, list)
  }

  const toUpdate: ContactMemory[] = []
  const toAdd: ContactMemory[] = []

  for (const item of newItems) {
    if (item.confidence < 0.5) continue
    const scope = item.scope ?? defaults.scope ?? 'private'
    const groupId = item.groupId ?? defaults.groupId
    const relatedContactIds = Array.from(new Set([...(defaults.relatedContactIds ?? []), ...(item.relatedContactIds ?? [])]))

    const candidates = (byKind.get(item.kind) ?? []).filter((candidate) => {
      const candidateScope = candidate.scope ?? 'private'
      if (candidateScope !== scope) return false
      if ((candidate.groupId ?? '') !== (groupId ?? '')) return false
      if (relatedContactIds.length === 0) return true
      const existingRelated = candidate.relatedContactIds ?? []
      return relatedContactIds.some((id) => existingRelated.includes(id))
    })
    let bestMatch: (typeof existing)[number] | null = null
    let bestScore = 0

    for (const ex of candidates) {
      const sim = contentSimilarity(item.content, ex.content)
      // Tag overlap bonus.
      const tagOverlap = item.tags.filter((t) => ex.tags.includes(t)).length
      const tagScore = item.tags.length > 0 ? tagOverlap / Math.max(item.tags.length, ex.tags.length) : 0
      const composite = sim * 0.7 + tagScore * 0.3

      if (composite > bestScore) {
        bestScore = composite
        bestMatch = ex
      }
    }

    if (bestMatch && bestScore >= MERGE_SIMILARITY_THRESHOLD) {
      // Merge: update content to the newer version, average the scores upward.
      const mergedConfidence = Math.max(bestMatch.confidence, item.confidence)
      const mergedImportance = Math.max(bestMatch.importance, item.importance)
      const mergedEmotionalWeight = Math.round(
        (bestMatch.emotionalWeight + item.emotionalWeight) / 2 * 100,
      ) / 100
      const mergedTags = Array.from(
        new Set([...bestMatch.tags, ...item.tags]),
      ).slice(0, 8)
      toUpdate.push({
        ...bestMatch,
        content: item.content, // newer content wins
        tags: mergedTags,
        importance: mergedImportance,
        emotionalWeight: mergedEmotionalWeight,
        confidence: mergedConfidence,
        updatedAt: now,
        sourceConversationId: conversationId,
        scope,
        groupId,
        relatedContactIds: Array.from(new Set([...(bestMatch.relatedContactIds ?? []), ...relatedContactIds])),
      })
      stats.updated++
    } else {
      toAdd.push({
        id: uuid(),
        contactId,
        scope,
        groupId,
        relatedContactIds,
        category: item.category,
        kind: item.kind,
        content: item.content,
        tags: item.tags,
        importance: item.importance,
        emotionalWeight: item.emotionalWeight,
        confidence: item.confidence,
        sourceConversationId: conversationId,
        sourceMessageIds: [],
        createdAt: now,
        updatedAt: now,
        usageCount: 0,
      })
      stats.added++
    }
  }

  if (toUpdate.length > 0) {
    await db.contactMemories.bulkPut(toUpdate)
  }
  if (toAdd.length > 0) {
    await db.contactMemories.bulkAdd(toAdd)
  }

  return stats
}

function mergePlans(existing: PlanItem[], newOnes: ParsedPlan[], now: number): PlanItem[] {
  const active = activeUpcomingPlans(existing, new Date(now))
  const added: PlanItem[] = newOnes.map((p) => ({ id: uuid(), text: p.text, date: p.date, createdAt: now, confidence: p.confidence }))
  return [...active, ...added].slice(-MAX_UPCOMING_PLANS)
}

function newPlanItems(newOnes: ParsedPlan[], now: number): PlanItem[] {
  return newOnes.map((p) => ({ id: uuid(), text: p.text, date: p.date, createdAt: now, confidence: p.confidence }))
}

function mergePlanItems(existing: PlanItem[], added: PlanItem[], now: number): PlanItem[] {
  return [...activeUpcomingPlans(existing, new Date(now)), ...added].slice(-MAX_UPCOMING_PLANS)
}

function mergeIntentItems(existing: IntentItem[], added: IntentItem[], now: number): IntentItem[] {
  const activeExisting = existing.filter((intent) => !intent.expiresAt || intent.expiresAt > now)
  return [...activeExisting, ...added].slice(-20)
}

function newIntentItems(existing: IntentItem[], newOnes: ParsedIntent[], now: number): IntentItem[] {
  const seen = new Set(existing.map((intent) => intent.text.trim()))
  const added: IntentItem[] = []
  for (const intent of newOnes) {
    if (seen.has(intent.text)) continue
    seen.add(intent.text)
    added.push({
      id: uuid(),
      text: intent.text,
      kind: intent.kind,
      createdAt: now,
      expiresAt: intent.expiresAt,
      status: 'active',
      confidence: intent.confidence,
    })
  }
  return added
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
): Promise<MemoryUpdateDebug | null> {
  try {
    const contact = await db.contacts.get(contactId)
    if (!contact) return null

    const allMessages = await db.messages.where('conversationId').equals(conversationId).sortBy('createdAt')
    const cursor = contact.memoryMessageCursor ?? 0
    const newMessages = allMessages.slice(cursor)
    if (newMessages.length < MEMORY_UPDATE_INTERVAL) return null

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
    if (!updated) return null

    const now = Date.now()

    // Relationship scoring is only active when the 好感度 module is enabled.
    // Memory (facts/style/plans) always updates regardless.
    const relEnabled = isModuleEnabled('relationship')
    const personalityEnabled = isModuleEnabled('personalityTraits')
    const intentEnabled = isModuleEnabled('intent')

    const oldWarmth = contact.warmth ?? 0
    const rawDelta = relEnabled ? updated.warmthDelta : 0
    let warmthDelta = personalityEnabled
      ? traitWarmthModifier(contact.personalityTrait, rawDelta, oldWarmth)
      : rawDelta

    const relationshipHighConfidence = updated.relationshipConfidence >= RELATIONSHIP_CONFIDENCE_THRESHOLD
    const dynamic = relationshipHighConfidence
      ? (updated.relationshipAssessment || contact.relationshipDynamic)
      : contact.relationshipDynamic
    if (relEnabled && relationshipHighConfidence && containsBreakupLanguage(dynamic)) {
      warmthDelta = applyWarmthDelta(warmthDelta, WARMTH_BREAKUP_PENALTY)
    }

    const newWarmth = relEnabled
      ? applyWarmthDelta(oldWarmth, warmthDelta, personalityEnabled ? maxWarmthForTrait(contact.personalityTrait) : 100)
      : oldWarmth
    let base = contact.relationshipBase
    let relationshipBaseChanged = false
    if (relEnabled && relationshipHighConfidence) {
      const newBase = shouldUpdateBase(dynamic, newWarmth)
      if (newBase) {
        base = newBase
        relationshipBaseChanged = true
      }
    }

    const factsUpdated = updated.factConfidence >= MEMORY_CONFIDENCE_THRESHOLD && updated.facts !== contact.memoryFacts
    const styleUpdated = updated.styleConfidence >= MEMORY_CONFIDENCE_THRESHOLD && updated.style !== contact.memoryStyle
    const addedPlans = newPlanItems(updated.plans, now)
    const addedIntents = intentEnabled ? newIntentItems(contact.intentQueue ?? [], updated.intents, now) : []

    // Write structured memory items to the contactMemories table (deduped).
    const memStats = await mergeMemoryItems(contact.id, updated.memoryItems, conversationId, now)
    if (memStats.added > 0 || memStats.updated > 0) {
      console.log(`[memory] 结构化记忆: +${memStats.added} 更新${memStats.updated}`)
    }

    // character_promise items also feed into upcomingPlans so the AI
    // remembers its commitments across turns.
    const promisePlans: PlanItem[] = updated.memoryItems
      .filter((item) => item.kind === 'character_promise')
      .map((item) => ({
        id: uuid(),
        text: item.content,
        date: undefined,
        createdAt: now,
        confidence: Math.round(item.confidence * 100),
      }))
    const allAddedPlans = [...addedPlans, ...promisePlans]

    await db.contacts.update(contact.id, {
      memoryFacts: factsUpdated ? updated.facts : contact.memoryFacts,
      memoryStyle: styleUpdated ? updated.style : contact.memoryStyle,
      memoryUpdatedAt: now,
      memoryMessageCursor: allMessages.length,
      upcomingPlans: mergePlanItems(contact.upcomingPlans ?? [], allAddedPlans, now),
      ...(intentEnabled
        ? { intentQueue: mergeIntentItems(contact.intentQueue ?? [], addedIntents, now) }
        : {}),
      ...(relEnabled
        ? { warmth: newWarmth, relationshipDynamic: dynamic, relationshipBase: base }
        : {}),
    })
    return {
      applied: true,
      factsUpdated,
      styleUpdated,
      addedPlans,
      addedIntents,
      warmthDelta,
      relationshipAssessment: dynamic,
      relationshipConfidence: updated.relationshipConfidence,
      relationshipBaseChanged,
    }
  } catch {
    // best-effort only
    return null
  }
}

/** Load recent structured memories for a contact, formatted for prompt injection.
 *  Sorted by a composite score: importance × 0.6 + recency × 0.4.
 *  Retrieved memories get their lastUsedAt and usageCount bumped. */
export async function recentMemoriesText(contactId: string, limit = 15): Promise<string> {
  return recentMemoriesTextByScope(contactId, limit, { includeScopes: ['private'] })
}

export async function recentMemoriesTextByScope(
  contactId: string,
  limit = 15,
  opts: { includeScopes?: ContactMemoryScope[]; excludeScopes?: ContactMemoryScope[]; title?: string } = {},
): Promise<string> {
  try {
    const now = Date.now()
    let items = await db.contactMemories
      .where('contactId')
      .equals(contactId)
      .toArray()
    const include = opts.includeScopes ? new Set(opts.includeScopes) : null
    const exclude = opts.excludeScopes ? new Set(opts.excludeScopes) : null
    items = items.filter((item) => {
      const scope = item.scope ?? 'private'
      if (include && !include.has(scope)) return false
      if (exclude && exclude.has(scope)) return false
      return true
    })
    if (items.length === 0) return ''

    // Composite score: importance (60%) + recency (40%).
    const maxAge = Math.max(1, now - (items[0]?.createdAt ?? now))
    const scored = items.map((item) => {
      const age = now - item.createdAt
      const recency = Math.max(0, 1 - age / (maxAge || 1))
      const score = item.importance * 0.6 + recency * 0.4
      return { item, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit).map((s) => s.item)

    // Update lastUsedAt and usageCount for the retrieved items (fire-and-forget).
    const ids = top.map((item) => item.id)
    db.contactMemories
      .where('id')
      .anyOf(ids)
      .modify((item) => {
        item.lastUsedAt = now
        item.usageCount = (item.usageCount ?? 0) + 1
      })
      .catch(() => {
        // best-effort — don't block the chat turn on usage tracking
      })

    // Group by kind for a structured but compact format.
    const byKind = new Map<string, ContactMemory[]>()
    for (const item of top) {
      const list = byKind.get(item.kind) ?? []
      list.push(item)
      byKind.set(item.kind, list)
    }
    const blocks: string[] = []
    const kindLabels: Record<string, string> = {
      user_fact: '关于对方',
      user_preference: '对方的偏好',
      relationship_event: '关系事件',
      character_promise: '你的承诺',
      open_thread: '未完结的话题',
      world_state: '世界观相关',
    }
    for (const [kind, list] of byKind) {
      const label = kindLabels[kind] ?? kind
      const lines = list.map((item) => `- ${item.content}`)
      blocks.push(`【${label}】\n${lines.join('\n')}`)
    }
    const text = blocks.join('\n\n')
    return opts.title ? `【${opts.title}】\n${text}` : text
  } catch {
    return ''
  }
}

export async function socialMemoriesText(contactId: string, limit = 12): Promise<string> {
  const structured = await recentMemoriesTextByScope(contactId, limit, {
    includeScopes: ['group', 'interpersonal'],
    title: '群聊与朋友记忆',
  })
  const relations = await contactRelationMemoryText(contactId)
  return [structured, relations].filter(Boolean).join('\n\n')
}

export async function nonGroupScopedMemoriesText(contactId: string, limit = 12): Promise<string> {
  const structured = await recentMemoriesTextByScope(contactId, limit, {
    excludeScopes: ['group'],
    title: '个人与朋友关系记忆',
  })
  const relations = await contactRelationMemoryText(contactId)
  return [structured, relations].filter(Boolean).join('\n\n')
}

export async function contactRelationMemoryText(contactId: string): Promise<string> {
  try {
    const links = await db.contactRelations
      .filter((link) => link.fromContactId === contactId || link.toContactId === contactId)
      .toArray()
    if (links.length === 0) return ''
    const otherIds = Array.from(new Set(links.map((link) => (link.fromContactId === contactId ? link.toContactId : link.fromContactId))))
    const contacts = await db.contacts.bulkGet(otherIds)
    const contactById = new Map(contacts.filter((c): c is Contact => !!c).map((c) => [c.id, c]))
    const lines = links
      .map((link) => {
        const otherId = link.fromContactId === contactId ? link.toContactId : link.fromContactId
        const other = contactById.get(otherId)
        if (!other) return ''
        return `- ${displayName(other)} 是你的${link.label}`
      })
      .filter(Boolean)
    return lines.length > 0 ? `【已知朋友关系】\n${lines.join('\n')}` : ''
  } catch {
    return ''
  }
}

export async function rememberInitialContactRelation(opts: {
  fromContactId: string
  toContactId: string
  label: ContactRelationLabel
  now?: number
}): Promise<void> {
  const now = opts.now ?? Date.now()
  const [from, to] = await Promise.all([
    db.contacts.get(opts.fromContactId),
    db.contacts.get(opts.toContactId),
  ])
  if (!from || !to) return
  const makeItem = (contactId: string, other: Contact): ContactMemory => ({
    id: uuid(),
    contactId,
    scope: 'interpersonal',
    relatedContactIds: [other.id],
    category: '关系动态',
    kind: 'relationship_event',
    content: `${displayName(other)}是你的${opts.label}，这是创建角色时设定的朋友关系。`,
    tags: ['朋友关系', opts.label, displayName(other)],
    importance: 0.85,
    emotionalWeight: 0.35,
    confidence: 1,
    sourceMessageIds: [],
    createdAt: now,
    updatedAt: now,
    usageCount: 0,
  })
  await db.contactMemories.bulkAdd([
    makeItem(opts.fromContactId, to),
    makeItem(opts.toContactId, from),
  ])
}

export async function resetMemory(contactId: string): Promise<void> {
  await db.contacts.update(contactId, {
    memoryFacts: '',
    memoryStyle: '',
    memoryUpdatedAt: 0,
    memoryMessageCursor: 0,
    upcomingPlans: [],
  })
  await db.contactMemories.where('contactId').equals(contactId).delete()
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
  allMembers: Contact[]
}): string {
  const allMemberNames = opts.allMembers.map((c) => c.name).join('、')
  const speakerBlocks = opts.speakers
    .map(
      (c, i) => `发言人${i + 1}: ${c.name}
已知信息: ${c.memoryFacts || '（暂无）'}
相处状态: ${c.memoryStyle || '（暂无）'}
已知约定: ${activeUpcomingPlansText(c, new Date()) || '（暂无）'}`,
    )
    .join('\n\n')

  return `你是群聊记忆整理器 帮群聊"${opts.groupName}"里的角色更新记忆 输出JSON 不要有额外文字

【当前时间】
${opts.currentTimeText}

【群成员】
${allMemberNames}

群聊记录:
${opts.transcript}

下面是需要更新的发言人(只根据自己能看到的聊天内容更新):
${speakerBlocks}

输出:
{"updates":[{"facts":"...","style":"...","plans":[{"text":"...","date":"YYYY-MM-DD或空字符串"}],"memoryItems":[{"category":"基础信息","kind":"user_fact","content":"...","tags":[],"importance":0.7,"emotionalWeight":0.3,"confidence":0.9}],"groupMemoryItems":[{"category":"话题历史","kind":"general","content":"...","tags":[],"importance":0.6,"emotionalWeight":0.2,"confidence":0.8}],"interpersonalMemoryItems":[{"category":"重要事件","kind":"relationship_event","content":"...","relatedContactNames":["雪乃"],"tags":[],"importance":0.7,"emotionalWeight":0.4,"confidence":0.85}]}]}

要求:
- updates数组顺序和上面发言人顺序一致 数量一致
- facts客观信息≤200字 style相处语气≤150字
- 没有新增内容的就原样返回已知信息 不要清空
${plansPromptFragment()}
- memoryItems: 只记录“该角色和用户”的记忆，规则和1:1聊天记忆一样。没有新素材就空数组。
- groupMemoryItems: 记录“该角色知道这个群里发生/聊过什么”的群聊交流记忆，包含群成员名字和话题，例如“雪乃和柚柚在群里讨论过……”；不要重复写进memoryItems。
- interpersonalMemoryItems: 只给本轮实际发言/被直接回应/被点名的角色记录“自己和其他AI成员做了什么、关系如何、共同经历是什么”。必须填写relatedContactNames，名字只能来自群成员。未参与聊天的人这里给空数组。
- 如果用户提到某个群成员名字，必须把它当作群成员名字处理，不要当作番剧/二次元词汇。
- 只输出JSON 不要markdown代码块标记`
}

interface GroupMemoryUpdate {
  facts: string
  style: string
  plans: ParsedPlan[]
  memoryItems: ParsedMemoryItem[]
  groupMemoryItems: ParsedMemoryItem[]
  interpersonalMemoryItems: ParsedMemoryItem[]
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
      result.push({
        facts: u.facts.trim(),
        style: u.style.trim(),
        plans: parsePlansField(u.plans),
        memoryItems: parseMemoryItemsField((u as Record<string, unknown>).memoryItems),
        groupMemoryItems: parseMemoryItemsField((u as Record<string, unknown>).groupMemoryItems),
        interpersonalMemoryItems: parseMemoryItemsField((u as Record<string, unknown>).interpersonalMemoryItems),
      })
    }
    return result
  } catch {
    return null
  }
}

function attachRelatedContactIds(items: ParsedMemoryItem[], memberByName: Map<string, Contact>): ParsedMemoryItem[] {
  return items.map((item) => {
    const ids = (item.relatedContactNames ?? [])
      .map((name) => memberByName.get(name)?.id)
      .filter((id): id is string => !!id)
    return { ...item, relatedContactIds: Array.from(new Set([...(item.relatedContactIds ?? []), ...ids])) }
  })
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
    const directParticipantIds = new Set(speakerIds)
    const targets = members

    if (targets.length === 0) {
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
            speakers: targets,
            allMembers: members,
          }),
        },
        { role: 'user', content: '请生成' },
      ],
      jsonMode: true,
    })

    const updates = parseGroupMemoryResponse(raw, targets.length)
    if (!updates) {
      await db.groups.update(groupId, { memoryMessageCursor: allMessages.length })
      return
    }

    const now = Date.now()
    const memberByName = new Map(members.map((member) => [displayName(member), member]))
    for (const member of members) memberByName.set(member.name, member)
    for (let i = 0; i < targets.length; i++) {
      const contact = targets[i]
      const update = updates[i]

      // Write structured memory items for this speaker (deduped).
      const privateStats = await mergeMemoryItems(contact.id, update.memoryItems, conversationId, now, { scope: 'private' })
      const groupStats = await mergeMemoryItems(contact.id, update.groupMemoryItems, conversationId, now, { scope: 'group', groupId })
      const interpersonalItems = directParticipantIds.has(contact.id)
        ? attachRelatedContactIds(update.interpersonalMemoryItems, memberByName)
        : []
      const interpersonalStats = await mergeMemoryItems(contact.id, interpersonalItems, conversationId, now, { scope: 'interpersonal', groupId })
      const changed = privateStats.added + privateStats.updated + groupStats.added + groupStats.updated + interpersonalStats.added + interpersonalStats.updated
      if (changed > 0) {
        console.log(`[memory] 群聊结构化记忆 ${contact.name}: 私聊+${privateStats.added}/更${privateStats.updated} 群聊+${groupStats.added}/更${groupStats.updated} 人际+${interpersonalStats.added}/更${interpersonalStats.updated}`)
      }

      // character_promise items → also feed into upcomingPlans.
      const promisePlans: ParsedPlan[] = update.memoryItems
        .filter((item) => item.kind === 'character_promise')
        .map((item) => ({
          text: item.content,
          date: undefined,
          confidence: Math.round(item.confidence * 100),
        }))

      await db.contacts.update(contact.id, {
        memoryFacts: update.facts,
        memoryStyle: update.style,
        memoryUpdatedAt: now,
        upcomingPlans: mergePlans(contact.upcomingPlans ?? [], [...update.plans, ...promisePlans], now),
      })
    }
    await db.groups.update(groupId, { memoryMessageCursor: allMessages.length })
  } catch {
    // best-effort only
  }
}
