import type { AiBubble, AiResponse } from '../types'

/**
 * Parses the model's reply into bubbles. The model is instructed to reply
 * with pure JSON, but empirically (verified against the live API) it does
 * not always comply on the 2nd+ turn of a conversation even with a
 * carefully ordered prompt — this is a model-compliance limitation, not
 * just our formatting. When JSON parsing fails but the model still wrote
 * something real, we fall back to treating each non-empty line as its own
 * text bubble (the same "one bubble per short line" shape a compliant JSON
 * reply would have produced) rather than discarding a genuine reply.
 * Returns an empty array only when there is truly nothing to show (blank
 * response) — callers must treat `[]` as "no reply".
 */
export function parseAiResponse(raw: string): AiBubble[] {
  const trimmedRaw = raw.trim()
  if (!trimmedRaw) return []

  const jsonBubbles = tryParseJson(trimmedRaw)
  if (jsonBubbles && jsonBubbles.length > 0) return jsonBubbles

  return trimmedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((content) => ({ type: 'text', content }))
}

function tryParseJson(trimmedRaw: string): AiBubble[] | null {
  let text = trimmedRaw
  // strip ```json ... ``` fences if the model added them despite instructions
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text) return null

  let parsed: AiResponse | undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    // The model sometimes wraps the JSON in a bit of chit-chat before or
    // after it despite instructions not to (e.g. "好的\n{...}" or a trailing
    // remark) — that breaks a strict whole-string parse even though a
    // perfectly valid JSON object is sitting in there. Scan for a balanced
    // {...} object anywhere in the text and try that before giving up.
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
      // reward is occasionally handed back as a numeric string ("30")
      // rather than a JSON number — coerce rather than reject the whole
      // commission over it.
      const rewardNum = typeof m.reward === 'number' ? m.reward : Number(m.reward)
      if (Number.isFinite(rewardNum)) {
        bubbles.push({
          type: 'commission',
          title: m.title.trim(),
          description: m.description.trim(),
          reward: clampReward(rewardNum),
        })
      }
    }
  }
  return bubbles
}

/** Finds the first balanced {...} object in `text`, respecting quoted strings, and returns it as a substring. */
function extractJsonObject(text: string): string | null {
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

// Keeps the AI from handing out (or lowballing) wildly unbalanced rewards.
const MIN_COMMISSION_REWARD = 10
const MAX_COMMISSION_REWARD = 200
function clampReward(reward: number): number {
  if (!Number.isFinite(reward)) return MIN_COMMISSION_REWARD
  return Math.round(Math.min(MAX_COMMISSION_REWARD, Math.max(MIN_COMMISSION_REWARD, reward)))
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
