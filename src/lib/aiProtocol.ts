import type { AiBubble, AiResponse } from '../types'

export interface ParsedAiTurn {
  bubbles: AiBubble[]
  knowledgeQueries: string[]
}

export interface AiResponseQualityRecord {
  id: string
  timestamp: number
  jsonParseSuccess: boolean
  fallbackLineCount: number
  commissionLeakHits: number
  rewardNaNFallbacks: number
}

export interface AiResponseQualityStats {
  windowSize: number
  total: number
  jsonParseSuccess: number
  fallbackLineParses: number
  commissionLeakHits: number
  rewardNaNFallbacks: number
  jsonSuccessRate: number
}

const QUALITY_STORAGE_KEY = 'talk-ai-response-quality'
const QUALITY_EVENT = 'talk-ai-response-quality-updated'
const QUALITY_WINDOW_SIZE = 50
const MIN_COMMISSION_REWARD = 10
const MAX_COMMISSION_REWARD = 200

const COMMISSION_LEAK_PATTERNS = [
  /^\[发布了委托[:：]\s*(.+?)\s*\]$/,
  /^\[[^\]]*委托[:：]\s*(.+?)\s*\]$/,
  /^\[[^\]]*鎵[^\]]*[:：]\s*(.+?)\s*\]$/,
]

export function parseAiResponse(raw: string): ParsedAiTurn {
  const trimmedRaw = raw.trim()
  const counters = { commissionLeakHits: 0, rewardNaNFallbacks: 0 }

  if (!trimmedRaw) {
    recordAiResponseQuality({ jsonParseSuccess: false, fallbackLineCount: 0, commissionLeakHits: 0, rewardNaNFallbacks: 0 })
    return { bubbles: [], knowledgeQueries: [] }
  }

  const jsonResult = tryParseJson(trimmedRaw, counters)
  if (jsonResult && jsonResult.bubbles.length > 0) {
    const bubbles = recoverLeakedBubbles(jsonResult.bubbles, counters)
    recordAiResponseQuality({
      jsonParseSuccess: true,
      fallbackLineCount: 0,
      commissionLeakHits: counters.commissionLeakHits,
      rewardNaNFallbacks: counters.rewardNaNFallbacks,
    })
    return { bubbles, knowledgeQueries: jsonResult.knowledgeQueries }
  }

  const fallbackBubbles: AiBubble[] = trimmedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content) => ({ type: 'text', content }))
  const bubbles = recoverLeakedBubbles(fallbackBubbles, counters)
  recordAiResponseQuality({
    jsonParseSuccess: false,
    fallbackLineCount: fallbackBubbles.length,
    commissionLeakHits: counters.commissionLeakHits,
    rewardNaNFallbacks: counters.rewardNaNFallbacks,
  })
  return { bubbles, knowledgeQueries: [] }
}

function recoverLeakedBubbles(
  bubbles: AiBubble[],
  counters: { commissionLeakHits: number },
): AiBubble[] {
  return bubbles.map((b): AiBubble => {
    if (b.type !== 'text') return b
    const match = COMMISSION_LEAK_PATTERNS.map((pattern) => b.content.match(pattern)).find(Boolean)
    if (!match) return b
    counters.commissionLeakHits++
    const title = match[1].trim()
    return { type: 'commission', title, description: title, reward: clampReward(NaN) }
  })
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

function tryParseJson(
  trimmedRaw: string,
  counters: { rewardNaNFallbacks: number },
): { bubbles: AiBubble[]; knowledgeQueries: string[] } | null {
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
    } else if (m.type === 'commission' && typeof m.title === 'string' && m.title.trim() && typeof m.description === 'string') {
      const rewardNum = typeof m.reward === 'number' ? m.reward : Number(m.reward)
      if (!Number.isFinite(rewardNum)) counters.rewardNaNFallbacks++
      bubbles.push({
        type: 'commission',
        title: m.title.trim(),
        description: m.description.trim(),
        reward: clampReward(rewardNum),
      })
    } else if (m.type === 'scheduleChange') {
      const scheduleChange = parseScheduleChangeBubble(m as unknown as Record<string, unknown>)
      if (scheduleChange) bubbles.push(scheduleChange)
    }
  }
  return { bubbles, knowledgeQueries: parseKnowledgeQueriesField(parsed.knowledgeQueries) }
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

function clampReward(reward: number): number {
  if (!Number.isFinite(reward)) return MIN_COMMISSION_REWARD
  return Math.round(Math.min(MAX_COMMISSION_REWARD, Math.max(MIN_COMMISSION_REWARD, reward)))
}

function recordAiResponseQuality(record: Omit<AiResponseQualityRecord, 'id' | 'timestamp'>): void {
  if (typeof window === 'undefined') return
  const records = readAiResponseQualityRecords()
  const next = [
    ...records,
    {
      ...record,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
    },
  ].slice(-QUALITY_WINDOW_SIZE)
  window.localStorage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(QUALITY_EVENT))
}

export function readAiResponseQualityRecords(): AiResponseQualityRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(QUALITY_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is AiResponseQualityRecord => {
      if (!item || typeof item !== 'object') return false
      const r = item as Record<string, unknown>
      return (
        typeof r.id === 'string' &&
        typeof r.timestamp === 'number' &&
        typeof r.jsonParseSuccess === 'boolean' &&
        typeof r.fallbackLineCount === 'number' &&
        typeof r.commissionLeakHits === 'number' &&
        typeof r.rewardNaNFallbacks === 'number'
      )
    })
  } catch {
    return []
  }
}

export function getAiResponseQualityStats(records = readAiResponseQualityRecords()): AiResponseQualityStats {
  const total = records.length
  const jsonParseSuccess = records.filter((r) => r.jsonParseSuccess).length
  const fallbackLineParses = records.reduce((sum, r) => sum + r.fallbackLineCount, 0)
  const commissionLeakHits = records.reduce((sum, r) => sum + r.commissionLeakHits, 0)
  const rewardNaNFallbacks = records.reduce((sum, r) => sum + r.rewardNaNFallbacks, 0)
  return {
    windowSize: QUALITY_WINDOW_SIZE,
    total,
    jsonParseSuccess,
    fallbackLineParses,
    commissionLeakHits,
    rewardNaNFallbacks,
    jsonSuccessRate: total === 0 ? 0 : jsonParseSuccess / total,
  }
}

export function subscribeAiResponseQuality(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(QUALITY_EVENT, listener)
  return () => window.removeEventListener(QUALITY_EVENT, listener)
}

export function typingDelayMs(bubble: AiBubble): number {
  if (bubble.type === 'text') {
    const len = bubble.content.length
    return Math.min(300 + len * 80, 3500)
  }
  if (bubble.type === 'sticker') return 500
  return 700
}
