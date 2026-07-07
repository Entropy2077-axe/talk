import type { AiBubble, AiResponse } from '../types'

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
  if (jsonResult && jsonResult.bubbles.length > 0) {
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
    if (m.type === 'text' && typeof m.content === 'string' && m.content.trim()) {
      bubbles.push({ type: 'text', content: m.content.trim() })
    } else if (m.type === 'sticker' && typeof m.name === 'string' && m.name.trim()) {
      bubbles.push({ type: 'sticker', name: m.name.trim() })
    } else if (m.type === 'link' && typeof m.app === 'string' && typeof m.label === 'string') {
      bubbles.push({ type: 'link', app: m.app, label: m.label, data: m.data })
    } else if (m.type === 'scheduleChange') {
      const scheduleChange = parseScheduleChangeBubble(m as unknown as Record<string, unknown>)
      if (scheduleChange) bubbles.push(scheduleChange)
    }
  }
  const mood = typeof parsed.mood === 'string' && parsed.mood.trim() ? parsed.mood.trim().slice(0, 20) : undefined
  const thought = typeof parsed.thought === 'string' && parsed.thought.trim() ? parsed.thought.trim().slice(0, 100) : undefined
  return { bubbles, knowledgeQueries: parseKnowledgeQueriesField(parsed.knowledgeQueries), mood, thought }
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
