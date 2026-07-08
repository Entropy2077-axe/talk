import { chatCompletion } from './deepseek'
import { displayName } from './contact'
import { activeUpcomingPlansText } from './memory'
import { describeCurrentSchedule, describeUpcomingScheduleText } from './schedule'
import type { AiBubble, AppSettings, Contact, GroupAiBubble } from '../types'

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
      return `[link:${b.label}]`
    })
    .join('\n')
}

function groupBubblesText(bubbles: GroupAiBubble[], speakers: Contact[]): string {
  return bubbles
    .map((b) => {
      const speaker = speakers[b.speakerIndex - 1]
      const name = speaker ? displayName(speaker) : `speaker${b.speakerIndex}`
      return b.type === 'text' ? `${name}: ${b.content}` : `${name}: [sticker:${b.name}]`
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
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  const name = displayName(opts.contact)
  const now = new Date()
  const currentSchedule = describeCurrentSchedule(opts.contact, now)
  const upcomingSchedule = describeUpcomingScheduleText(opts.contact, now)
  const upcomingPlans = activeUpcomingPlansText(opts.contact, now)
  const activeMood = opts.contact.mood?.text && Date.now() < opts.contact.mood.expiresAt ? opts.contact.mood.text : ''
  const systemPrompt = `You are a strict roleplay response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Mandatory primary check: logical grounding. Decide whether the reply's inference is tightly supported by its premises: persona/identity, memory, relationship, mood, location, schedule/plans, recent events, and the latest user message.
Then check: (1) reply fits persona, (2) answers user, (3) no invented facts, (4) mood field is present and non-empty, (5) thought field is present and non-empty.
If the prose feels good but the premise→reply logic is weak, unsupported, contradictory, or loosely associated, it is invalid.
If valid, return valid=true.
If invalid, rewrite as fixedRaw. Must include mood and thought: {"messages":[{"type":"text","content":"..."}],"mood":"15字情绪","thought":"30字内心想法 和嘴上说的不一样"}. Keep it short.`
  const strictContinuityPrompt = `Extra invalid cases:
- The user is questioning/correcting the assistant, but the reply ignores that and continues an old bit.
- The reply confuses the persona's own identity with a third party mentioned in chat, such as acting as if "teacher" is the persona when the persona is not a teacher.
- The reply invents concrete scenes like class, teacher, classroom, offline meetings, prior promises, or past events that are not supported by persona/memory/latest message.
- The reply tries to forcibly rationalize a previous mistake instead of naturally clarifying it.
- Logical incoherence: wrong reference resolution, wrong cause/effect, contradictory timeline, contradicting the user's correction, answering a different question, or treating a joke/metaphor as literal without evidence.
- If the user asks "why/what/are you X/did X happen", the reply must directly resolve that logical question before adding emotion or banter.
- Pragmatic/humor failure: if context asks for a specific answer and the user gives an over-broad, tautological, deliberately literal, or absurd answer, treat it as likely humor unless the user sounds distressed. Example: assistant asks "what do you want to eat?", user says "I want to eat rice/food" instead of a dish; a good reply catches the joke or teases lightly, not a literal nutrition/meal-planning response.
- If the user is joking, the reply should acknowledge the joke first, then optionally continue the topic.
When rewriting, answer the latest user message first, keep it short, and admit a mistake naturally if needed.`
  const userPrompt = `Persona name: ${name}
Persona: ${truncate(opts.contact.systemPrompt || '', 700)}
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
${truncate(opts.raw, 1200)}`

  return validateAndMaybeRepair({
    settings: opts.settings,
    systemPrompt: `${systemPrompt}\n${strictContinuityPrompt}`,
    userPrompt,
    raw: opts.raw,
    signal: opts.signal,
  })
}

// ---- optimize mode (force re-feed to main model) ----

/** Mode 2: force-optimize — re-feed the first draft to the main model for improvement. */
export async function optimizePrivateTurn(opts: {
  settings: AppSettings
  contact: Contact
  latestUserText: string
  raw: string
  bubbles: AiBubble[]
  signal?: AbortSignal
}): Promise<string | null> {
  const name = displayName(opts.contact)
  try {
    const optimized = await chatCompletion({
      apiKey: opts.settings.apiKey,
      baseUrl: opts.settings.baseUrl,
      model: opts.settings.model,
      messages: [
        {
          role: 'system',
          content: `你是${name}。优化以下回复草稿：逻辑和事实前提已经优先检查过，你只负责在不改变含义、不新增事实、不改关系/记忆/日程/身份判断的前提下，让措辞更自然有趣、更符合人设。只修改messages里每条text的content文字，不要动JSON结构、不要合并或拆分messages数组、mood和thought必须保留原样。输出格式严格保持不变: {"messages":[{"type":"text","content":"..."}],"mood":"...","thought":"..."}\n\n人设: ${opts.contact.systemPrompt?.slice(0, 600)}\n关系: ${opts.contact.relationshipBase || '朋友'} ${opts.contact.relationshipDynamic || ''}\n对方: ${opts.latestUserText?.slice(0, 300)}`,
        },
        { role: 'user', content: `原始JSON（只优化每条content的文字 其他不动）:\n${opts.raw.slice(0, 2000)}` },
      ],
      jsonMode: false,
      signal: opts.signal,
    })
    if (!optimized) return null
    try {
      const parsed = JSON.parse(optimized.trim())
      if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) return optimized.trim()
    } catch { /* unparseable */ }
    return null
  } catch {
    return null
  }
}

export async function validateGroupTurn(opts: {
  settings: AppSettings
  groupName: string
  speakers: Contact[]
  targetedContext: string
  raw: string
  bubbles: GroupAiBubble[]
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string; detectedInvalid?: boolean }> {
  const speakerText = opts.speakers
    .map((speaker, i) => `${i + 1}. ${displayName(speaker)}: ${truncate(speaker.systemPrompt || '', 260)}`)
    .join('\n')
  const systemPrompt = `You are a strict but lightweight group-chat response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Judge whether each speaker follows their persona, the reply handles @mentions/replies, and the scene remains a group chat.
If valid, return valid=true and omit fixedRaw.
If invalid, rewrite fixedRaw using this exact protocol JSON: {"messages":[{"speakerIndex":1,"type":"text","content":"..."}],"knowledgeQueries":[]}. Only use listed speakerIndex values. Keep it short.`
  const userPrompt = `Group: ${opts.groupName}
Speakers:
${speakerText}
Target context:
${truncate(opts.targetedContext || '(none)', 500)}
Assistant rendered reply:
${truncate(groupBubblesText(opts.bubbles, opts.speakers), 900)}
Raw assistant protocol:
${truncate(opts.raw, 1200)}`

  return validateAndMaybeRepair({
    settings: opts.settings,
    systemPrompt,
    userPrompt,
    raw: opts.raw,
    signal: opts.signal,
  })
}
