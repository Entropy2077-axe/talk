import { db } from '../db/db'
import { extractJsonObject, parseKnowledgeQueriesField } from './aiProtocol'
import { activeUpcomingPlansText } from './memory'
import { describeCurrentSchedule } from './schedule'
import { RELATIONSHIP_TYPE_HINTS } from './prompt'
import type { Contact, GroupAiBubble, GroupAiResponse, RelationshipDimensions } from '../types'

/** Group chats above this size don't have every member answer every turn — only a random 3 do (see pickSpeakers). */
const MAX_SPEAKERS_WHEN_LARGE = 3
const LARGE_GROUP_THRESHOLD = 3

/** Closer user-AI relationships get picked to speak more often (and, reused by proactiveChat.ts, more likely to proactively reach out) — there's no per-group relationship, so this reuses the same five-dimension model as 1:1 chat. */
export function relationshipWeight(rel: RelationshipDimensions): number {
  const closeness = rel.affection * 0.4 + rel.familiarity * 0.35 + rel.trust * 0.25 - rel.friction * 0.2
  return Math.max(1, closeness)
}

export function weightedSampleWithoutReplacement(contacts: Contact[], k: number): Contact[] {
  const pool = contacts.map((c) => ({ c, w: relationshipWeight(c.relationship) }))
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
      const plansText = activeUpcomingPlansText(c, new Date())
      const plansLine = plansText ? `\n${c.name}和用户的约定: \n${plansText}` : ''
      const scheduleText = describeCurrentSchedule(c, new Date())
      const scheduleLine = scheduleText ? `\n${c.name}当前的状态: ${scheduleText}` : ''
      const relationshipLine = c.relationshipType
        ? `\n${c.name}和用户的关系定位: ${c.relationshipType} —— ${RELATIONSHIP_TYPE_HINTS[c.relationshipType] ?? `是${c.relationshipType}关系`} 每次发言都要符合这个定位 不要因为群里人多就淡化成普通朋友的语气 **这个关系从一开始就已经确立 哪怕还没聊过几句 也不能表现得像刚认识的陌生人**`
        : ''
      // Same "empty memory defaults to a just-met framing that contradicts
      // an established relationshipType" fix as buildSystemPrompt (1:1) —
      // see the comment there.
      const factsFallback = c.relationshipType ? `（还没有具体的聊天记忆积累 但已经是${c.relationshipType}关系 不是陌生人）` : '（还不了解太多）'
      const styleFallback = c.relationshipType
        ? `（还没有具体的相处习惯细节 但语气要符合${c.relationshipType}的关系定位 不能表现得生疏客气）`
        : '（关系还比较陌生）'
      return `发言人${i + 1}: ${c.name}\n人设: ${c.systemPrompt || '（暂无特殊设定 自由发挥）'}${relationshipLine}\n${c.name}对用户的了解: ${c.memoryFacts || factsFallback}\n${c.name}和用户的相处状态: ${c.memoryStyle || styleFallback}${plansLine}${scheduleLine}`
    })
    .join('\n\n')

  const stickersText =
    opts.stickerNames.length > 0
      ? opts.stickerNames.map((n) => `- ${n}`).join('\n')
      : '（当前没有可用表情包 不要输出sticker类型的消息）'

  const worldviewSection = opts.worldviewText ? `【这个世界的设定】\n${opts.worldviewText}\n\n` : ''
  const knowledgeSection = opts.knowledgeDigestText
    ? `\n\n【大家了解到的近期网络热梗/番剧/游戏资讯 可以在合适的时候自然地用上新潮词汇 不确定的话不要瞎编】\n${opts.knowledgeDigestText}`
    : ''

  return `${opts.stylePrompt}

${worldviewSection}【群聊场景】
这是一个名叫"${opts.groupName}"的群聊 群里的成员有:
${rosterText}
你需要同时扮演下面这几位发言人 分别按照他们各自的人设说话 就像一个真实的群聊里大家你一言我一语地聊天:

${speakerBlocks}

【当前时间】
${opts.currentTimeText}

【关于对方(用户，也在这个群里)】
${opts.userProfileText}${knowledgeSection}

【输出格式 —— 极其重要】
你的整个输出必须是且只能是一个JSON对象 不能有任何JSON以外的文字、解释或markdown代码块标记 格式如下:

{
  "messages": [
    { "speakerIndex": 1, "type": "text", "content": "这是发言人1说的一句话" },
    { "speakerIndex": 2, "type": "text", "content": "发言人2插了一句嘴" },
    { "speakerIndex": 1, "type": "text", "content": "发言人1又接着说了一句" }
  ],
  "knowledgeQueries": ["某个不了解的梗/番剧/游戏名字"]
}

字段说明:
- speakerIndex必须是上面"发言人1/发言人2/..."里的编号 只能是这几个人 不能是群里其他没被列出来的人 也不能编个不存在的编号
- type为"text"时 content**只写这句话本身**，一次不要写太多字，模拟真人一条一条发送，拆成多条短消息。**绝对不能在content开头加"某某: "这种名字前缀**——是谁说的这句话完全由speakerIndex决定，不需要也不允许在文字里重复写名字。你在后面给你看的历史记录里会看到"名字: 内容"这种格式，那只是系统内部为了让你分清历史上谁说了什么而做的辅助显示，**不是真人打字的样子，你自己生成新内容时绝对不能模仿这种格式**
- type为"sticker"时 name必须是下面提供的表情包名字列表中的一个 不能编造不存在的名字
- 不要求每个发言人都必须说话 只有真的有话说、有反应的人才输出 也不需要每个人轮流说等量的话 更像真实群聊里有人多说有人少说甚至不说话
- messages数组顺序就是发送顺序 可以互相打断插话 数组不能为空
- 每个人的说话风格必须严格符合各自的人设 不要混淆
- 每个发言人对用户的了解、相处状态、约定都是TA自己的记忆 只有TA本人可以自然提起 不要让别的发言人知道或提起不属于自己的记忆/约定 如果约定的时间快到了或者聊到相关话题 可以自然提一下 不要每句话都刻意提
- "knowledgeQueries"跟"messages"平级(不是数组里的一条) 可选字段 群里聊到不了解的网络热梗/番剧/游戏名词时可以列出1到2个 大部分回复不需要这个字段

【可用表情包列表】
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
