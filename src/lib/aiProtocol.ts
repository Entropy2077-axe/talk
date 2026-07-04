import type { AiBubble, AiResponse } from '../types'

/**
 * Parses the model's JSON reply into bubbles. Returns an empty array
 * whenever nothing usable could be extracted (empty/blank response,
 * malformed JSON, missing `messages`, or every entry filtered out) —
 * callers must treat `[]` as "no reply" and surface that explicitly,
 * never fall back to displaying raw/empty text as a bubble.
 */
export function parseAiResponse(raw: string): AiBubble[] {
  const trimmedRaw = raw.trim()
  if (!trimmedRaw) return []

  let text = trimmedRaw
  // strip ```json ... ``` fences if the model added them despite instructions
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return []

  let parsed: AiResponse
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  if (!parsed || !Array.isArray(parsed.messages)) return []

  const bubbles: AiBubble[] = []
  for (const m of parsed.messages) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'text' && typeof m.content === 'string' && m.content.trim()) {
      bubbles.push({ type: 'text', content: m.content.trim() })
    } else if (m.type === 'sticker' && typeof m.name === 'string' && m.name.trim()) {
      bubbles.push({ type: 'sticker', name: m.name.trim() })
    } else if (m.type === 'link' && typeof m.app === 'string' && typeof m.label === 'string') {
      bubbles.push({ type: 'link', app: m.app, label: m.label, data: m.data })
    } else if (m.type === 'location' && typeof m.locationId === 'string' && typeof m.label === 'string') {
      bubbles.push({ type: 'location', locationId: m.locationId, label: m.label })
    } else if (
      m.type === 'schedule_task' &&
      typeof m.date === 'string' &&
      typeof m.startTime === 'string' &&
      typeof m.endTime === 'string' &&
      typeof m.locationId === 'string' &&
      typeof m.label === 'string'
    ) {
      bubbles.push({
        type: 'schedule_task',
        date: m.date,
        startTime: m.startTime,
        endTime: m.endTime,
        locationId: m.locationId,
        label: m.label,
      })
    }
  }
  return bubbles
}

/** Simulated typing delay before a bubble appears, based on its own content length. */
export function typingDelayMs(bubble: AiBubble): number {
  if (bubble.type === 'text') {
    const len = bubble.content.length
    return Math.min(300 + len * 80, 3500)
  }
  if (bubble.type === 'sticker') return 500
  return 700
}
