import { db } from '../db/db'
import { extractJsonObject, parseKnowledgeQueriesField } from './aiProtocol'
import { activeUpcomingPlansText } from './memory'
import { customPersonalityTraitsLine, formatPersonaProfile, formatSpeechSamplesForScene, personalityTraitLine } from './prompt'
import { describeCurrentSchedule } from './schedule'
import { isModuleEnabled } from '../features'
import type { Contact, GroupAiBubble, GroupAiResponse, GroupEnergyLevel, GroupSpeakerLimit, PromptModuleSettings } from '../types'
import { dynamicRelationScore } from './contactRelations'
import { normalizeMood } from './mood'
import { createDefaultPromptModules, getPromptTemplate, promptModuleEnabled } from './promptModules'

/** Group chats can cap how many members answer per turn; see pickSpeakers. */
const DEFAULT_GROUP_SPEAKER_LIMIT: GroupSpeakerLimit = 3

/** Warmer contacts get picked to speak more often (also reused by proactiveChat.ts). */
export function relationshipWeight(warmth: number): number {
  if (!isModuleEnabled('relationship')) return 1 // uniform when 好感度 disabled
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
 * not left to the model. Mentioned/replied-to members are preferred, then
 * the remaining slots are filled by relationship-weighted sampling.
 */
export function pickSpeakers(
  members: Contact[],
  preferredContactIds: string[] = [],
  speakerLimit: GroupSpeakerLimit = DEFAULT_GROUP_SPEAKER_LIMIT,
): Contact[] {
  const preferredIds = new Set(preferredContactIds)
  const preferred = members.filter((m) => preferredIds.has(m.id))
  const limit = speakerLimit === 'all' ? members.length : Math.min(speakerLimit, members.length)
  if (limit >= members.length) {
    const preferredSet = new Set(preferred.map((m) => m.id))
    return [...preferred, ...members.filter((m) => !preferredSet.has(m.id))]
  }

  const picked = preferred.slice(0, limit)
  if (picked.length >= limit) return picked

  const pickedIds = new Set(picked.map((m) => m.id))
  const rest = members.filter((m) => !pickedIds.has(m.id))
  return [...picked, ...weightedSampleWithoutReplacement(rest, limit - picked.length)]
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

export function buildGroupRawChatPrompt(opts: {
  stylePrompt: string
  groupName: string
  allMembers: Contact[]
  speakers: Contact[]
  stickerNames: string[]
  remoteStickerSearchEnabled?: boolean
  imageGenerationEnabled?: boolean
  imageSearchEnabled?: boolean
  groupMemoryText?: string
  groupVibeText?: string
  allowAiChatter?: boolean
  energyLevel?: GroupEnergyLevel
  currentTimeText: string
  userProfileText: string
  targetedContextText?: string
  recentEventsText?: string
  worldviewText?: string
  knowledgeDigestText?: string
  selfIterationGlobalText?: string
  speakerMemoriesMap?: Map<string, string>
  aiRelationshipText?: string
  promptModules?: PromptModuleSettings
}): string {
  const promptSettings = { promptModules: opts.promptModules ?? createDefaultPromptModules() }
  if (!promptModuleEnabled(promptSettings, 'chat')) return ''
  const relationshipPromptOn = promptModuleEnabled(promptSettings, 'relationship')
  const memoryPromptOn = promptModuleEnabled(promptSettings, 'memory')
  const personalityPromptOn = promptModuleEnabled(promptSettings, 'personalityTraits')
  const selfIterationPromptOn = promptModuleEnabled(promptSettings, 'selfIteration')
  const rosterText = opts.allMembers.map((m) => `- ${m.name}`).join('\n')
  const speakerNames = opts.speakers.map((s) => s.name).join('、')
  const speakerBlocks = opts.speakers
    .map((c, i) => {
      const base = c.relationshipBase || '朋友'
      const plansText = memoryPromptOn ? activeUpcomingPlansText(c, new Date()) : ''
      const scheduleText = describeCurrentSchedule(c, new Date())
      const samplesText = personalityPromptOn ? formatSpeechSamplesForScene(c.speechSamples, 'group', 2) : ''
      const sharedHistoryText = memoryPromptOn && c.sharedHistory?.trim()
        ? `- 与用户的共同过往（只能使用这些事实）: ${c.sharedHistory.trim().slice(0, 1200)}。首轮自然露出一个熟悉度信号。\n`
        : memoryPromptOn ? '- 与用户的共同过往: 暂无具体记录，但不能用陌生人开场。\n' : ''
      const recentMemoText = memoryPromptOn ? opts.speakerMemoriesMap?.get(c.id) : undefined
      return `【发言人${i + 1}: ${c.name}】
逻辑:
- 你是${c.name}，现在在微信群"${opts.groupName}"里。
${relationshipPromptOn ? `- 你和用户的关系: ${base}${c.relationshipDynamic ? `（${c.relationshipDynamic}）` : ''}。\n` : ''}
- 当前状态: ${scheduleText || '没有特别安排'}。
${memoryPromptOn ? `- 对用户的了解: ${c.memoryFacts || '暂无具体聊天记忆'}。\n- 相处习惯: ${c.memoryStyle || '暂无'}。\n${sharedHistoryText}${plansText ? `- 和用户的约定: ${plansText}。\n` : ''}${recentMemoText ? `- 最近记忆碎片:\n${recentMemoText}\n` : ''}` : ''}${selfIterationPromptOn && c.selfIterationPrompt ? `- 关系协商记录:\n${c.selfIterationPrompt}\n` : ''}
感觉:
- 人设必须严格遵守: ${c.systemPrompt || '自由发挥成一个普通朋友'}。${isModuleEnabled('career') && promptModuleEnabled(promptSettings, 'career') && c.occupation ? `职业：${c.occupation}，月薪${c.monthlySalary ?? 0}。` : ''}${c.personaConstraints ? `\n- 用户补充说明（不可违背）: ${c.personaConstraints}` : ''}${c.personaProfile ? `\n- 人设硬约束:\n${formatPersonaProfile(c.personaProfile)}` : ''}
${personalityPromptOn ? `${c.mbti ? `- MBTI: ${c.mbti}。` : ''}${personalityTraitLine(c.personalityTrait, c.warmth ?? 0)}${customPersonalityTraitsLine(c.customPersonalityTraits, c.warmth ?? 0)}` : ''}
${samplesText ? `- 说话样例:\n${samplesText}` : ''}`
    })
    .join('\n\n')

  const stickersText = [
    opts.stickerNames.length > 0 ? `本地表情（名称必须完全一致）:\n${opts.stickerNames.map((n) => `- ${n}`).join('\n')}` : '',
    opts.remoteStickerSearchEnabled ? '远程表情搜索已启用：也可以使用简短、具体的情绪/动作搜索词，优先用英文。' : '',
  ].filter(Boolean).join('\n') || '（当前没有可用表情包）'
  const targetedContext = opts.targetedContextText
    ? `\n【本轮定向上下文】\n${opts.targetedContextText}\n如果用户@某人，那个人必须优先回应；如果用户回复某条消息，先回应被回复内容再自然延展。`
    : ''
  const recentEvents = opts.recentEventsText ? `\n【最近发生的事】\n${opts.recentEventsText}` : ''
  const aiRelationships = relationshipPromptOn && opts.aiRelationshipText ? `\n${opts.aiRelationshipText}` : ''
  const worldview = opts.worldviewText ? `\n${getPromptTemplate(promptSettings, 'worldview', 'groupRuntime', { worldbookEntries: opts.worldviewText }) ?? ''}` : ''
  const stylePrompt = getPromptTemplate(promptSettings, 'chat', 'style') ?? ''
  const knowledge = promptModuleEnabled(promptSettings, 'knowledgeBase') && opts.knowledgeDigestText ? `\n【可参考资讯】\n${opts.knowledgeDigestText}` : ''
  const selfIteration = selfIterationPromptOn && opts.selfIterationGlobalText ? `\n【用户边界与偏好 - 全局】\n${opts.selfIterationGlobalText}` : ''
  const groupMemory = memoryPromptOn && opts.groupMemoryText?.trim() ? `\n【群聊记忆】\n${opts.groupMemoryText.trim()}` : ''
  const groupVibe = opts.groupVibeText?.trim() ? `\n【群聊氛围】\n${opts.groupVibeText.trim()}` : ''
  const editableGroupPrompt = getPromptTemplate(promptSettings, 'chat', 'groupMain', {
    groupName: opts.groupName,
    roster: rosterText,
    speakers: speakerNames,
    aiChatterMode: opts.allowAiChatter === false ? '关闭，只围绕用户及用户相关话题' : '开启，存在自然接点时允许成员互相接话',
    energyLevel: opts.energyLevel ?? 'normal',
    stylePrompt,
    worldbookPrompt: worldview,
    currentTime: opts.currentTimeText,
    userProfile: opts.userProfileText,
    additionalContext: [groupMemory, groupVibe, knowledge, targetedContext, recentEvents, aiRelationships, selfIteration].filter(Boolean).join('\n'),
    speakerProfiles: speakerBlocks,
    stickerCapabilities: opts.remoteStickerSearchEnabled ? `支持远程搜索；本地可用项：${stickersText}` : stickersText,
    imageCapabilities: opts.imageGenerationEnabled ? '支持按完整英文提示词生图' : opts.imageSearchEnabled ? '支持按英文关键词搜索真实图片' : '未启用',
  }) ?? ''
  const finalPrompt = `${editableGroupPrompt}

固定输出协议（不可编辑）：
- 只输出群聊纯文本草稿，不输出JSON、分析、标题或Markdown。
- 每一行严格使用：<人名>（想法）[emoji心情]“消息内容”
- 人名只能来自本轮发言人；想法和心情不得为空；心情只能使用一个允许的emoji。
- 表情写成[sticker:名称或搜索词]；图片写成[image:英文提示词或搜索词:配文]；陌生知识查询写成[knowledge:关键词]。
- 消息内容不得残留人名冒号、结构标记或外层格式。`

  return finalPrompt
}

/**
 * Group turns should be driven by who has a reason to engage with each other,
 * not only by who likes the user most. Mentions/replies still win outright;
 * remaining slots favour a mix of user relevance and live member-to-member
 * ties so established pairs can naturally carry a thread or a tense pair can
 * occasionally create believable friction.
 */
export async function pickSociallyConnectedSpeakers(
  members: Contact[],
  preferredContactIds: string[] = [],
  speakerLimit: GroupSpeakerLimit = DEFAULT_GROUP_SPEAKER_LIMIT,
): Promise<Contact[]> {
  const limit = speakerLimit === 'all' ? members.length : Math.min(speakerLimit, members.length)
  const preferredSet = new Set(preferredContactIds)
  const picked = members.filter((member) => preferredSet.has(member.id)).slice(0, limit)
  if (picked.length >= limit || members.length <= 1) return picked.length >= limit ? picked : [...picked, ...members.filter((m) => !preferredSet.has(m.id))]

  const ids = new Set(members.map((member) => member.id))
  const links = (await db.contactRelations.toArray()).filter((link) => ids.has(link.fromContactId) && ids.has(link.toContactId))
  const relationScore = (fromId: string, toId: string) => {
    const link = links.find((candidate) =>
      (candidate.fromContactId === fromId && candidate.toContactId === toId)
      || (candidate.fromContactId === toId && candidate.toContactId === fromId),
    )
    return link ? dynamicRelationScore(link) : 0
  }
  const choose = (pool: Contact[]) => {
    const weighted = pool.map((contact) => {
      const userWeight = relationshipWeight(contact.warmth ?? 0)
      const social = picked.length === 0 ? 0 : picked.reduce((sum, other) => sum + relationScore(contact.id, other.id) + relationScore(other.id, contact.id), 0) / (picked.length * 2)
      // Keep every member viable: social affinity enhances relevance but never
      // converts low warmth into a permanent mute button.
      return { c: contact, w: Math.max(1, userWeight * (1 + Math.max(-0.45, Math.min(0.8, social / 160)))) }
    })
    const total = weighted.reduce((sum, entry) => sum + entry.w, 0)
    let roll = Math.random() * total
    for (const entry of weighted) {
      roll -= entry.w
      if (roll <= 0) return entry.c
    }
    return weighted[weighted.length - 1]?.c
  }

  while (picked.length < limit) {
    const candidate = choose(members.filter((member) => !picked.some((current) => current.id === member.id)))
    if (!candidate) break
    picked.push(candidate)
  }
  return picked
}

export function buildGroupJsonConversionPrompt(
  rawText: string,
  speakers: Contact[],
  stickerNames: string[],
  options: { remoteStickerSearchEnabled?: boolean; imageGenerationEnabled?: boolean } = {},
): string {
  const speakerLines = speakers.map((speaker, i) => `${i + 1}. ${speaker.name}`).join('\n')
  const stickersText = stickerNames.length > 0 ? stickerNames.join('、') : '（无）'
  return `把下面的群聊纯文本草稿机械转换成JSON。不要润色、不要改写、不要新增消息。

【发言人索引】
${speakerLines}

【可用表情包】
${stickersText}

【草稿】
${rawText}

【抽取规则】
- 每一行格式通常是 <人名>（想法）[心情]“消息内容”。
- speakerIndex 必须按上面的发言人索引填写；speakerName 保留原人名用于调试。
- content 只放双引号里的消息内容，去掉外层引号，不能残留<人名>、（想法）、[心情]。
- thought 取圆括号里的想法，原样保留。
- mood 取方括号里的心情，原样保留。
- 每条消息都必须有非空 thought 和 mood；草稿缺失时根据该行语境补一个短的。
- 如果消息内容是 [sticker:名字]，输出 {"speakerIndex":n,"speakerName":"...","type":"sticker","name":"名字","thought":"...","mood":"..."}。
- 如果消息内容是 [image:英文图片请求词:配文]，输出image类型及query/caption字段；标记不能留在text正文。${options.imageGenerationEnabled ? '这里的 query 是完整生图提示词，不要改写或缩短。' : ''}
- ${options.remoteStickerSearchEnabled ? '远程表情搜索已启用，sticker 的 name 可以是草稿里的搜索词，不要因为它不在本地列表而改成文字。' : 'sticker 名字必须来自可用表情包；不在列表里就改成普通text内容。'}
- 如果草稿里自然提到不懂的新词/热梗/作品名，可在knowledgeQueries里放最多2个查询；没有就给空数组。
- 必须把[knowledge:关键词]从消息正文删除并写入顶层knowledgeQueries；不能把标记展示给用户。
- turnSummary 用一句话概括这一轮群聊发生了什么。
- planCandidates 只在本轮出现至少两位成员明确同意的共同计划时填写；participantIndexes 使用发言人索引，不能凭空创建计划。
- groupVibe 必填，用20到60字概括本轮之后最新的群聊氛围，会直接替换旧群聊氛围。

只输出JSON，格式:
{"messages":[{"speakerIndex":1,"speakerName":"...","type":"text","content":"...","thought":"...","mood":"..."}],"turnSummary":"...","groupVibe":"...","knowledgeQueries":[],"planCandidates":[{"title":"看电影","summary":"周末一起看电影","participantIndexes":[1,2],"location":"待定"}]}`
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
  turnSummary: string
  groupVibe: string
  planCandidates: Array<{ title: string; summary: string; participantIndexes: number[]; location?: string }>
}

export interface ParsedGroupRawDraft extends ParsedGroupTurn {
  valid: boolean
  reason?: string
  needsUtility: boolean
}

/**
 * Deterministically parses the strict line protocol emitted by the main group
 * model. Normal text/sticker/image/knowledge turns no longer need a second
 * model merely to copy fields into JSON.
 */
export function parseGroupRawDraft(
  raw: string,
  speakers: Contact[],
  stickerNames: string[] = [],
  remoteStickerSearchEnabled = false,
): ParsedGroupRawDraft {
  const empty: ParsedGroupRawDraft = {
    valid: false,
    reason: '草稿为空',
    needsUtility: false,
    bubbles: [],
    knowledgeQueries: [],
    turnSummary: '',
    groupVibe: '',
    planCandidates: [],
  }
  if (!raw.trim() || speakers.length === 0) return empty

  const speakerIndexByName = new Map(speakers.map((speaker, index) => [speaker.name, index + 1]))
  const bubbles: GroupAiBubble[] = []
  const knowledgeQueries: string[] = []
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^<([^>]+)>（([^）]+)）\[([^\]]+)\]“([\s\S]+)”[。.]?$/)
    if (!match) return { ...empty, reason: `第${index + 1}行格式不完整` }
    const speakerIndex = speakerIndexByName.get(match[1].trim())
    if (!speakerIndex) return { ...empty, reason: `第${index + 1}行使用了非本轮发言人` }

    const thought = match[2].trim().slice(0, 100)
    const mood = match[3].trim().slice(0, 10)
    const content = match[4].trim()
    const common = {
      speakerIndex,
      speakerName: speakers[speakerIndex - 1].name,
      thought,
      mood,
    }
    const knowledge = content.match(/^\[knowledge:([^\]]+)\]$/i)
    if (knowledge) {
      if (knowledgeQueries.length < 2) knowledgeQueries.push(knowledge[1].trim())
      continue
    }
    const sticker = content.match(/^\[sticker:([^\]]+)\]$/i)
    if (sticker) {
      const name = sticker[1].trim()
      if (!remoteStickerSearchEnabled && !stickerNames.includes(name)) {
        return { ...empty, reason: `第${index + 1}行使用了不存在的表情包` }
      }
      bubbles.push({ ...common, type: 'sticker', name })
      continue
    }
    const image = content.match(/^\[image:([^:\]]+):([^\]]*)\]$/i)
    if (image) {
      bubbles.push({
        ...common,
        type: 'image',
        query: image[1].trim().slice(0, 100),
        caption: image[2].trim().slice(0, 100) || undefined,
      })
      continue
    }
    bubbles.push({ ...common, type: 'text', content })
  }

  const turnSummary = bubbles
    .map((bubble) => `${bubble.speakerName || speakers[bubble.speakerIndex - 1]?.name || '群成员'}：${
      bubble.type === 'text' ? bubble.content : bubble.type === 'sticker' ? `[表情包:${bubble.name}]` : `[图片:${bubble.caption || bubble.query}]`
    }`)
    .join('；')
    .slice(0, 180)
  // Joint plans need participant extraction and agreement checks, so retain
  // the utility model only for turns that may contain a structured plan.
  const planText = bubbles
    .filter((bubble) => bubble.type === 'text')
    .map((bubble) => bubble.content)
    .join('\n')
  const hasJointAction = /(一起|碰面|见面|约好|改期|定在|计划|安排)/
  const hasConcreteTime = /(明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|几点|上午|下午|晚上|今晚|\d{1,2}[点:：])/
  const needsUtility =
    (hasJointAction.test(planText) && hasConcreteTime.test(planText))
    || /(大家都同意|都答应了|就这么定|说好了)/.test(planText)

  return {
    valid: bubbles.length > 0,
    needsUtility,
    bubbles,
    knowledgeQueries,
    turnSummary,
    groupVibe: '',
    planCandidates: [],
  }
}

export function serializeGroupTurn(parsed: ParsedGroupTurn): string {
  return JSON.stringify({
    messages: parsed.bubbles,
    turnSummary: parsed.turnSummary,
    groupVibe: parsed.groupVibe,
    knowledgeQueries: parsed.knowledgeQueries,
    planCandidates: parsed.planCandidates,
  })
}

export function parseGroupAiResponse(raw: string, speakerCount: number): ParsedGroupTurn {
  const trimmed = raw.trim()
  if (!trimmed) return { bubbles: [], knowledgeQueries: [], turnSummary: '', groupVibe: '', planCandidates: [] }

  const jsonResult = tryParseGroupJson(trimmed, speakerCount)
  if (jsonResult && jsonResult.bubbles.length > 0) return jsonResult

  const fallbackBubbles = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content, i) => ({ speakerIndex: (i % speakerCount) + 1, type: 'text' as const, content }))
  return { bubbles: fallbackBubbles, knowledgeQueries: [], turnSummary: fallbackBubbles.map((b) => b.content).join(' ').slice(0, 160), groupVibe: '群聊氛围暂未更新。', planCandidates: [] }
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
    const speakerName = typeof (m as { speakerName?: unknown }).speakerName === 'string' ? (m as { speakerName: string }).speakerName.trim() : undefined
    const thought = typeof (m as { thought?: unknown }).thought === 'string' ? (m as { thought: string }).thought.trim() : undefined
    const mood = typeof (m as { mood?: unknown }).mood === 'string' ? normalizeMood((m as { mood: string }).mood) : undefined
    if (m.type === 'text' && typeof m.content === 'string' && m.content.trim()) {
      bubbles.push({ speakerIndex, speakerName, type: 'text', content: m.content.trim(), thought, mood })
    } else if (m.type === 'sticker' && typeof m.name === 'string' && m.name.trim()) {
      bubbles.push({ speakerIndex, speakerName, type: 'sticker', name: m.name.trim(), thought, mood })
    } else if (m.type === 'image' && typeof (m as unknown as {query?:unknown}).query === 'string') {
      const im=m as unknown as {query:string;caption?:unknown}; bubbles.push({speakerIndex,speakerName,type:'image',query:im.query.trim().slice(0,100),caption:typeof im.caption==='string'?im.caption.slice(0,100):undefined,thought,mood})
    }
  }
  return {
    bubbles,
    knowledgeQueries: parseKnowledgeQueriesField(parsed.knowledgeQueries),
    turnSummary: typeof parsed.turnSummary === 'string' ? parsed.turnSummary.trim() : '',
    groupVibe: typeof parsed.groupVibe === 'string' ? parsed.groupVibe.trim() : '',
    planCandidates: Array.isArray(parsed.planCandidates) ? parsed.planCandidates.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const value = item as { title?: unknown; summary?: unknown; participantIndexes?: unknown; location?: unknown }
      const participantIndexes = Array.isArray(value.participantIndexes)
        ? value.participantIndexes.filter((index): index is number => Number.isInteger(index) && index >= 1 && index <= speakerCount)
        : []
      return typeof value.title === 'string' && value.title.trim() && participantIndexes.length >= 2
        ? [{ title: value.title.trim().slice(0, 80), summary: typeof value.summary === 'string' ? value.summary.trim().slice(0, 180) : value.title.trim(), participantIndexes: Array.from(new Set(participantIndexes)), location: typeof value.location === 'string' ? value.location.trim().slice(0, 80) : undefined }]
        : []
    }).slice(0, 1) : [],
  }
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
