import { db } from '../db/db'
import type { Contact, IntentItem, IntentKind } from '../types'

export const INTENT_CONFIDENCE_THRESHOLD = 70
export const MAX_ACTIVE_INTENTS_IN_PROMPT = 2

const VALID_INTENT_KINDS = new Set<IntentKind>(['follow_up', 'care', 'avoid', 'relationship', 'topic'])

export interface ParsedIntent {
  text: string
  kind: IntentKind
  confidence: number
  expiresAt?: number
}

export function normalizeIntentKind(raw: unknown): IntentKind {
  return typeof raw === 'string' && VALID_INTENT_KINDS.has(raw as IntentKind)
    ? (raw as IntentKind)
    : 'topic'
}

export function activeIntents(contact: Pick<Contact, 'intentQueue'>, now = Date.now(), limit = MAX_ACTIVE_INTENTS_IN_PROMPT): IntentItem[] {
  return (contact.intentQueue ?? [])
    .filter((intent) => intent.status === 'active')
    .filter((intent) => !intent.expiresAt || intent.expiresAt > now)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function activeIntentPrompt(intents: IntentItem[]): string {
  if (intents.length === 0) return ''
  return [
    '你心里还记着这些未说出口的小念头:',
    ...intents.map((intent) => `- ${intent.text}`),
    '',
    '这些不是任务清单，不要生硬照念。只在自然的时候影响你的回复；如果现在不合适，可以暂时不提。',
  ].join('\n')
}

export function parseIntentsField(raw: unknown): ParsedIntent[] {
  if (!Array.isArray(raw)) return []
  const result: ParsedIntent[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    const confidence = typeof record.confidence === 'number' ? record.confidence : Number(record.confidence)
    if (!text || !Number.isFinite(confidence) || confidence < INTENT_CONFIDENCE_THRESHOLD) continue
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : undefined
    result.push({
      text: text.slice(0, 80),
      kind: normalizeIntentKind(record.kind),
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      expiresAt,
    })
  }
  return result.slice(0, 4)
}

export async function markIntentsUsed(contactId: string, intentIds: string[]): Promise<void> {
  if (intentIds.length === 0) return
  const contact = await db.contacts.get(contactId)
  if (!contact?.intentQueue?.length) return
  const ids = new Set(intentIds)
  await db.contacts.update(contactId, {
    intentQueue: contact.intentQueue.map((intent) =>
      ids.has(intent.id) && intent.status === 'active'
        ? { ...intent, status: 'used' as const }
        : intent,
    ),
  })
}

export async function clearIntentQueue(contactId: string): Promise<void> {
  await db.contacts.update(contactId, { intentQueue: [] })
}
