import { db } from '../db/db'
import { extractJsonObject, parseKnowledgeQueriesField } from './aiProtocol'
import { activeUpcomingPlansText } from './memory'
import { describeCurrentSchedule } from './schedule'
import type { Contact, GroupAiBubble, GroupAiResponse } from '../types'

/** Group chats above this size don't have every member answer every turn — only a random 3 do (see pickSpeakers). */
const MAX_SPEAKERS_WHEN_LARGE = 3
const LARGE_GROUP_THRESHOLD = 3

/** Warmer contacts get picked to speak more often (also reused by proactiveChat.ts). */
export function relationshipWeight(warmth: number): number {
  return Math.max(1, (warmth + 100) / 2)
}

export function weightedSampleWithoutReplacement(contacts: Contact[], k: number): Contact[] {
  const pool = contacts.map((c) => ({ c, w: relationshipWeight(c.warmth ?? 0) }))
  const picked: Contact[] = []
  while (picked.length < k && pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.w, 0)
    let r = Math.random() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w
      if (r <= 0) {
        idx = i
        break
      }
    }
    picked.push(pool[idx].c)
    pool.splice(idx, 1)
  }
  return picked
}

/**
 * Who answers this round, decided entirely in code (per the user's spec),
 * not left to the model. A small group just always has everyone chime in;
 * once it's big enough that "everyone replies every time" would be noisy,
 * only 3 do, weighted toward whoever's closer to the user.
 */
export function pickSpeakers(members: Contact[]): Contact[] {
  if (members.length <= LARGE_GROUP_THRESHOLD) return members
  return weightedSampleWithoutReplacement(members, MAX_SPEAKERS_WHEN_LARGE)
}

export function groupTypingDelayMs(bubble: GroupAiBubble): number {
  if (bubble.type === 'text') return Math.min(300 + bubble.content.length * 80, 3500)
  return 500
}

/**
 * The model occasionally bakes a "某某: " name prefix into a text bubble's
 * own content, mimicking the "名字: 内容" format used to label speakers in
 * the history it's fed (see groupChatEngine.ts's history mapping) — same
 * mimicry-of-a-compression-format failure mode as the 1:1 commission
 * bracket leak (see aiProtocol.ts's recoverLeakedBubbles). A prompt
 * instruction alone didn't reliably stop it there either, so this strips
 * any leading "<known member name>: " prefix structurally, regardless of
 * whether the name matches the bubble's actual speakerIndex — the visible
 * name label above the bubble already comes from speakerIndex and is
 * always correct, so a baked-in prefix is redundant at best and shows the
 * wrong name at worst.
 */
export function stripSpeakerNamePrefix(content: string, memberNames: string[]): string {
  for (const name of memberNames) {
    if (!name) continue
    const prefix = content.startsWith(`${name}:`)
      ? `${name}:`
      : content.startsWith(`${name}：`)
        ? `${name}：`
        : null
    if (prefix) return content.slice(prefix.length).trim()
  }
  return content
}

export function buildGroupSystemPrompt(opts: {
  stylePrompt: string
  groupName: string
  allMembers: Contact[]
  speakers: Contact[]
  stickerNames: string[]
  currentTimeText: string
  userProfileText: string
  worldviewText?: string
  knowledgeDigestText?: string
}): string {
  const rosterText = opts.allMembers.map((m) => `- ${m.name}`).join('\n')

  const speakerBlocks = opts.speakers
    .map((c, i) => {
      const base = c.relationshipBase || '朋友'
      const dynamic = c.relationshipDynamic ? `（${c.relationshipDynamic}）` : ''
      const plansText = activeUpcomingPlansText(c, new Date())
      const scheduleText = describeCurrentSchedule(c, new Date())
      const factsFallback = `（还没有具体的聊天记忆 但是${base}关系 不是陌生人）`
      const styleFallback = `（语气要符合${base}的关系定位 不能生疏客气）`
      const plansLine = plansText ? `\n【和用户的约定】${plansText}` : ''
      return `发言人${i + 1}: ${c.name}
与用户的关系: ${base}${dynamic}
【人设 - 必须严格遵守】${c.systemPrompt || '自由发挥'}
【当前状态】${scheduleText || '没有特别安排'}
【对用户的了解】${c.memoryFacts || factsFallback}
【和用户相处的习惯】${c.memoryStyle || styleFallback}${plansLine}`
    })
    .join('\n\n')

  const stickersText =
    opts.stickerNames.length > 0
      ? opts.stickerNames.map((n) => `- ${n}`).join('\n')
      : '（当前没有可用表情包）'

  const worldviewPrefix = opts.worldviewText ? `【世界设定】\n${opts.worldviewText}\n\n` : ''
  const knowledgeLine = opts.knowledgeDigestText
    ? `\n热梗资讯: ${opts.knowledgeDigestText}`
    : ''
  const userNickname = opts.userProfileText.match(/昵称:\s*([^·\n]+)/)?.[1]?.trim()

  return `【场景】
这是一个微信群聊，名字叫"${opts.groupName}"。
群里共有 ${opts.allMembers.length} 个人（包括用户"${userNickname || '我'}"）。
你正在扮演下面几位发言人。这几位发言人和用户都在同一个群里，大家都能看到彼此的消息。
你在群里的行为准则：
- 这是一个公开的群聊空间，不是一对一的私聊窗口。不要用"对方"来称呼用户——用户只是群里的一个人。
- 你可以看到群里所有人发的消息（包括其他发言人说的），也应该对其他人说的话做出反应——搭话、接梗、吐槽、附和、反驳，而不是每个人都只对着用户说话。
- 不要每个人都回复用户的每一条消息。真实群聊里，有人话多有人话少，有人甚至会完全潜水一轮不吭声。
- 严格按照你的人设说话。你的人设决定了你的性格、说话风格、兴趣范围——不要让一个内向文静的人主动约人去打篮球，不要让一个高冷的人突然热情洋溢。

${opts.stylePrompt}

${worldviewPrefix}【群聊: ${opts.groupName}】
成员: ${rosterText}
你是以下几位发言人 按各自人设说话:

${speakerBlocks}

【当前】
时间: ${opts.currentTimeText}
用户（群成员之一）: ${opts.userProfileText}${knowledgeLine}

【输出格式】
整个输出必须是JSON:

{"messages":[{"speakerIndex":1,"type":"text","content":"..."},{"speakerIndex":2,"type":"text","content":"..."}],"knowledgeQueries":["..."]}

- speakerIndex=上面发言人编号 不能编造 不能写其他成员
- type=text: content只写这句话本身 **绝对不能加"某某: "名字前缀**(历史记录里那种格式是系统内部辅助 不是真人打字 不能模仿)
- type=sticker: name=下面表情包列表里的名字 不能编造
- 这是一个群聊 你的发言要像在群里聊天一样自然 可以接别人的话 也可以主动开启新话题
- 不是每个人都必须说话 有人多说有人少说甚至不说 更像真实群聊
- 每个人的记忆/约定只有本人能提 别人不能代提
- knowledgeQueries可选 平级字段 不了解的梗/番剧/游戏 最多2个

【表情包】
${stickersText}`
}

function parseSpeakerIndex(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

/**
 * Parses the group turn's JSON, validating each bubble's speakerIndex is
 * actually one of this turn's selected speakers. Falls back to round-robin
 * assigning plain lines across the selected speakers if JSON parsing fails
 * outright, same "still show something real rather than nothing" spirit as
 * the 1:1 parser.
 */
export interface ParsedGroupTurn {
  bubbles: GroupAiBubble[]
  knowledgeQueries: string[]
}

export function parseGroupAiResponse(raw: string, speakerCount: number): ParsedGroupTurn {
  const trimmed = raw.trim()
  if (!trimmed) return { bubbles: [], knowledgeQueries: [] }

  const jsonResult = tryParseGroupJson(trimmed, speakerCount)
  if (jsonResult && jsonResult.bubbles.length > 0) return jsonResult

  const fallbackBubbles = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content, i) => ({ speakerIndex: (i % speakerCount) + 1, type: 'text' as const, content }))
  return { bubbles: fallbackBubbles, knowledgeQueries: [] }
}

function tryParseGroupJson(trimmedRaw: string, speakerCount: number): ParsedGroupTurn | null {
  let text = trimmedRaw
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null

  let parsed: GroupAiResponse | undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    const extracted = extractJsonObject(text)
    if (!extracted) return null
    try {
      parsed = JSON.parse(extracted)
    } catch {
      return null
    }
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null

  const bubbles: GroupAiBubble[] = []
  for (const m of parsed.messages) {
    if (!m || typeof m !== 'object') continue
    const speakerIndex = parseSpeakerIndex((m as { speakerIndex?: unknown }).speakerIndex)
    if (speakerIndex === null || speakerIndex > speakerCount) continue
    if (m.type === 'text' && typeof m.content === 'string' && m.content.trim()) {
      bubbles.push({ speakerIndex, type: 'text', content: m.content.trim() })
    } else if (m.type === 'sticker' && typeof m.name === 'string' && m.name.trim()) {
      bubbles.push({ speakerIndex, type: 'sticker', name: m.name.trim() })
    }
  }
  return { bubbles, knowledgeQueries: parseKnowledgeQueriesField(parsed.knowledgeQueries) }
}

/** Called when a contact is deleted — group membership shouldn't keep dangling references to a contact that no longer exists. */
export async function removeContactFromAllGroups(contactId: string): Promise<void> {
  const groups = await db.groups.toArray()
  for (const group of groups) {
    if (group.memberContactIds.includes(contactId)) {
      await db.groups.update(group.id, {
        memberContactIds: group.memberContactIds.filter((id) => id !== contactId),
      })
    }
  }
}
