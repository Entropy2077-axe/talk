import { chatCompletion } from './deepseek'
import { displayName } from './contact'
import { activeUpcomingPlansText } from './memory'
import { describeCurrentSchedule, describeUpcomingScheduleText } from './schedule'
import { formatPersonaProfile, personalityTraitLine } from './prompt'
import type { AiBubble, AppSettings, Contact, GroupAiBubble, GroupEnergyLevel } from '../types'

interface QualityResult {
  valid: boolean
  reason: string
  fixedRaw?: string
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function parseQualityResult(raw: string): QualityResult | null {
  try {
    const parsed = JSON.parse(raw.trim())
    if (!parsed || typeof parsed !== 'object') return null
    return {
      valid: parsed.valid === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '',
      fixedRaw: typeof parsed.fixedRaw === 'string' && parsed.fixedRaw.trim() ? parsed.fixedRaw.trim() : undefined,
    }
  } catch {
    return null
  }
}

function privateBubblesText(bubbles: AiBubble[]): string {
  return bubbles
    .map((b) => {
      if (b.type === 'text') return b.content
      if (b.type === 'sticker') return `[sticker:${b.name}]`
      if (b.type === 'scheduleChange') return `[schedule:${b.summary}]`
      if (b.type === 'link') return `[link:${b.label}]`
      if (b.type === 'image') return `[image:${b.query}:${b.caption ?? ''}]`
      return `[finance:${b.type}:${b.amount}]`
    })
    .join('\n')
}

function groupBubblesText(bubbles: GroupAiBubble[], speakers: Contact[]): string {
  return bubbles
    .map((b) => {
      const speaker = speakers[b.speakerIndex - 1]
      const name = speaker ? displayName(speaker) : `speaker${b.speakerIndex}`
      const meta = [b.thought ? `thought=${b.thought}` : '', b.mood ? `mood=${b.mood}` : ''].filter(Boolean).join(', ')
      const suffix = meta ? ` (${meta})` : ''
      return b.type === 'text' ? `${name}: ${b.content}${suffix}` : b.type === 'sticker' ? `${name}: [sticker:${b.name}]${suffix}` : `${name}: [image:${b.query}]${suffix}`
    })
    .join('\n')
}

async function validateAndMaybeRepair(opts: {
  settings: AppSettings
  systemPrompt: string
  userPrompt: string
  raw: string
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  try {
    const judged = await chatCompletion({
      apiKey: opts.settings.apiKey,
      baseUrl: opts.settings.baseUrl,
      model: opts.settings.utilityModel || opts.settings.model,
      jsonMode: true,
      signal: opts.signal,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
      purpose: 'quality',
    })
    const result = parseQualityResult(judged)
    if (!result) {
      return { raw: opts.raw, repaired: false }
    }
    if (result.valid) return { raw: opts.raw, repaired: false }
    if (!result.fixedRaw) {
      const reason = result.reason || 'invalid_without_fixedRaw'
      console.warn('[quality] 判定无效但未提供fixedRaw，原样放行', reason)
      return { raw: opts.raw, repaired: false, reason, detectedInvalid: true }
    }
    return { raw: result.fixedRaw, repaired: true, reason: result.reason }
  } catch {
    return { raw: opts.raw, repaired: false }
  }
}

export async function validatePrivateTurn(opts: {
  settings: AppSettings
  contact: Contact
  latestUserText: string
  recentConversationText?: string
  raw: string
  bubbles: AiBubble[]
  worldbookText?: string
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  const name = displayName(opts.contact)
  const now = new Date()
  const currentSchedule = describeCurrentSchedule(opts.contact, now)
  const upcomingSchedule = describeUpcomingScheduleText(opts.contact, now)
  const upcomingPlans = activeUpcomingPlansText(opts.contact, now)
  const activeMood = opts.contact.mood?.text && Date.now() < opts.contact.mood.expiresAt ? opts.contact.mood.text : ''
  const worldbookInfo = opts.worldbookText ? `\nWorldbook (canon world rules — content consistent with these is NOT "invented facts", it is legitimate world-building):\n${opts.worldbookText}` : ''
  const systemPrompt = `You are a strict roleplay response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Mandatory primary check: logical grounding. Decide whether the reply's inference is tightly supported by its premises: persona/identity, memory, relationship, mood, location, schedule/plans, recent events,${opts.worldbookText ? ' worldbook (see user prompt),' : ''} and the latest user message.
Then check: (1) reply fits persona and personality trait, (2) never violates user-authored persona constraints, (3) answers user, (4) no invented facts — BUT worldbook entries define canonical world rules; content grounded in an active worldbook entry is NOT "invented" even if it seems fantastical, (5) mood/thought are present. A trait may be subtle, but a reply that directly contradicts its behavioral anchor is invalid.
If the prose feels good but the premise→reply logic is weak, unsupported, contradictory, or loosely associated, it is invalid.
If valid, return valid=true.
If invalid, rewrite as fixedRaw. Must include mood and thought: {"messages":[{"type":"text","content":"..."}],"mood":"15字情绪","thought":"30字内心想法 和嘴上说的不一样"}. Keep it short.`
  const strictContinuityPrompt = `Extra invalid cases:
- The user is questioning/correcting the assistant, but the reply ignores that and continues an old bit.
- The reply confuses the persona's own identity with a third party mentioned in chat, such as acting as if "teacher" is the persona when the persona is not a teacher.
- The reply invents concrete scenes like class, teacher, classroom, offline meetings, prior promises, or past events that are not supported by persona/memory/latest message${opts.worldbookText ? ' or worldbook entries' : ''}.
- The reply tries to forcibly rationalize a previous mistake instead of naturally clarifying it.
- Logical incoherence: wrong reference resolution, wrong cause/effect, contradictory timeline, contradicting the user's correction, answering a different question, or treating a joke/metaphor as literal without evidence.
- If the user asks "why/what/are you X/did X happen", the reply must directly resolve that logical question before adding emotion or banter.
- Pragmatic/humor failure: if context asks for a specific answer and the user gives an over-broad, tautological, deliberately literal, or absurd answer, treat it as likely humor unless the user sounds distressed. Example: assistant asks "what do you want to eat?", user says "I want to eat rice/food" instead of a dish; a good reply catches the joke or teases lightly, not a literal nutrition/meal-planning response.
- If the user is joking, the reply should acknowledge the joke first, then optionally continue the topic.
- Repetition failure: reject a reply that keeps escalating, rephrasing, or re-selling the same request, object, joke, or proposal from the recent conversation (for example repeatedly asking the user to buy ice cream in slightly different quantities) when the user did not explicitly continue that topic. Rewrite by answering the newest message and moving naturally onward.
When rewriting, answer the latest user message first, keep it short, and admit a mistake naturally if needed.`
  const userPrompt = `Persona name: ${name}
Persona: ${truncate(opts.contact.systemPrompt || '', 700)}
User-authored persona constraints: ${truncate(opts.contact.personaConstraints || '(none)', 500)}
Structured persona anchors: ${truncate(formatPersonaProfile(opts.contact.personaProfile) || '(none)', 700)}
Personality trait: ${truncate(personalityTraitLine(opts.contact.personalityTrait, opts.contact.warmth ?? 0) || '(none)', 900)}
Relationship: ${opts.contact.relationshipBase || '朋友'} ${truncate(opts.contact.relationshipDynamic || '', 160)}
Memory/style: ${truncate(opts.contact.memoryStyle || opts.contact.memoryFacts || '', 260)}
Current mood: ${activeMood || '(none)'}
Current schedule/location: ${currentSchedule || '(none)'}
Upcoming schedule: ${upcomingSchedule || '(none)'}
Plans with user: ${upcomingPlans || '(none)'}
Recent conversation:
${truncate(opts.recentConversationText || '(none)', 1200)}
Latest user message: ${truncate(opts.latestUserText || '(background event)', 500)}
Assistant rendered reply:
${truncate(privateBubblesText(opts.bubbles), 900)}
Raw assistant protocol:
${truncate(opts.raw, 1200)}${worldbookInfo}`

  return validateAndMaybeRepair({
    settings: opts.settings,
    systemPrompt: `${systemPrompt}\n${strictContinuityPrompt}`,
    userPrompt,
    raw: opts.raw,
    signal: opts.signal,
  })
}

export async function validateGroupTurn(opts: {
  settings: AppSettings
  groupName: string
  speakers: Contact[]
  targetedContext: string
  raw: string
  bubbles: GroupAiBubble[]
  worldbookText?: string
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  const speakerText = opts.speakers
    .map((speaker, i) => `${i + 1}. ${displayName(speaker)}: ${truncate(speaker.systemPrompt || '', 260)}`)
    .join('\n')
  const worldbookInfo = opts.worldbookText ? `\nActive worldbook entries (canon world rules — content consistent with these is NOT "invented facts"):
${opts.worldbookText}` : ''
  const systemPrompt = `You are a strict group-chat response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Judge whether each speaker follows their persona, the reply handles @mentions/replies, and the scene remains a natural group chat rather than several private replies to the user.
Also check the protocol: speakerIndex must be one of the listed speakers; content must not contain leaked <name>, speaker-name prefixes, parenthesized thoughts, bracketed moods, or wrapping quotes; every message must include non-empty thought and mood, and they must not leak into content; groupVibe must be present and non-empty.${opts.worldbookText ? ' Content grounded in an active worldbook entry is NOT "invented facts" — worldbook defines canon world rules.' : ''}
If valid, return valid=true and omit fixedRaw.
If invalid, rewrite fixedRaw using this exact protocol JSON: {"messages":[{"speakerIndex":1,"speakerName":"...","type":"text","content":"...","thought":"...","mood":"..."}],"turnSummary":"...","groupVibe":"...","knowledgeQueries":[]}. Only use listed speakerIndex values. Keep it short.`
  const userPrompt = `Group: ${opts.groupName}
Speakers:
${speakerText}
Target context:
${truncate(opts.targetedContext || '(none)', 500)}
Assistant rendered reply:
${truncate(groupBubblesText(opts.bubbles, opts.speakers), 900)}
Raw assistant protocol:
${truncate(opts.raw, 1200)}${worldbookInfo}`

  return validateAndMaybeRepair({
    settings: opts.settings,
    systemPrompt,
    userPrompt,
    raw: opts.raw,
    signal: opts.signal,
  })
}

export async function validateGroupDraft(opts: {
  settings: AppSettings
  groupName: string
  speakers: Contact[]
  rawText: string
  allowAiChatter: boolean
  energyLevel: GroupEnergyLevel
  targetedContext: string
  worldbookText?: string
  signal?: AbortSignal
}): Promise<{ valid: boolean; reason?: string }> {
  const speakerText = opts.speakers.map((speaker, i) => `${i + 1}. ${displayName(speaker)}`).join('\n')
  const energyRule =
    opts.energyLevel === 'cold'
      ? '冷淡: 整轮应有1到3句话。'
      : opts.energyLevel === 'lively'
        ? '热闹: 整轮应有6到12句话，可以多次穿插发言。'
        : '普通: 整轮应有3到7句话。'
  const chatterRule = opts.allowAiChatter
    ? opts.speakers.length >= 2
      ? 'AI互聊已开启: 有自然接点时可以出现AI之间互动；不能为了满足规则而强行点名或接话。'
      : '本轮只有一位AI发言人: 不要求AI之间互动。'
    : 'AI互聊已关闭: 草稿必须围绕用户、用户@/回复对象或用户相关话题，不要发展AI之间的旁支闲聊。'

  try {
    const judged = await chatCompletion({
      apiKey: opts.settings.apiKey,
      baseUrl: opts.settings.baseUrl,
      model: opts.settings.utilityModel || opts.settings.model,
      jsonMode: true,
      signal: opts.signal,
      messages: [
        {
          role: 'system',
          content: `你是严格的群聊主模型草稿校验器。只输出JSON: {"valid":true/false,"reason":"short"}。

检查对象是主模型尚未转换成JSON的群聊纯文本草稿。

必须检查:
1. 每一行是否严格类似 <人名>（想法）[心情]“消息内容”，且草稿第一行是否直接从 < 开始，没有解释、标题、编号、JSON或Markdown。
2. 每一行是否都有非空“想法”和“心情”，括号是否为中文全角圆括号（），心情是否为半角方括号[]，消息是否为中文弯引号“”。
3. 人名是否只来自本轮发言人。
4. 是否符合群聊热闹程度: ${energyRule}
5. 是否符合AI互聊规则: ${chatterRule}
6. 发言顺序是否自然，允许同一人多次插入，不要求按发言人顺序轮流。
7. 草稿是否像真实群聊，而不是每个人机械回答用户。
8. 草稿是否过度复读同一个特殊词、梗、比喻、称号或外号；如果多名AI都围绕同一个词解释/吐槽/复述，应判为无效。
9. 草稿是否有话题推进；如果同一个梗已经被反复接住，除非用户明确继续问这个梗，否则应该收束或自然转到相邻话题。

只要违反任一必需规则，就 valid=false，并用一句话指出最重要的问题。${opts.worldbookText ? `\n\n注意：以下世界书条目定义了这个世界的规则。草稿中符合世界书设定的内容不属于"编造"或"偏离人设"，是合理的世界构建。\n世界书：\n${opts.worldbookText}` : ''}`,
        },
        {
          role: 'user',
          content: `群名: ${opts.groupName}
本轮发言人:
${speakerText}

定向上下文:
${truncate(opts.targetedContext || '(none)', 600)}

草稿:
${truncate(opts.rawText, 3000)}`,
        },
      ],
      purpose: 'quality',
    })
    const result = parseQualityResult(judged)
    if (!result) return { valid: true }
    return { valid: result.valid, reason: result.reason || undefined }
  } catch {
    return { valid: true }
  }
}
