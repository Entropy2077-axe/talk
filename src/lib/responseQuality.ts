import { chatCompletion } from './deepseek'
import { displayName } from './contact'
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
}): Promise<{ raw: string; repaired: boolean; reason?: string }> {
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
    if (!result || result.valid || !result.fixedRaw) return { raw: opts.raw, repaired: false, reason: result?.reason }
    return { raw: result.fixedRaw, repaired: true, reason: result.reason }
  } catch {
    return { raw: opts.raw, repaired: false }
  }
}

export async function validatePrivateTurn(opts: {
  settings: AppSettings
  contact: Contact
  latestUserText: string
  raw: string
  bubbles: AiBubble[]
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string }> {
  const name = displayName(opts.contact)
  const systemPrompt = `You are a strict but lightweight roleplay response reviewer. Output JSON only: {"valid":true/false,"reason":"short","fixedRaw":"optional"}.
Judge whether the assistant reply fits the persona, answers the latest user message, avoids invented facts, and stays in a private chat.
If valid, return valid=true and omit fixedRaw.
If invalid, rewrite the reply as fixedRaw using this exact app protocol JSON: {"messages":[{"type":"text","content":"..."}],"mood":"optional"}. Keep it short and in character.`
  const userPrompt = `Persona name: ${name}
Persona: ${truncate(opts.contact.systemPrompt || '', 700)}
Relationship: ${opts.contact.relationshipBase || '朋友'} ${truncate(opts.contact.relationshipDynamic || '', 160)}
Memory/style: ${truncate(opts.contact.memoryStyle || opts.contact.memoryFacts || '', 260)}
Latest user message: ${truncate(opts.latestUserText || '(background event)', 500)}
Assistant rendered reply:
${truncate(privateBubblesText(opts.bubbles), 900)}
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

export async function validateGroupTurn(opts: {
  settings: AppSettings
  groupName: string
  speakers: Contact[]
  targetedContext: string
  raw: string
  bubbles: GroupAiBubble[]
  signal?: AbortSignal
}): Promise<{ raw: string; repaired: boolean; reason?: string }> {
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
