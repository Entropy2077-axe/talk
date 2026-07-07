import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import type { SocialEvent, SocialEventType } from '../types'

const MAX_EVENT_SUMMARY_LENGTH = 80

function uniqueContactIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => id && id !== 'user')))
}

function cleanSummary(summary: string): string {
  const oneLine = summary.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_EVENT_SUMMARY_LENGTH ? `${oneLine.slice(0, MAX_EVENT_SUMMARY_LENGTH)}...` : oneLine
}

export async function recordSocialEvent(opts: {
  type: SocialEventType
  actorId: string
  targetId?: string
  relatedContactIds: string[]
  summary: string
  conversationId?: string
  groupId?: string
  momentId?: string
  messageId?: string
  importance?: number
  createdAt?: number
}): Promise<void> {
  const relatedContactIds = uniqueContactIds(opts.relatedContactIds)
  if (relatedContactIds.length === 0) return
  const event: SocialEvent = {
    id: uuid(),
    type: opts.type,
    actorId: opts.actorId,
    targetId: opts.targetId,
    relatedContactIds,
    summary: cleanSummary(opts.summary),
    conversationId: opts.conversationId,
    groupId: opts.groupId,
    momentId: opts.momentId,
    messageId: opts.messageId,
    importance: opts.importance ?? 1,
    createdAt: opts.createdAt ?? Date.now(),
  }
  await db.socialEvents.add(event)
}

export async function recentSocialEventsText(contactIds: string[], limit = 4): Promise<string> {
  const ids = new Set(uniqueContactIds(contactIds))
  if (ids.size === 0) return ''

  return (await recentSocialEvents(contactIds, limit))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((event) => `- ${event.summary}`)
    .join('\n')
}

export async function recentSocialEvents(contactIds: string[], limit = 4): Promise<SocialEvent[]> {
  const ids = new Set(uniqueContactIds(contactIds))
  if (ids.size === 0) return []

  const events = await db.socialEvents.orderBy('createdAt').reverse().limit(80).toArray()
  return events
    .filter((event) => event.relatedContactIds.some((id) => ids.has(id)))
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
    .slice(0, limit)
}
