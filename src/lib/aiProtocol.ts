import type { AiBubble, AiResponse } from '../types'
import { normalizeMood } from './mood'

export interface ParsedAiTurn {
  bubbles: AiBubble[]
  knowledgeQueries: string[]
  mood?: string
  thought?: string
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

/**
 * Fast path for the main model's line-oriented draft. Ordinary text and the
 * explicit protocol markers are mechanical, so converting them locally avoids
 * a second model request while preserving the main model's exact wording.
 */
export function parseRawPrivateDraft(raw: string, fallbackMood?: string): ParsedAiTurn {
  const moodMatch = raw.match(/<mood>\s*([^<]+?)\s*<\/mood>/i)
  const body = raw.replace(/<mood>[\s\S]*?<\/mood>/gi, '').trim()
  const bubbles: AiBubble[] = []
  const knowledgeQueries: string[] = []
  let turnThought: string | undefined

  for (const sourceLine of body.split(/\r?\n/)) {
    let line = sourceLine.trim().replace(/^[-•]\s*/, '')
    if (!line) continue

    const thoughtMatch = line.match(/<thought>\s*([\s\S]*?)\s*<\/thought>/i)
    if (thoughtMatch?.[1]?.trim() && !turnThought) turnThought = thoughtMatch[1].trim().slice(0, 100)
    line = line.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
    if (!line) continue

    const knowledge = line.match(/^\[knowledge:([^\]]+)\]$/i)
    if (knowledge) {
      if (knowledgeQueries.length < 2) knowledgeQueries.push(knowledge[1].trim())
      continue
    }
    const sticker = line.match(/^\[sticker:([^\]]+)\]$/i)
    if (sticker) {
      bubbles.push({ type: 'sticker', name: sticker[1].trim() })
      continue
    }
    const image = line.match(/^\[image:([^:\]]+):([^\]]*)\]$/i)
    if (image) {
      bubbles.push({
        type: 'image',
        query: image[1].trim().slice(0, 100),
        caption: image[2].trim().slice(0, 100) || undefined,
      })
      continue
    }
    const finance = parseFinanceMarker(line)
    if (finance) {
      bubbles.push(finance)
      continue
    }
    bubbles.push({ type: 'text', content: line })
  }

  const mood = moodMatch?.[1]?.trim()
    ? normalizeMood(moodMatch[1])
    : fallbackMood
      ? normalizeMood(fallbackMood)
      : undefined
  return { bubbles, knowledgeQueries, mood, thought: turnThought }
}

/** Use the utility model only when the draft did not follow the local format. */
export function rawPrivateDraftNeedsUtility(raw: string, parsed: ParsedAiTurn): boolean {
  if (parsed.bubbles.length === 0) return true
  if (!/<mood>[\s\S]*?<\/mood>/i.test(raw)) return true
  const visibleLines = raw
    .replace(/<mood>[\s\S]*?<\/mood>/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean)
    .filter((line) => !/^\[knowledge:[^\]]+\]$/i.test(line))
  if (visibleLines.some((line) => !/<thought>[\s\S]*?<\/thought>/i.test(line))) return true
  return parsed.bubbles.some((bubble) => bubble.type === 'text' && /^\[[A-Za-z]+:/.test(bubble.content))
}

export function serializePrivateTurn(parsed: ParsedAiTurn): string {
  return JSON.stringify({
    messages: parsed.bubbles,
    mood: parsed.mood,
    thought: parsed.thought,
    knowledgeQueries: parsed.knowledgeQueries,
  })
}

function tryParseJson(trimmedRaw: string): ParsedAiTurn | null {
  let text = trimmedRaw
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null

  let parsed: AiResponse | undefined
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
      const im=m as unknown as Record<string,unknown>; bubbles.push({type:'image',query:String(im.query).trim().slice(0,100),caption:typeof im.caption==='string'?im.caption.slice(0,100):undefined})
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
  const location = typeof m.location === 'string' ? m.location.trim() : ''
  const activity = typeof m.activity === 'string' ? m.activity.trim() : ''
  const summary = typeof m.summary === 'string' ? m.summary.trim() : ''

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

export function typingDelayMs(bubble: AiBubble): number {
  if (bubble.type === 'text') {
    const len = bubble.content.length
    return Math.min(300 + len * 80, 3500)
  }
  if (bubble.type === 'sticker') return 500
  return 700
}
