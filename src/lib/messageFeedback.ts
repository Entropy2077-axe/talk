import { db } from '../db/db'
import { recordSocialEvent } from './socialEvents'
import type { Contact, Message } from '../types'

const MAX_MEMORY_STYLE_LENGTH = 500
const MAX_FEEDBACK_LINES = 4
const FEEDBACK_PREFIX = '用户反馈:'

function feedbackLine(kind: 'unlike' | 'avoid', message: Message): string {
  const excerpt = message.content.trim().slice(0, 40)
  if (kind === 'unlike') return `${FEEDBACK_PREFIX} 不像TA: "${excerpt}" 贴近人设和样例。`
  return `${FEEDBACK_PREFIX} 避免: "${excerpt}" 这种说法或语气。`
}

function appendMemoryStyle(existing: string, line: string): string {
  const lines = existing
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
  const ordinary = lines.filter((item) => !item.startsWith(FEEDBACK_PREFIX)).join('\n')
  const feedbackLines = [...lines.filter((item) => item.startsWith(FEEDBACK_PREFIX)), line]
  const dedupedFeedback = Array.from(new Map(feedbackLines.map((item) => [item, item])).values()).slice(
    -MAX_FEEDBACK_LINES,
  )
  const feedbackText = dedupedFeedback.join('\n')
  if (!ordinary) return feedbackText.slice(-MAX_MEMORY_STYLE_LENGTH)

  const separatorLength = feedbackText ? 1 : 0
  const ordinaryBudget = MAX_MEMORY_STYLE_LENGTH - feedbackText.length - separatorLength
  if (ordinaryBudget <= 0) return feedbackText.slice(-MAX_MEMORY_STYLE_LENGTH)

  const trimmedOrdinary =
    ordinary.length > ordinaryBudget ? ordinary.slice(ordinary.length - ordinaryBudget).trimStart() : ordinary
  return [trimmedOrdinary, feedbackText].filter(Boolean).join('\n')
}

export async function applyMessageFeedback(opts: {
  contact: Contact
  message: Message
  kind: 'unlike' | 'avoid'
  conversationId: string
}): Promise<void> {
  const line = feedbackLine(opts.kind, opts.message)
  const fresh = await db.contacts.get(opts.contact.id)
  if (!fresh) return
  await db.contacts.update(opts.contact.id, {
    memoryStyle: appendMemoryStyle(fresh.memoryStyle || '', line),
    memoryUpdatedAt: Date.now(),
  })
  await recordSocialEvent({
    type: 'message_feedback',
    actorId: 'user',
    targetId: opts.contact.id,
    relatedContactIds: [opts.contact.id],
    conversationId: opts.conversationId,
    messageId: opts.message.id,
    summary: line,
    importance: 3,
  })
}
