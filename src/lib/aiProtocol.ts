import type { AiBubble, AiResponse } from '../types'
import { normalizeMood } from './mood'

export interface ParsedAiTurn {
  bubbles: AiBubble[]
  knowledgeQueries: string[]
  mood?: string
  thought?: string
  immediateActivities?: ImmediateActivityAction[]
}

export interface ImmediateActivityAction {
  locationId: string
  activity: string
  durationMinutes: number
  /** Delay before departure; omitted means the activity starts now. */
  delayMinutes?: number
  phoneAccess: 'available' | 'unavailable'
}

export function parseAiResponse(raw: string): ParsedAiTurn {
  const trimmedRaw = raw.trim()

  if (!trimmedRaw) {
    return { bubbles: [], knowledgeQueries: [], mood: undefined }
  }

  const jsonResult = tryParseJson(trimmedRaw)
  if (jsonResult) {
    return {
      bubbles: jsonResult.bubbles,
      knowledgeQueries: jsonResult.knowledgeQueries,
      mood: jsonResult.mood,
      thought: jsonResult.thought,
    }
  }

  const fallbackBubbles: AiBubble[] = trimmedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content) => ({ type: 'text', content }))
  return { bubbles: fallbackBubbles, knowledgeQueries: [], mood: undefined }
}

/**
 * Reads only a complete structured chat reply. Unlike parseAiResponse(), this
 * never falls back to treating arbitrary lines as user-visible text. It is
 * used for providers that sometimes ignore the raw-text draft instruction and
 * return the final messages JSON directly.
 */
export function parseStructuredAiResponse(raw: string): ParsedAiTurn | null {
  const trimmedRaw = raw.trim()
  return trimmedRaw ? tryParseJson(trimmedRaw) : null
}

/** True when a reply looks like an attempted final chat protocol payload. */
export function looksLikeStructuredAiResponse(raw: string): boolean {
  if (parseStructuredAiResponse(raw)) return true
  // Keep malformed payloads behind the custom-provider safety gate too. The
  // leading prose is intentional: some compatible services prepend a short
  // explanation before the JSON object.
  return /\{[\s\S]{0,240}["']messages["']\s*:/.test(raw)
}

export function parseKnowledgeQueriesField(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const q of raw) {
    if (typeof q === 'string' && q.trim()) result.push(q.trim())
    if (result.length >= 2) break
  }
  return result
}

function parseFinanceMarker(line: string): AiBubble | null {
  let match = line.match(/^\[transfer:(\d+):([^\]]+)\]$/i)
  if (match) return { type: 'transfer', amount: Number(match[1]), note: match[2].trim().slice(0, 80) }
  match = line.match(/^\[redPacket:(\d+):([^\]]+)\]$/i)
  if (match) return { type: 'redPacket', amount: Number(match[1]), note: match[2].trim().slice(0, 80) }
  match = line.match(/^\[loanRequest:(\d+):([^\]]+)\]$/i)
  if (match) return { type: 'loanRequest', amount: Number(match[1]), note: match[2].trim().slice(0, 80) }
  match = line.match(/^\[loanDecision:([^:\]]+):(accept|reject):(\d+)\]$/i)
  if (match) {
    return {
      type: 'loanDecision',
      loanId: match[1].trim(),
      decision: match[2].toLowerCase() as 'accept' | 'reject',
      amount: Number(match[3]),
    }
  }
  match = line.match(/^\[giftPurchase:(\d+):([^:\]]+):([^:\]]+):([^\]]+)\]$/i)
  if (match) {
    return {
      type: 'giftPurchase',
      amount: Number(match[1]),
      name: match[2].trim().slice(0, 30),
      icon: match[3].trim().slice(0, 8),
      description: match[4].trim().slice(0, 80),
    }
  }
  return null
}

/** Mechanical only: this parser never infers missing appointment fields. */
export function parseScheduleMarker(line: string): Extract<AiBubble, { type: 'scheduleChange' }> | null {
  const match = line.match(/^\[schedule:([^\]]+)\]$/i)
  if (!match) return null
  const fields = Object.fromEntries(match[1].split(';').map((entry) => {
    const pivot = entry.indexOf('=')
    return pivot > 0 ? [entry.slice(0, pivot).trim(), entry.slice(pivot + 1).trim()] : []
  })) as Record<string, string>
  const startHour = Number(fields.startHour)
  const endHour = Number(fields.endHour)
  const phoneAccess = fields.phoneAccess
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date || '') || !Number.isInteger(startHour) || !Number.isInteger(endHour)
    || startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour === endHour
    || (phoneAccess !== 'available' && phoneAccess !== 'unavailable') || !fields.locationId || !fields.activity || !fields.summary) return null
  // location is resolved from the local map before the record is persisted.
  return { type: 'scheduleChange', date: fields.date, startHour, endHour, phoneAccess, location: fields.locationId, locationId: fields.locationId, activity: fields.activity.slice(0, 16), summary: fields.summary.slice(0, 40) }
}

/**
 * Fast path for the main model's line-oriented draft. Ordinary text and the
 * explicit protocol markers are mechanical, so converting them locally avoids
 * a second model request while preserving the main model's exact wording.
 */
export function parseRawPrivateDraft(raw: string, fallbackMood?: string): ParsedAiTurn {
  const bubbles: AiBubble[] = []
  const knowledgeQueries: string[] = []
  let turnThought: string | undefined
  let turnMood: string | undefined

  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line) continue
    // Private and group drafts share per-line thought/mood metadata. Private
    // chat omits only the speaker-name prefix.
    const match = line.match(/^（([^（）]+)）\[([^\[\]]+)\]“([\s\S]+)”$/)
    if (!match) continue
    const thought = match[1].trim().slice(0, 100)
    const mood = match[2].trim().slice(0, 10)
    const content = match[3].trim()
    if (!thought || !mood || !content) continue
    if (!turnThought) turnThought = thought
    if (!turnMood) turnMood = normalizeMood(mood)

    const knowledge = content.match(/^\[knowledge:([^\]]+)\]$/i)
    if (knowledge) {
      if (knowledgeQueries.length < 2) knowledgeQueries.push(knowledge[1].trim())
      continue
    }
    const sticker = content.match(/^\[sticker:([^\]]+)\]$/i)
    if (sticker) {
      bubbles.push({ type: 'sticker', name: sticker[1].trim() })
      continue
    }
    const image = content.match(/^\[image:([^:\]]+):([^\]]*)\]$/i)
    if (image) {
      bubbles.push({
        type: 'image',
        query: image[1].trim().slice(0, 2_000),
        caption: image[2].trim().slice(0, 200) || undefined,
      })
      continue
    }
    const finance = parseFinanceMarker(content)
    if (finance) {
      bubbles.push(finance)
      continue
    }
    const schedule = parseScheduleMarker(content)
    if (schedule) {
      bubbles.push(schedule)
      continue
    }
    bubbles.push({ type: 'text', content })
  }

  const mood = turnMood
    ? turnMood
    : fallbackMood
      ? normalizeMood(fallbackMood)
      : undefined
  return { bubbles, knowledgeQueries, mood, thought: turnThought }
}

/** Use the utility model only when the draft did not follow the local format. */
export function rawPrivateDraftNeedsUtility(raw: string, parsed: ParsedAiTurn): boolean {
  if (parsed.bubbles.length === 0) return true
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.some((line) => !/^（[^（）]+）\[[^\[\]]+\]“[\s\S]+”$/.test(line))) return true
  return parsed.bubbles.some((bubble) => bubble.type === 'text' && /^\[[A-Za-z]+:/.test(bubble.content))
}

export function serializePrivateTurn(parsed: ParsedAiTurn): string {
  return JSON.stringify({
    messages: parsed.bubbles,
    mood: parsed.mood,
    thought: parsed.thought,
    knowledgeQueries: parsed.knowledgeQueries,
    ...(parsed.immediateActivities?.length ? { immediateActivities: parsed.immediateActivities } : {}),
  })
}

function tryParseJson(trimmedRaw: string): ParsedAiTurn | null {
  const parsed = parseJsonLoose<AiResponse>(trimmedRaw)
  if (!parsed || !Array.isArray(parsed.messages)) return null

  const bubbles: AiBubble[] = []
  for (const m of parsed.messages) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'text') {
      const content = parseTextBubbleContent(m as unknown as Record<string, unknown>)
      if (content) bubbles.push({ type: 'text', content })
    } else if (m.type === 'sticker' && typeof m.name === 'string' && m.name.trim()) {
      bubbles.push({ type: 'sticker', name: m.name.trim() })
    } else if (m.type === 'link' && typeof m.app === 'string' && typeof m.label === 'string') {
      bubbles.push({ type: 'link', app: m.app, label: m.label, data: m.data })
    } else if (m.type === 'image' && typeof (m as unknown as Record<string,unknown>).query === 'string') {
      const im=m as unknown as Record<string,unknown>
      const kind = ['selfie','portrait','group','scene','object'].includes(String(im.kind)) ? im.kind as import('../types').AiImageKind : undefined
      const participants = Array.isArray(im.participants) ? im.participants.filter((value): value is 'self'|'user' => value === 'self' || value === 'user') : undefined
      bubbles.push({type:'image',query:String(im.query).trim().slice(0,2_000),scene:typeof im.scene==='string'?im.scene.trim().slice(0,2_000):undefined,kind,participants,caption:typeof im.caption==='string'?im.caption.slice(0,200):undefined})
    } else if (m.type === 'scheduleChange') {
      const scheduleChange = parseScheduleChangeBubble(m as unknown as Record<string, unknown>)
      if (scheduleChange) bubbles.push(scheduleChange)
    } else if (['transfer','redPacket','loanRequest','loanDecision','giftPurchase'].includes(String(m.type))) {
      const fm = m as unknown as Record<string, unknown>
      const amount = Math.round(Number(fm.amount))
      if (Number.isFinite(amount) && amount > 0) bubbles.push({ type: m.type as 'transfer'|'redPacket'|'loanRequest'|'loanDecision'|'giftPurchase', amount, note: typeof fm.note === 'string' ? String(fm.note).slice(0,80) : undefined, loanId: typeof fm.loanId === 'string' ? String(fm.loanId) : undefined, decision: fm.decision === 'accept' ? 'accept' : fm.decision === 'reject' ? 'reject' : undefined, name: typeof fm.name === 'string' ? String(fm.name).slice(0,30) : undefined, icon: typeof fm.icon === 'string' ? String(fm.icon).slice(0,8) : undefined, description: typeof fm.description === 'string' ? String(fm.description).slice(0,80) : undefined })
    }
  }
  const mood = typeof parsed.mood === 'string' && parsed.mood.trim() ? normalizeMood(parsed.mood) : undefined
  const thought = typeof parsed.thought === 'string' && parsed.thought.trim() ? parsed.thought.trim().slice(0, 100) : undefined
  return { bubbles, knowledgeQueries: parseKnowledgeQueriesField(parsed.knowledgeQueries), mood, thought }
}

function parseTextBubbleContent(m: Record<string, unknown>): string {
  const content = typeof m.content === 'string' ? m.content : typeof m.text === 'string' ? m.text : ''
  return content.trim()
}

function parseScheduleChangeBubble(m: Record<string, unknown>): AiBubble | null {
  const date = typeof m.date === 'string' ? m.date : ''
  const startHour = typeof m.startHour === 'number' ? m.startHour : Number(m.startHour)
  const endHour = typeof m.endHour === 'number' ? m.endHour : Number(m.endHour)
  const phoneAccess = m.phoneAccess
  const location = typeof m.location === 'string' ? m.location.trim().slice(0, 20) : ''
  const activity = typeof m.activity === 'string' ? m.activity.trim().slice(0, 16) : ''
  const summary = typeof m.summary === 'string' ? m.summary.trim().slice(0, 40) : ''

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null
  if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour === endHour) return null
  if (phoneAccess !== 'available' && phoneAccess !== 'unavailable') return null
  if (!location || !activity || !summary) return null

  return { type: 'scheduleChange', date, startHour, endHour, phoneAccess, location, activity, summary }
}

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Loose JSON parse for LLM replies: strips an optional ```json code fence, tries JSON.parse,
 * and on failure falls back to extractJsonObject (balanced-brace scan) before giving up.
 * Returns null instead of throwing. This is the single shared helper for the fence+parse+extract
 * three-step that was previously copy-pasted across a dozen parse sites.
 */
export function parseJsonLoose<T = unknown>(raw: string): T | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    const extracted = extractJsonObject(text)
    if (!extracted) return null
    try {
      return JSON.parse(extracted) as T
    } catch {
      return null
    }
  }
}

export function typingDelayMs(bubble: AiBubble): number {
  if (bubble.type === 'text') {
    const len = bubble.content.length
    return Math.min(300 + len * 80, 3500)
  }
  if (bubble.type === 'sticker') return 500
  return 700
}
